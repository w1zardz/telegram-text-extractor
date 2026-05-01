/* Telegram Text Extractor — content script (Telegram Web K only)
 *
 * Targets web.telegram.org/k/ specifically. The K build has a stable
 * DOM contract we can rely on: every post bubble is `.bubble[data-mid]`,
 * the actual text lives in `.translatable-message`, reply previews are
 * wrapped in `.reply`, and date dividers are `.bubbles-date-group__title`.
 * No more multi-build selector soup — that's what was causing voice
 * messages, date dividers and reply previews to leak into the list.
 */

(function () {
    'use strict';

    if (window.__tgeLoaded) return;
    window.__tgeLoaded = true;

    const onK = () => location.pathname.startsWith('/k/');

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
    toggleBtn.title = 'Telegram Text Extractor — show all visible posts';
    document.body.appendChild(toggleBtn);

    const panel = document.createElement('div');
    panel.id = 'tge-panel';
    panel.innerHTML = `
        <div class="tge-header">
            <span class="tge-title">📋 Posts (<span id="tge-count">0</span>)</span>
            <div class="tge-actions">
                <button id="tge-refresh"  title="Refresh">↻</button>
                <div class="tge-copy-wrap">
                    <button id="tge-copy-all" class="primary" title="Copy filtered posts">Copy</button>
                    <button id="tge-copy-menu-btn" class="primary" title="Copy by day">▾</button>
                    <div class="tge-copy-menu" id="tge-copy-menu" hidden></div>
                </div>
                <button id="tge-export" title="Export filtered to .txt">⬇ .txt</button>
                <button id="tge-close"  title="Close">✕</button>
            </div>
        </div>
        <div class="tge-filters" id="tge-filters"></div>
        <div class="tge-list" id="tge-list">
            <div class="tge-empty">
                Open a channel or chat, scroll through the messages,<br>
                then click <b>↻</b> to scan visible posts.
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    const $list      = panel.querySelector('#tge-list');
    const $count     = panel.querySelector('#tge-count');
    const $filters   = panel.querySelector('#tge-filters');
    const $refresh   = panel.querySelector('#tge-refresh');
    const $copyAll   = panel.querySelector('#tge-copy-all');
    const $copyMenuBtn = panel.querySelector('#tge-copy-menu-btn');
    const $copyMenu  = panel.querySelector('#tge-copy-menu');
    const $export    = panel.querySelector('#tge-export');
    const $close     = panel.querySelector('#tge-close');

    /* ==========================================================
       K-specific selectors
       ========================================================== */
    // Reply previews / forwards / link previews — anything we want to
    // strip before reading the actual message body.
    const STRIP_BEFORE_TEXT = [
        '.reply',
        '.bubble-reply',
        '.RepliedMessage',
        '.web-page-preview',
        '.web-page',
        '.preview',
        '.embed',
        '.forward-name',
        '.attribution',
        '.message-comments-wrapper',
        '.message-comments',
        '.bubble-comments',
        '.reactions',
        '.reactions-element',
        '.time',
        '.time-inner',
        '.post-views',
        '.message-views',
        '.bubble-controls',
        '.show-more',
        '.show-more-button',
        '.translation-button',
        '.RippleEffect',
        '.ripple-container',
        'audio',
        'video',
        'source',
        'img',
        'button',
        '.btn-icon'
    ].join(',');

    /* ==========================================================
       Helpers
       ========================================================== */
    function extractText(bubble) {
        const clone = bubble.cloneNode(true);
        clone.querySelectorAll(STRIP_BEFORE_TEXT).forEach(n => n.remove());

        // After stripping, the actual body is whatever .translatable-message
        // remains. If none — try the full cleaned clone (covers media-with-caption).
        let textEl = clone.querySelector('.translatable-message');
        if (!textEl) {
            textEl = clone.querySelector('.text-content') || clone;
        }

        let txt = (textEl.innerText || textEl.textContent || '')
            .replace(/ /g, ' ')
            .replace(/\s+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        txt = txt.replace(/[\s·…]+(Show\s+more|Развернуть|Показать\s+ещё|Показать\s+полностью)\.?$/i, '').trim();
        txt = txt.replace(/\s*\d+\s+Comments?\s*$/i, '').trim();
        return txt;
    }

    function extractTime(bubble) {
        // K renders time as `<i class="time"><i class="time-inner">..views..<span>HH:MM</span></i></i>`.
        // We want strictly the HH:MM, not the views ("1.6K").
        const inner = bubble.querySelector('.time-inner, .time');
        if (!inner) return '';
        const raw = (inner.innerText || inner.textContent || '');
        const m = raw.match(/\b\d{1,2}:\d{2}\b/);
        return m ? m[0] : '';
    }

    function extractMid(bubble) {
        const v = bubble.dataset && bubble.dataset.mid;
        if (!v) return 0;
        const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
        return Number.isNaN(n) ? 0 : n;
    }

    function findMessages() {
        const items = [];
        const seenMids = new Set();
        const groupedBubbles = new Set();

        // Primary path: walk K's date groups, attribute bubbles to their group title.
        document.querySelectorAll('.bubbles-date-group').forEach(group => {
            const title = group.querySelector('.bubbles-date-group__title');
            const date = title ? (title.innerText || title.textContent || '').trim() : '';

            group.querySelectorAll('.bubble[data-mid]').forEach(bubble => {
                groupedBubbles.add(bubble);
                if (!isUsableBubble(bubble)) return;
                const mid = extractMid(bubble);
                if (!mid || seenMids.has(mid)) return;
                const text = extractText(bubble);
                if (!text) return;
                seenMids.add(mid);
                items.push({ el: bubble, mid, text, time: extractTime(bubble), date });
            });
        });

        // Fallback: bubbles outside any date group.
        document.querySelectorAll('.bubble[data-mid]').forEach(bubble => {
            if (groupedBubbles.has(bubble)) return;
            if (!isUsableBubble(bubble)) return;
            const mid = extractMid(bubble);
            if (!mid || seenMids.has(mid)) return;
            const text = extractText(bubble);
            if (!text) return;
            seenMids.add(mid);
            items.push({ el: bubble, mid, text, time: extractTime(bubble), date: '' });
        });

        // Newest first by Telegram message ID.
        items.sort((a, b) => b.mid - a.mid);
        return items;
    }

    function isUsableBubble(bubble) {
        // Service messages (joined chat, pinned, etc.) — skip.
        if (bubble.classList.contains('service')) return false;
        // Sticker / round video / voice-only — no text container at all.
        // We don't pre-filter aggressively; extractText returning '' will skip them.
        return true;
    }

    /* ==========================================================
       "Show more" expander (Telegram K collapses long posts).
       ========================================================== */
    function expandAllShowMore() {
        let count = 0;
        document.querySelectorAll('.show-more, .show-more-button').forEach(btn => {
            try { btn.click(); count++; } catch (_) {}
        });
        document.querySelectorAll('.bubble .translatable-message button').forEach(btn => {
            const t = (btn.textContent || '').trim().toLowerCase();
            if (/^(show\s+more|развернуть|показать\s+ещё|показать\s+полностью)\.?$/i.test(t)) {
                try { btn.click(); count++; } catch (_) {}
            }
        });
        return count;
    }

    /* ==========================================================
       Telegram media silencer — keeps voice / video from blasting
       at the moment the user opens the panel.
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
       State
       ========================================================== */
    let currentPosts = [];
    let currentFilter = 'all';   // 'all' or a date label string
    let renderInFlight = false;

    /* ==========================================================
       Render
       ========================================================== */
    async function render() {
        if (renderInFlight) return;
        renderInFlight = true;
        try {
            if (!onK()) {
                renderNotKBanner();
                return;
            }

            const expanded = expandAllShowMore();
            if (expanded > 0) {
                await new Promise(r => setTimeout(r, 600));
                silenceMediaOnce();
            }

            currentPosts = findMessages();

            // Reset filter if its label is no longer present.
            if (currentFilter !== 'all' && !currentPosts.some(p => p.date === currentFilter)) {
                currentFilter = 'all';
            }

            renderFilters();
            renderCopyMenu();
            renderList();
        } finally {
            renderInFlight = false;
        }
    }

    function renderNotKBanner() {
        currentPosts = [];
        $count.textContent = '0';
        $filters.innerHTML = '';
        $list.innerHTML = `
            <div class="tge-empty">
                <strong style="color:#e8e8e8;font-size:14px;">Open Telegram Web K</strong><br><br>
                This extension only works on <code>/k/</code> — it relies on its
                exact DOM structure.<br><br>
                <a href="https://web.telegram.org/k/" style="color:#2481cc;font-weight:600;">
                    → Switch to web.telegram.org/k/
                </a>
            </div>`;
    }

    function getFilteredPosts() {
        if (currentFilter === 'all') return currentPosts;
        return currentPosts.filter(p => p.date === currentFilter);
    }

    function renderFilters() {
        $filters.innerHTML = '';
        if (!currentPosts.length) return;

        // Preserve first-seen order of dates (newest first since posts are sorted desc).
        const dates = [];
        const seen = new Set();
        for (const p of currentPosts) {
            if (!p.date) continue;
            if (seen.has(p.date)) continue;
            seen.add(p.date);
            dates.push(p.date);
        }

        if (!dates.length) return;

        const counts = new Map();
        counts.set('all', currentPosts.length);
        for (const d of dates) {
            counts.set(d, currentPosts.filter(p => p.date === d).length);
        }

        const make = (key, label) => {
            const chip = document.createElement('button');
            chip.className = 'tge-chip' + (currentFilter === key ? ' active' : '');
            chip.textContent = `${label} · ${counts.get(key) || 0}`;
            chip.addEventListener('click', () => {
                currentFilter = key;
                renderFilters();
                renderList();
            });
            $filters.appendChild(chip);
        };

        make('all', 'All');
        for (const d of dates) make(d, d);
    }

    function renderCopyMenu() {
        $copyMenu.innerHTML = '';
        const dates = [];
        const seen = new Set();
        for (const p of currentPosts) {
            if (!p.date || seen.has(p.date)) continue;
            seen.add(p.date);
            dates.push(p.date);
        }

        const addItem = (label, scope) => {
            const item = document.createElement('button');
            item.className = 'tge-copy-menu-item';
            const count = scope === 'all'
                ? currentPosts.length
                : currentPosts.filter(p => p.date === scope).length;
            item.innerHTML = `<span>${label}</span><span class="tge-copy-menu-count">${count}</span>`;
            item.addEventListener('click', async () => {
                const posts = scope === 'all'
                    ? currentPosts
                    : currentPosts.filter(p => p.date === scope);
                await copyPosts(posts);
                hideCopyMenu();
            });
            $copyMenu.appendChild(item);
        };

        addItem('All days', 'all');
        for (const d of dates) addItem(d, d);
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

    function renderList() {
        const filtered = getFilteredPosts();
        $count.textContent = filtered.length;

        if (filtered.length === 0) {
            $list.innerHTML = `
                <div class="tge-empty">
                    No text messages in this range.<br><br>
                    Click <b>↻</b> after scrolling, or pick a different day.
                </div>`;
            return;
        }

        const frag = document.createDocumentFragment();
        filtered.forEach((p, i) => {
            const item = document.createElement('div');
            item.className = 'tge-item';

            const meta = document.createElement('div');
            meta.className = 'tge-item-meta';
            const left = document.createElement('span');
            const head = [`#${i + 1}`];
            if (p.date) head.push(p.date);
            if (p.time) head.push(p.time);
            left.textContent = head.join(' · ');
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
                p.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const orig = p.el.style.backgroundColor;
                p.el.style.transition = 'background .3s';
                p.el.style.backgroundColor = 'rgba(36,129,204,.25)';
                setTimeout(() => { p.el.style.backgroundColor = orig; }, 800);
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

        $list.innerHTML = '';
        $list.appendChild(frag);
    }

    /* ==========================================================
       Top-bar actions
       ========================================================== */
    function serializePosts(posts) {
        return posts
            .map((p, i) => {
                const head = [`#${i + 1}`];
                if (p.date) head.push(p.date);
                if (p.time) head.push(p.time);
                return `--- ${head.join(' · ')} ---\n${p.text}`;
            })
            .join('\n\n');
    }

    async function copyPosts(posts) {
        if (!posts.length) return false;
        const ok = await writeClipboard(serializePosts(posts));
        $copyAll.textContent = ok ? '✓ Copied' : '✗ Failed';
        setTimeout(() => { $copyAll.textContent = 'Copy'; }, 1000);
        return ok;
    }

    $refresh.addEventListener('click', () => render());

    $copyAll.addEventListener('click', async () => {
        const posts = getFilteredPosts();
        await copyPosts(posts);
    });

    $copyMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if ($copyMenu.hidden) showCopyMenu();
        else hideCopyMenu();
    });

    $export.addEventListener('click', () => {
        const posts = getFilteredPosts();
        if (!posts.length) return;
        const text = serializePosts(posts);
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const tag = currentFilter === 'all' ? 'all' : currentFilter.replace(/\s+/g, '-');
        const a = document.createElement('a');
        a.href = url;
        a.download = `tg-posts-${tag}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    $close.addEventListener('click', closePanel);

    function openPanel() {
        panel.classList.add('open');
        toggleBtn.classList.add('active');
        toggleBtn.textContent = '✕';
        startSilencer();
        setTimeout(render, 80);
    }
    function closePanel() {
        panel.classList.remove('open');
        toggleBtn.classList.remove('active');
        toggleBtn.textContent = '📋';
        hideCopyMenu();
        stopSilencer();
    }
    toggleBtn.addEventListener('click', () => {
        panel.classList.contains('open') ? closePanel() : openPanel();
    });

    /* Toolbar icon → background SW → here. */
    chrome.runtime?.onMessage?.addListener((msg) => {
        if (msg && msg.type === 'tge-toggle') {
            panel.classList.contains('open') ? closePanel() : openPanel();
        }
    });

    /* ==========================================================
       Auto-refresh observer (ignores mutations from inside our UI)
       ========================================================== */
    let renderDebounce = 0;
    const observer = new MutationObserver((mutations) => {
        if (!panel.classList.contains('open')) return;
        const fromTelegram = mutations.some(m => {
            let n = m.target;
            while (n) {
                if (n === panel || n === toggleBtn) return false;
                n = n.parentNode;
            }
            return true;
        });
        if (!fromTelegram) return;
        clearTimeout(renderDebounce);
        renderDebounce = setTimeout(() => render(), 700);
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
        '%c[Telegram Text Extractor v1.0.3]%c K-only build loaded.',
        'color:#2481cc;font-weight:bold;font-size:14px',
        'color:inherit'
    );
})();
