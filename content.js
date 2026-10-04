/* Telegram Text Extractor — content script (Telegram Web K)
 *
 * Targets web.telegram.org/k/. K has a stable DOM contract: every post
 * bubble is `.bubble[data-mid]` with `data-timestamp`, the text lives in
 * `.translatable-message`, reply previews are wrapped in `.reply`, date
 * dividers are `.bubbles-date-group__title`.
 *
 * v1.1: Telegram virtualises the history — bubbles scrolled far away are
 * removed from the DOM. So instead of reading "what is visible now" we
 * keep an accumulating per-chat store (persisted in chrome.storage.local)
 * and add an auto-scroll harvester that walks the history on its own.
 * On /a/ and other builds the panel offers a one-click jump to the same
 * chat in /k/.
 */

(function () {
    'use strict';

    if (window.__tgeLoaded) return;
    window.__tgeLoaded = true;

    const VERSION = '1.1.0';
    const RENDER_LIMIT = 400;          // DOM items in the panel; export always takes everything
    const onK = () => location.pathname.startsWith('/k/');
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
                <button id="tge-export-json" title="Export filtered to .json (mid, date, text)">⬇ .json</button>
                <button id="tge-close" title="Close">✕</button>
            </div>
        </div>
        <div class="tge-harvest">
            <button id="tge-auto" class="primary" title="Scroll the chat history automatically and collect every post">▲ Auto-collect</button>
            <label title="Stop when posts older than this date are reached (empty = go to the very beginning)">
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
       K-specific selectors
       ========================================================== */
    const STRIP_BEFORE_TEXT = [
        '.reply', '.bubble-reply', '.RepliedMessage',
        '.web-page-preview', '.web-page', '.preview', '.embed',
        '.forward-name', '.attribution',
        '.message-comments-wrapper', '.message-comments', '.bubble-comments',
        '.reactions', '.reactions-element',
        '.time', '.time-inner', '.post-views', '.message-views',
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
            for (const p of arr) if (p && p.mid && !b.has(p.mid)) b.set(p.mid, p);
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
        clone.querySelectorAll(STRIP_BEFORE_TEXT).forEach(n => n.remove());

        let textEl = clone.querySelector('.translatable-message');
        if (!textEl) textEl = clone.querySelector('.text-content') || clone;

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
        const inner = bubble.querySelector('.time-inner, .time');
        if (!inner) return '';
        const m = (inner.innerText || inner.textContent || '').match(/\b\d{1,2}:\d{2}\b/);
        return m ? m[0] : '';
    }

    function extractMid(bubble) {
        const v = bubble.dataset && bubble.dataset.mid;
        if (!v) return 0;
        const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
        return Number.isNaN(n) ? 0 : n;
    }

    function extractTs(bubble) {
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

    /** Reads every bubble currently in the DOM into the chat store. Returns how many were new. */
    function harvest() {
        const b = bucket();
        let added = 0;
        document.querySelectorAll('.bubbles-date-group').forEach(group => {
            const title = group.querySelector('.bubbles-date-group__title');
            const label = title ? (title.innerText || title.textContent || '').trim() : '';
            group.querySelectorAll('.bubble[data-mid]').forEach(bubble => {
                if (readBubble(bubble, label, b)) added++;
            });
        });
        document.querySelectorAll('.bubble[data-mid]').forEach(bubble => {
            if (!bubble.closest('.bubbles-date-group') && readBubble(bubble, '', b)) added++;
        });
        if (added) scheduleSave();
        return added;
    }

    function readBubble(bubble, label, b) {
        if (bubble.classList.contains('service')) return false;
        const mid = extractMid(bubble);
        if (!mid) return false;
        const text = extractText(bubble);
        if (!text) return false;
        const prev = b.get(mid);
        // Keep the longest version — a collapsed post may have been read before "Show more" expanded.
        if (prev && prev.text.length >= text.length) return false;
        const ts = extractTs(bubble);
        b.set(mid, {
            mid,
            ts,
            date: ts ? isoDay(ts) : label,
            time: ts ? hhmm(ts) : extractTime(bubble),
            text
        });
        return !prev;
    }

    function expandAllShowMore() {
        let count = 0;
        document.querySelectorAll('.bubble .show-more, .bubble .show-more-button').forEach(btn => {
            try { btn.click(); count++; } catch (_) {}
        });
        document.querySelectorAll('.bubble .translatable-message button').forEach(btn => {
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
        const any = document.querySelector('.bubble[data-mid]');
        let n = any ? any.parentElement : null;
        while (n && n !== document.body) {
            const s = getComputedStyle(n);
            if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
            n = n.parentElement;
        }
        return document.querySelector('.bubbles .scrollable-y, .bubbles-inner')?.closest('.scrollable') || null;
    }

    function oldestTsInStore() {
        let min = Infinity;
        for (const p of bucket().values()) if (p.ts && p.ts < min) min = p.ts;
        return min;
    }

    async function autoCollect() {
        if (!onK()) return;
        autoRunning = true;
        $auto.textContent = '■ Stop';
        $auto.classList.add('danger');
        const key = chatKey();
        const untilTs = $until.value ? Math.floor(new Date($until.value + 'T00:00:00').getTime() / 1000) : 0;
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

                const oldest = oldestTsInStore();
                setStatus(`+${bucket().size - started} · ${bucket().size} total` +
                    (oldest !== Infinity ? ` · back to ${isoDay(oldest)}` : ''));
                if (rounds % 3 === 0) renderSoon();

                if (untilTs && oldest !== Infinity && oldest < untilTs) {
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
                    if (idle >= 6) { setStatus(`Start of history · ${bucket().size} total`); break; }
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
            if (!onK()) {
                renderNotKBanner();
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

    function renderNotKBanner() {
        $count.textContent = '0';
        $total.textContent = '';
        $filters.innerHTML = '';
        const target = `https://web.telegram.org/k/${location.hash || ''}`;
        $list.innerHTML = `
            <div class="tge-empty">
                <strong style="color:#e8e8e8;font-size:14px;">This needs Telegram Web K</strong><br><br>
                The extractor reads the <code>/k/</code> DOM. Your session is shared,
                the same chat opens there without logging in again.<br><br>
                <a id="tge-to-k" href="${target}" style="color:#2481cc;font-weight:600;">
                    → Open this chat in /k/
                </a>
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
        return document.querySelector(`.bubble[data-mid="${mid}"]`);
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
            if (!onK()) return;
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
        `%c[Telegram Text Extractor v${VERSION}]%c K build loaded.`,
        'color:#2481cc;font-weight:bold;font-size:14px',
        'color:inherit'
    );
})();
