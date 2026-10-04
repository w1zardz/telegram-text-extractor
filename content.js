/* Telegram Text Extractor — content script (Telegram Web K / A)
 *
 * Supports web.telegram.org/k/ and /a/. K's DOM contract: every post
 * bubble is `.bubble[data-mid]` with `data-timestamp`, the text lives in
 * `.translatable-message`, reply previews are wrapped in `.reply`, date
 * dividers are `.bubbles-date-group__title`.
 *
 * v1.1: Telegram virtualises the history — bubbles scrolled far away are
 * removed from the DOM. So instead of reading "what is visible now" we
 * keep an accumulating per-chat store (persisted in chrome.storage.local)
 * and add an auto-scroll harvester that walks the history on its own.
 * A selectors follow Ajaxy/telegram-tt, commit 28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80:
 * `.Message[data-message-id]`, `.text-content`, `.message-date-group`,
 * `.sticky-date`, `.MessageMeta`, `.message-time`, `.MessageList.custom-scroll`.
 * Neither adapter reads Telegram account/session storage or internal APIs.
 */

(function () {
    'use strict';

    if (window.__tgeLoaded) return;
    window.__tgeLoaded = true;

    const VERSION = '1.1.1';
    const RENDER_LIMIT = 400;          // DOM items in the panel; export always takes everything
    const onK = () => location.pathname.startsWith('/k/');
    const onA = () => location.pathname.startsWith('/a/');
    const supported = () => onK() || onA();
    const MESSAGE_ID_OFFSET = 0x100000000;
    const messageSelector = () => onA()
        ? '.Message[data-message-id], .Message[id^="message-"]'
        : '.bubble[data-mid]';
    const isRendered = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const aMessageList = () => [...document.querySelectorAll('.MessageList.custom-scroll')]
        .find(isRendered) || null;
    const kMessageList = () => [...document.querySelectorAll('.bubbles .bubbles-scrollable, .bubbles .scrollable-y')]
        .find(isRendered) || [...document.querySelectorAll('.bubbles')].find(isRendered) || null;
    const historyRoot = () => onA() ? aMessageList() : kMessageList();
    const historyMessages = () => [...(historyRoot()?.querySelectorAll(messageSelector()) || [])]
        .filter(el => isRendered(el) && !el.closest('.bubbles-remover'));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    /* ==========================================================
       Stop copy/cut/Ctrl+C events from inside our panel from
       reaching Telegram's "copying is disabled" listener.
       ========================================================== */
    const isFromOurUI = (e) => {
        const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
        for (const el of path) {
            if (!el || !el.id) continue;
            if (el.id === 'tge-panel' || el.id === 'tge-toggle') return true;
        }
        return false;
    };
    const swallow = (e) => {
        if (isFromOurUI(e)) {
            e.stopImmediatePropagation();
            e.stopPropagation();
        }
    };
    document.addEventListener('copy',  swallow, true);
    document.addEventListener('cut',   swallow, true);
    document.addEventListener('paste', swallow, true);
    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const k = (e.key || '').toLowerCase();
        if (k !== 'c' && k !== 'v' && k !== 'x' && k !== 'a') return;
        if (isFromOurUI(e)) e.stopImmediatePropagation();
    }, true);
    document.addEventListener('contextmenu', (e) => {
        if (isFromOurUI(e)) e.stopImmediatePropagation();
    }, true);

    /* ==========================================================
       UI build
       ========================================================== */
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'tge-toggle';
    toggleBtn.textContent = '📋';
    toggleBtn.title = 'Telegram Text Extractor';
    document.body.appendChild(toggleBtn);

    const panel = document.createElement('div');
    panel.id = 'tge-panel';
    panel.innerHTML = `
        <div class="tge-header">
            <span class="tge-title">📋 <span id="tge-count">0</span> <span class="tge-sub" id="tge-total"></span></span>
            <div class="tge-actions">
                <button id="tge-refresh" title="Scan visible posts">↻</button>
                <div class="tge-copy-wrap">
                    <button id="tge-copy-all" class="primary" title="Copy filtered posts">Copy</button>
                    <button id="tge-copy-menu-btn" class="primary" title="Copy by day">▾</button>
                    <div class="tge-copy-menu" id="tge-copy-menu" hidden></div>
                </div>
                <button id="tge-export" title="Export filtered to .txt">⬇ .txt</button>
                <button id="tge-export-json" title="Export filtered to .json (mid, date, text, source URL, links)">⬇ .json</button>
                <button id="tge-close" title="Close">✕</button>
            </div>
        </div>
        <div class="tge-harvest">
            <button id="tge-auto" class="primary" title="Scroll older history automatically and keep rendered posts">▲ Auto-collect</button>
            <label title="Stop when posts older than this date are reached (empty = no date cutoff)">
                until <input type="date" id="tge-until">
            </label>
            <button id="tge-clear" title="Forget everything collected for this chat">🗑</button>
            <span class="tge-status" id="tge-status"></span>
        </div>
        <div class="tge-tools">
            <input type="search" id="tge-search" placeholder="Search…">
            <label title="Hide posts shorter than N characters">min <input type="number" id="tge-min" min="0" step="10" value="0"></label>
            <label title="Hide posts whose text repeats an earlier one"><input type="checkbox" id="tge-dedupe" checked> dedupe</label>
        </div>
        <div class="tge-filters" id="tge-filters"></div>
        <div class="tge-list" id="tge-list">
            <div class="tge-empty">
                Open a channel or chat and press <b>▲ Auto-collect</b>,<br>
                or scroll manually — every post you pass is kept.
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    const $ = (sel) => panel.querySelector(sel);
    const $list        = $('#tge-list');
    const $count       = $('#tge-count');
    const $total       = $('#tge-total');
    const $filters     = $('#tge-filters');
    const $refresh     = $('#tge-refresh');
    const $copyAll     = $('#tge-copy-all');
    const $copyMenuBtn = $('#tge-copy-menu-btn');
    const $copyMenu    = $('#tge-copy-menu');
    const $export      = $('#tge-export');
    const $exportJson  = $('#tge-export-json');
    const $close       = $('#tge-close');
    const $auto        = $('#tge-auto');
    const $until       = $('#tge-until');
    const $clear       = $('#tge-clear');
    const $status      = $('#tge-status');
    const $search      = $('#tge-search');
    const $min         = $('#tge-min');
    const $dedupe      = $('#tge-dedupe');

    /* ==========================================================
       DOM noise outside the original message text
       ========================================================== */
    const STRIP_BEFORE_TEXT = [
        '.reply', '.bubble-reply', '.RepliedMessage',
        '.web-page-preview', '.web-page', '.preview', '.embed',
        '.forward-name', '.attribution',
        '.message-comments-wrapper', '.message-comments', '.bubble-comments',
        '.reactions', '.reactions-element',
        '.time', '.time-inner', '.post-views', '.message-views',
        '.MessageMeta', '.Reactions', '.translation-animation',
        '.bubble-controls', '.show-more', '.show-more-button', '.translation-button',
        '.RippleEffect', '.ripple-container',
        'audio', 'video', 'source', 'img', 'button', '.btn-icon'
    ].join(',');

    /* ==========================================================
       Store: chatKey -> Map<mid, post>, persisted per chat
       ========================================================== */
    const store = new Map();
    let loadedKeys = new Set();
    let saveTimer = 0;

    const chatKey = () => {
        const h = (location.hash || '').replace(/^#/, '').split(/[?&]/)[0];
        return h || '';
    };
    const storageKey = (k) => `tge:${k}`;
    const hasStorage = () => !!(chrome && chrome.storage && chrome.storage.local);

    function bucket(k = chatKey()) {
        if (!store.has(k)) store.set(k, new Map());
        return store.get(k);
    }

    async function loadChat(k = chatKey()) {
        if (!k || loadedKeys.has(k)) return;
        loadedKeys.add(k);
        if (!hasStorage()) return;
        try {
            const res = await chrome.storage.local.get(storageKey(k));
            const arr = res[storageKey(k)];
            if (!Array.isArray(arr)) return;
            const b = bucket(k);
            for (const p of arr) {
                if (!p || !p.mid) continue;
                // K channel IDs in v1.1.0 were saved with the client's 2^32 offset.
                const mid = onK() ? serverMid(p.mid) : Number(p.mid);
                if (!mid) continue;
                const migrated = {
                    ...p, mid, dom_mid: p.dom_mid || p.mid,
                    source_url: p.source_url || sourceUrl(mid, p.dom_mid || p.mid, k),
                    links: p.links || [], forwarded: p.forwarded ?? null
                };
                if (!b.has(mid) || b.get(mid).text.length < migrated.text.length) b.set(mid, migrated);
            }
        } catch (_) {}
    }

    function scheduleSave(k = chatKey()) {
        if (!k || !hasStorage()) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            try {
                const arr = [...bucket(k).values()];
                await chrome.storage.local.set({ [storageKey(k)]: arr });
            } catch (_) {}
        }, 800);
    }

    async function clearChat(k = chatKey()) {
        bucket(k).clear();
        if (hasStorage()) {
            try { await chrome.storage.local.remove(storageKey(k)); } catch (_) {}
        }
    }

    /* ==========================================================
       Extraction
       ========================================================== */
    function extractText(bubble) {
        const clone = bubble.cloneNode(true);
        // Web A renders unsupported native emoji as img.emoji with the literal alt.
        clone.querySelectorAll('img.emoji[alt]').forEach(img => img.replaceWith(img.alt));
        clone.querySelectorAll(STRIP_BEFORE_TEXT).forEach(n => n.remove());

        let textEl = onA() ? clone.querySelector('.text-content') : clone.querySelector('.translatable-message');
        if (!textEl && onK()) textEl = clone.querySelector('.text-content') || clone;
        if (!textEl) return '';
        // Detached clones have no layout: innerText otherwise joins <br> lines.
        textEl.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

        let txt = (textEl.innerText || textEl.textContent || '')
            .replace(/ /g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        txt = txt.replace(/[\s·…]+(Show\s+more|Развернуть|Показать\s+ещё|Показать\s+полностью)\.?$/i, '').trim();
        txt = txt.replace(/\s*\d+\s+(Comments?|комментари[йяев]+)\s*$/i, '').trim();
        return txt;
    }

    function extractTime(bubble) {
        const inner = bubble.querySelector(onA() ? '.message-time' : '.time-inner, .time');
        if (!inner) return '';
        const m = (inner.innerText || inner.textContent || '').match(/\b\d{1,2}:\d{2}(?:\s*[AP]M)?\b/i);
        return m ? m[0] : '';
    }

    function serverMid(value) {
        const raw = String(value || '');
        if (!/^\d+$/.test(raw)) return 0;
        const n = Number(raw);
        if (!Number.isSafeInteger(n) || n <= 0 || n >= MESSAGE_ID_OFFSET * 2) return 0;
        return n > MESSAGE_ID_OFFSET ? n - MESSAGE_ID_OFFSET : n === MESSAGE_ID_OFFSET ? 0 : n;
    }

    function extractDomMid(bubble) {
        if (onK()) return bubble.dataset.mid || '';
        return bubble.dataset.messageId || (/^message-(\d+)$/.exec(bubble.id || '') || [])[1] || '';
    }

    function extractMid(bubble) {
        return onK() ? serverMid(extractDomMid(bubble)) : (() => {
            const raw = extractDomMid(bubble);
            const n = /^\d+$/.test(raw) ? Number(raw) : 0;
            return Number.isSafeInteger(n) && n > 0 ? n : 0;
        })();
    }

    function extractTs(bubble) {
        // A does not expose a machine timestamp in ordinary message markup.
        if (onA()) return 0;
        const v = bubble.dataset && bubble.dataset.timestamp;
        const n = v ? parseInt(v, 10) : 0;
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    const pad = (n) => String(n).padStart(2, '0');
    const isoDay = (ts) => {
        const d = new Date(ts * 1000);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const hhmm = (ts) => {
        const d = new Date(ts * 1000);
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    function displayedDay(label) {
        const normalizeLabel = (value) => String(value).toLocaleLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const target = normalizeLabel(label);
        if (!target) return '';
        const today = new Date();
        if (/^(today|сегодня)$/.test(target)) return isoDay(today.getTime() / 1000);
        if (/^(yesterday|вчера)$/.test(target)) {
            today.setDate(today.getDate() - 1);
            return isoDay(today.getTime() / 1000);
        }
        const locales = [...new Set([document.documentElement.lang, navigator.language, 'en', 'ru'].filter(Boolean))];
        for (const locale of locales) {
            try {
                // A uses a weekday for the previous six days, month/day this year,
                // and a full date for older years (formatMessageListDate upstream).
                const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' });
                for (let back = 1; back < 7; back++) {
                    const day = new Date(); day.setDate(day.getDate() - back);
                    if (normalizeLabel(weekday.format(day)) === target) return isoDay(day.getTime() / 1000);
                }
                const yearMatch = /\b([12]\d{3})\b/.exec(target);
                const year = yearMatch ? Number(yearMatch[1]) : today.getFullYear();
                const numbers = target.match(/\b\d{1,4}\b/g) || [];
                const dayNumber = numbers.find(n => n.length <= 2 && Number(n) >= 1 && Number(n) <= 31);
                if (!dayNumber) continue;
                for (let month = 0; month < 12; month++) {
                    const day = new Date(year, month, Number(dayNumber), 12);
                    if (day.getMonth() !== month) continue;
                    const formatter = new Intl.DateTimeFormat(locale, {
                        day: 'numeric', month: 'long', ...(yearMatch ? { year: 'numeric' } : {})
                    });
                    if (normalizeLabel(formatter.format(day)) === target) return isoDay(day.getTime() / 1000);
                }
            } catch (_) {}
        }
        return ''; // Preserve the label; never invent a timestamp for unknown formats.
    }

    function sourceUrl(mid, domMid, key = chatKey()) {
        const peer = onA() ? key.split('_')[0] : key;
        if (onA()) {
            if (!/^-\d+$/.test(peer)) return null;
            const channel = -BigInt(peer) - 1000000000000n; // Telegram Web A CHANNEL_ID_BASE.
            return channel > 0n ? `https://t.me/c/${channel}/${mid}` : null;
        }
        // Only K's offset identifies a channel/supergroup; basic group IDs are ambiguous.
        if (Number(domMid) <= MESSAGE_ID_OFFSET) return null;
        if (/^-\d+$/.test(peer)) return `https://t.me/c/${peer.slice(1)}/${mid}`;
        if (/^@[a-z][a-z0-9_]{3,31}$/i.test(peer)) return `https://t.me/${peer.slice(1)}/${mid}`;
        return null;
    }

    function extractLinks(bubble) {
        const text = bubble.querySelector(onA() ? '.text-content' : '.translatable-message, .text-content');
        if (!text) return [];
        const clone = text.cloneNode(true);
        clone.querySelectorAll(STRIP_BEFORE_TEXT).forEach(n => n.remove());
        return [...new Set([...clone.querySelectorAll('a[href]')].map(a => a.href)
            .filter(href => /^https?:\/\//i.test(href)))];
    }

    /** Reads every bubble currently in the DOM into the chat store. Returns how many were new. */
    function harvest() {
        if (!supported() || !chatKey()) return 0;
        const b = bucket();
        let added = 0;
        historyMessages().forEach(bubble => {
            if (readBubble(bubble, messageDayLabel(bubble), b)) added++;
        });
        if (added) scheduleSave();
        return added;
    }

    function messageDayLabel(bubble) {
        const title = onA()
            ? bubble.closest('.message-date-group')?.querySelector('.sticky-date')
            : bubble.closest('.bubbles-date-group')?.querySelector('.bubbles-date-group__title');
        return title ? (title.innerText || title.textContent || '').trim() : '';
    }

    function readBubble(bubble, label, b) {
        if (bubble.classList.contains('service') || bubble.classList.contains('ActionMessage')) return false;
        const mid = extractMid(bubble);
        if (!mid) return false;
        const text = extractText(bubble);
        if (!text) return false;
        const prev = b.get(mid);
        const ts = extractTs(bubble);
        const domMid = Number(extractDomMid(bubble));
        const post = {
            mid,
            dom_mid: domMid,
            ts: ts || prev?.ts || 0,
            date: ts ? isoDay(ts) : displayedDay(label) || prev?.date || label,
            time: ts ? hhmm(ts) : extractTime(bubble) || prev?.time || '',
            text: prev && prev.text.length > text.length ? prev.text : text,
            source_url: sourceUrl(mid, domMid),
            links: [...new Set([...(prev?.links || []), ...extractLinks(bubble)])],
            forwarded: onA() ? !!bubble.querySelector('.message-content.is-forwarded')
                : !!bubble.querySelector('.forward-name')
        };
        if (prev && JSON.stringify(prev) === JSON.stringify(post)) return false;
        b.set(mid, post);
        return true; // Also persist expanded text and newly available date/link metadata.
    }

    function expandAllShowMore() {
        // A's ordinary MessageText has no truncateLength; all text is already DOM.
        if (onA()) return 0;
        const root = kMessageList();
        if (!root) return 0;
        let count = 0;
        root.querySelectorAll('.bubble .show-more, .bubble .show-more-button').forEach(btn => {
            if (!isRendered(btn) || btn.closest('.bubbles-remover')) return;
            try { btn.click(); count++; } catch (_) {}
        });
        root.querySelectorAll('.bubble .translatable-message button').forEach(btn => {
            if (!isRendered(btn) || btn.closest('.bubbles-remover')) return;
            const t = (btn.textContent || '').trim();
            if (/^(show\s+more|развернуть|показать\s+ещё|показать\s+полностью)\.?$/i.test(t)) {
                try { btn.click(); count++; } catch (_) {}
            }
        });
        return count;
    }

    /* ==========================================================
       Auto-collect: scroll the history up until the start / date / stop
       ========================================================== */
    let autoRunning = false;

    function scroller() {
        if (onA()) return aMessageList();
        const root = kMessageList();
        if (!root) return null;
        const any = historyMessages()[0];
        let n = any ? any.parentElement : null;
        while (n && n !== document.body) {
            const s = getComputedStyle(n);
            if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
            if (n === root) break;
            n = n.parentElement;
        }
        return root.matches('.scrollable-y') ? root : root.querySelector('.scrollable-y');
    }

    function oldestVisibleDay() {
        let frontier = null;
        let frontierMid = Infinity;
        for (const bubble of historyMessages()) {
            if (bubble.classList.contains('service') || bubble.classList.contains('ActionMessage')) continue;
            const mid = extractMid(bubble);
            if (mid && mid < frontierMid) { frontier = bubble; frontierMid = mid; }
        }
        if (!frontier) return '';
        const ts = extractTs(frontier);
        return ts ? isoDay(ts) : displayedDay(messageDayLabel(frontier));
    }

    async function autoCollect() {
        if (!supported()) return;
        autoRunning = true;
        $auto.textContent = '■ Stop';
        $auto.classList.add('danger');
        const key = chatKey();
        const untilDay = $until.value;
        let idle = 0;
        let rounds = 0;
        const started = bucket().size;

        try {
            while (autoRunning && chatKey() === key) {
                const sc = scroller();
                if (!sc) { setStatus('No chat history found'); break; }

                if (expandAllShowMore()) await sleep(250);
                silenceMediaOnce();
                const added = harvest();
                rounds++;

                // Cached dates cannot tell us whether the current older boundary is known.
                const oldest = oldestVisibleDay();
                setStatus(`+${bucket().size - started} · ${bucket().size} total` +
                    (oldest ? ` · back to ${oldest}` : ''));
                if (rounds % 3 === 0) renderSoon();

                if (untilDay && !oldest) {
                    setStatus('Date unavailable at the oldest loaded post: clear "until" to continue');
                    break;
                }
                if (untilDay && oldest < untilDay) {
                    setStatus(`Reached ${$until.value} · ${bucket().size} total`);
                    break;
                }

                const before = sc.scrollHeight;
                sc.scrollTop = 0;
                // Wait for Telegram to prepend older history.
                let grew = false;
                for (let i = 0; i < 20 && autoRunning; i++) {
                    await sleep(150);
                    if (sc.scrollHeight !== before) { grew = true; break; }
                }
                if (added === 0 && !grew) {
                    idle++;
                    if (idle >= 6) { setStatus(`No older posts loaded · ${bucket().size} kept`); break; }
                    // Nudge: some loads only trigger after a small scroll movement.
                    sc.scrollTop = 200;
                    await sleep(300);
                } else {
                    idle = 0;
                }
            }
        } finally {
            autoRunning = false;
            $auto.textContent = '▲ Auto-collect';
            $auto.classList.remove('danger');
            harvest();
            scheduleSave(key);
            render();
        }
    }

    function setStatus(s) { $status.textContent = s; }

    /* ==========================================================
       Media silencer
       ========================================================== */
    let silencerTimer = 0;
    function silenceMediaOnce() {
        try {
            document.querySelectorAll('audio, video').forEach(m => {
                try { if (!m.paused) m.pause(); } catch (_) {}
            });
        } catch (_) {}
    }
    function startSilencer() {
        if (silencerTimer) return;
        silenceMediaOnce();
        silencerTimer = setInterval(silenceMediaOnce, 400);
    }
    function stopSilencer() {
        if (silencerTimer) { clearInterval(silencerTimer); silencerTimer = 0; }
    }

    /* ==========================================================
       View state
       ========================================================== */
    let currentFilter = 'all';     // 'all' or a date string
    let renderInFlight = false;
    let renderTimer = 0;

    const normalize = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

    function allPosts() {
        return [...bucket().values()].sort((a, b) => b.mid - a.mid);
    }

    function viewPosts() {
        const q = $search.value.trim().toLowerCase();
        const min = parseInt($min.value, 10) || 0;
        const seen = new Set();
        const out = [];
        // Oldest first for dedupe so the original wins, then flip back to newest first.
        const base = allPosts().reverse();
        for (const p of base) {
            if (p.text.length < min) continue;
            if (q && !p.text.toLowerCase().includes(q)) continue;
            if ($dedupe.checked) {
                const n = normalize(p.text);
                if (seen.has(n)) continue;
                seen.add(n);
            }
            out.push(p);
        }
        return out.reverse();
    }

    function getFilteredPosts() {
        const v = viewPosts();
        return currentFilter === 'all' ? v : v.filter(p => p.date === currentFilter);
    }

    function renderSoon() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => render(), 150);
    }

    /* ==========================================================
       Render
       ========================================================== */
    async function render({ scan = false } = {}) {
        if (renderInFlight) return;
        renderInFlight = true;
        try {
            if (!supported()) {
                renderUnsupportedBanner();
                return;
            }
            await loadChat();
            if (scan && !autoRunning) {
                if (expandAllShowMore() > 0) {
                    await sleep(500);
                    silenceMediaOnce();
                }
                harvest();
            }

            const view = viewPosts();
            if (currentFilter !== 'all' && !view.some(p => p.date === currentFilter)) currentFilter = 'all';
            $total.textContent = `/ ${bucket().size} kept`;

            renderFilters(view);
            renderCopyMenu(view);
            renderList();
        } finally {
            renderInFlight = false;
        }
    }

    function renderUnsupportedBanner() {
        $count.textContent = '0';
        $total.textContent = '';
        $filters.innerHTML = '';
        $list.innerHTML = `
            <div class="tge-empty">
                <strong style="color:#e8e8e8;font-size:14px;">Use Telegram Web K or A</strong><br><br>
                Open <a href="https://web.telegram.org/k/">/k/</a> or
                <a href="https://web.telegram.org/a/">/a/</a>, sign in there,
                and open your chat. The two clients can require separate logins.
            </div>`;
    }

    function datesOf(posts) {
        const dates = [];
        const seen = new Set();
        for (const p of posts) {
            if (!p.date || seen.has(p.date)) continue;
            seen.add(p.date);
            dates.push(p.date);
        }
        return dates;
    }

    function renderFilters(view) {
        $filters.innerHTML = '';
        const dates = datesOf(view);
        if (!dates.length) return;
        const counts = new Map([['all', view.length]]);
        for (const p of view) counts.set(p.date, (counts.get(p.date) || 0) + 1);

        const make = (key, label) => {
            const chip = document.createElement('button');
            chip.className = 'tge-chip' + (currentFilter === key ? ' active' : '');
            chip.textContent = `${label} · ${counts.get(key) || 0}`;
            chip.addEventListener('click', () => {
                currentFilter = key;
                renderFilters(view);
                renderList();
            });
            $filters.appendChild(chip);
        };
        make('all', 'All');
        // Too many days make the chip row useless — the copy menu still lists all of them.
        for (const d of dates.slice(0, 60)) make(d, d);
    }

    function renderCopyMenu(view) {
        $copyMenu.innerHTML = '';
        const addItem = (label, posts) => {
            const item = document.createElement('button');
            item.className = 'tge-copy-menu-item';
            item.innerHTML = `<span></span><span class="tge-copy-menu-count">${posts.length}</span>`;
            item.firstChild.textContent = label;
            item.addEventListener('click', async () => {
                await copyPosts(posts);
                hideCopyMenu();
            });
            $copyMenu.appendChild(item);
        };
        addItem('All days', view);
        const byMonth = new Map();
        for (const p of view) {
            if (!/^\d{4}-\d{2}/.test(p.date)) continue;
            const m = p.date.slice(0, 7);
            if (!byMonth.has(m)) byMonth.set(m, []);
            byMonth.get(m).push(p);
        }
        for (const [m, posts] of byMonth) addItem(`Month ${m}`, posts);
        for (const d of datesOf(view)) addItem(d, view.filter(p => p.date === d));
    }

    function showCopyMenu() {
        $copyMenu.hidden = false;
        document.addEventListener('click', onDocClickForCopyMenu, true);
    }
    function hideCopyMenu() {
        $copyMenu.hidden = true;
        document.removeEventListener('click', onDocClickForCopyMenu, true);
    }
    function onDocClickForCopyMenu(e) {
        if ($copyMenu.contains(e.target) || $copyMenuBtn === e.target) return;
        hideCopyMenu();
    }

    function findBubble(mid) {
        return onA() ? aMessageList()?.querySelector(`.Message[data-message-id="${mid}"], #message-${mid}`)
            : kMessageList()?.querySelector(`.bubble[data-mid="${mid}"], .bubble[data-mid="${mid + MESSAGE_ID_OFFSET}"]`);
    }

    function renderList() {
        const filtered = getFilteredPosts();
        $count.textContent = filtered.length;

        if (filtered.length === 0) {
            $list.innerHTML = `
                <div class="tge-empty">
                    Nothing here yet.<br><br>
                    Press <b>▲ Auto-collect</b> or <b>↻</b>, or loosen the filters.
                </div>`;
            return;
        }

        const frag = document.createDocumentFragment();
        filtered.slice(0, RENDER_LIMIT).forEach((p, i) => {
            const item = document.createElement('div');
            item.className = 'tge-item';

            const meta = document.createElement('div');
            meta.className = 'tge-item-meta';
            const left = document.createElement('span');
            left.textContent = [`#${i + 1}`, p.date, p.time].filter(Boolean).join(' · ');
            const right = document.createElement('span');
            right.textContent = `${p.text.length} chars`;
            meta.append(left, right);

            const textEl = document.createElement('div');
            textEl.className = 'tge-item-text';
            textEl.textContent = p.text;

            const actions = document.createElement('div');
            actions.className = 'tge-item-actions';
            const jumpBtn = document.createElement('button');
            jumpBtn.textContent = '→ Jump';
            const copyBtn = document.createElement('button');
            copyBtn.textContent = '📋 Copy';
            actions.append(jumpBtn, copyBtn);
            item.append(meta, textEl, actions);

            jumpBtn.addEventListener('click', () => {
                const el = findBubble(p.mid);
                if (!el) {
                    jumpBtn.textContent = 'not loaded';
                    setTimeout(() => { jumpBtn.textContent = '→ Jump'; }, 1000);
                    return;
                }
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const orig = el.style.backgroundColor;
                el.style.transition = 'background .3s';
                el.style.backgroundColor = 'rgba(36,129,204,.25)';
                setTimeout(() => { el.style.backgroundColor = orig; }, 800);
            });

            copyBtn.addEventListener('click', async () => {
                const ok = await writeClipboard(p.text);
                copyBtn.textContent = ok ? '✓ Copied' : '✗ Failed';
                copyBtn.classList.toggle('ok', ok);
                setTimeout(() => {
                    copyBtn.textContent = '📋 Copy';
                    copyBtn.classList.remove('ok');
                }, 1000);
            });

            frag.appendChild(item);
        });

        if (filtered.length > RENDER_LIMIT) {
            const more = document.createElement('div');
            more.className = 'tge-empty';
            more.textContent = `+${filtered.length - RENDER_LIMIT} more — Copy / Export include all of them.`;
            frag.appendChild(more);
        }

        $list.innerHTML = '';
        $list.appendChild(frag);
    }

    /* ==========================================================
       Top-bar actions
       ========================================================== */
    function serializePosts(posts) {
        return posts
            .map((p, i) => `--- ${[`#${i + 1}`, p.date, p.time].filter(Boolean).join(' · ')} ---\n${p.text}`)
            .join('\n\n');
    }

    async function copyPosts(posts) {
        if (!posts.length) return false;
        const ok = await writeClipboard(serializePosts(posts));
        $copyAll.textContent = ok ? `✓ ${posts.length}` : '✗ Failed';
        setTimeout(() => { $copyAll.textContent = 'Copy'; }, 1200);
        return ok;
    }

    function download(name, text, type) {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function fileStem() {
        const tag = currentFilter === 'all' ? 'all' : currentFilter.replace(/\s+/g, '-');
        const chat = chatKey().replace(/[^0-9a-z_-]/gi, '') || 'chat';
        return `tg-${chat}-${tag}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
    }

    $refresh.addEventListener('click', () => render({ scan: true }));
    $copyAll.addEventListener('click', () => copyPosts(getFilteredPosts()));
    $copyMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if ($copyMenu.hidden) showCopyMenu();
        else hideCopyMenu();
    });
    $export.addEventListener('click', () => {
        const posts = getFilteredPosts();
        if (posts.length) download(`${fileStem()}.txt`, serializePosts(posts), 'text/plain;charset=utf-8');
    });
    $exportJson.addEventListener('click', () => {
        const posts = getFilteredPosts();
        if (!posts.length) return;
        const json = JSON.stringify({ chat: chatKey(), exported_at: new Date().toISOString(), posts }, null, 2);
        download(`${fileStem()}.json`, json, 'application/json');
    });
    $auto.addEventListener('click', () => {
        if (autoRunning) { autoRunning = false; return; }
        autoCollect();
    });
    $clear.addEventListener('click', async () => {
        if (!confirm(`Forget ${bucket().size} collected posts for this chat?`)) return;
        await clearChat();
        setStatus('');
        render();
    });
    let searchTimer = 0;
    const onFilterInput = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => render(), 200);
    };
    $search.addEventListener('input', onFilterInput);
    $min.addEventListener('input', onFilterInput);
    $dedupe.addEventListener('change', () => render());
    $close.addEventListener('click', closePanel);

    function openPanel() {
        panel.classList.add('open');
        toggleBtn.classList.add('active');
        toggleBtn.textContent = '✕';
        startSilencer();
        setTimeout(() => render({ scan: true }), 80);
    }
    function closePanel() {
        autoRunning = false;
        panel.classList.remove('open');
        toggleBtn.classList.remove('active');
        toggleBtn.textContent = '📋';
        hideCopyMenu();
        stopSilencer();
    }
    toggleBtn.addEventListener('click', () => {
        panel.classList.contains('open') ? closePanel() : openPanel();
    });

    chrome.runtime?.onMessage?.addListener((msg) => {
        if (msg && msg.type === 'tge-toggle') {
            panel.classList.contains('open') ? closePanel() : openPanel();
        }
    });

    // Switching chats: stop the harvester and show the other chat's store.
    window.addEventListener('hashchange', () => {
        autoRunning = false;
        currentFilter = 'all';
        setStatus('');
        if (panel.classList.contains('open')) render({ scan: true });
    });

    /* ==========================================================
       Passive harvesting: every post that passes through the DOM is kept,
       so plain manual scrolling also builds up the full list.
       ========================================================== */
    let harvestDebounce = 0;
    const observer = new MutationObserver((mutations) => {
        if (!panel.classList.contains('open') || autoRunning) return;
        const fromTelegram = mutations.some(m => !panel.contains(m.target) && !toggleBtn.contains(m.target));
        if (!fromTelegram) return;
        clearTimeout(harvestDebounce);
        harvestDebounce = setTimeout(() => {
            if (!supported()) return;
            if (harvest() > 0) renderSoon();
        }, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    /* ==========================================================
       Clipboard write
       ========================================================== */
    async function writeClipboard(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_) {}
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (_) {
            return false;
        }
    }

    console.log(
        `%c[Telegram Text Extractor v${VERSION}]%c ${onK() ? 'K' : onA() ? 'A' : 'Unsupported'} build loaded.`,
        'color:#2481cc;font-weight:bold;font-size:14px',
        'color:inherit'
    );
})();
