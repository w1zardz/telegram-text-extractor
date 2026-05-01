/* Telegram Text Extractor — content script
 * Adds a slide-in panel to web.telegram.org listing every rendered text post.
 * Per-post copy, copy-all, export to .txt. Works in channels/groups where
 * Telegram disables native text selection and copy.
 */

(function () {
    'use strict';

    if (window.__tgeLoaded) return;
    window.__tgeLoaded = true;

    /* ==========================================================
       Stop copy/cut/Ctrl+C events that originate inside our panel
       from leaking to Telegram's global copy handler (which plays
       its "copying is disabled" deny chime).
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
    document.addEventListener('copy', swallow, true);
    document.addEventListener('cut', swallow, true);
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
                <button id="tge-copy-all" class="primary" title="Copy all">Copy all</button>
                <button id="tge-export"   title="Export .txt">⬇ .txt</button>
                <button id="tge-close"    title="Close">✕</button>
            </div>
        </div>
        <div class="tge-list" id="tge-list">
            <div class="tge-empty">
                Open a channel or chat, scroll through the messages,<br>
                then click <b>↻</b> to scan visible posts.
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    const $list    = panel.querySelector('#tge-list');
    const $count   = panel.querySelector('#tge-count');
    const $refresh = panel.querySelector('#tge-refresh');
    const $copyAll = panel.querySelector('#tge-copy-all');
    const $export  = panel.querySelector('#tge-export');
    const $close   = panel.querySelector('#tge-close');

    /* ==========================================================
       Selectors
       ========================================================== */
    const MSG_SELECTORS = [
        '[data-mid]',
        '[data-message-id]',
        '.Message',
        '.bubble',
        '[id^="message-"]'
    ];

    // Narrow text-content selectors — kept tight on purpose so we
    // don't pick up voice/video/sticker meta blocks.
    const TEXT_CONTAINER_SEL = [
        '.translatable-message',
        '.MessageText',
        '.Message__text',
        '.message > .text-content > div'
    ].join(', ');

    const NOISE_STRIP_SEL = [
        '.time', '.time-inner', '.MessageMeta', '.message-time',
        '.reactions', '.Reactions', '.ReactionStaticEmoji',
        '.post-views', '.views', '.message-views',
        '.edited', '.is-edited',
        '.reply-markup', '.RippleEffect', '.ripple-container',
        '.show-more', '.show-more-button', '.translation-button',
        '.message-comments', '.CommentsButton', '.comments',
        '.bot-keyboard',
        'button', '.btn-icon', '.Button',
        '.tge-copy-btn'
    ].join(',');

    /* ==========================================================
       Helpers
       ========================================================== */
    function findTextContainer(bubble) {
        return bubble.querySelector(TEXT_CONTAINER_SEL);
    }

    function extractText(bubble) {
        const textEl = findTextContainer(bubble);
        if (!textEl) return '';
        const clone = textEl.cloneNode(true);
        clone.querySelectorAll(NOISE_STRIP_SEL).forEach(n => n.remove());
        let txt = (clone.innerText || clone.textContent || '')
            .replace(/ /g, ' ')
            .replace(/\s+\n/g, '\n')
            .trim();
        // Drop trailing "Show more" / "Развернуть"
        txt = txt.replace(/[\s·…]+(Show\s+more|Развернуть|Показать\s+ещё|Показать\s+полностью)\.?$/i, '').trim();
        // Drop trailing "X Comments" tail seen on channel posts
        txt = txt.replace(/\s*\d+\s+Comments?\s*$/i, '').trim();
        return txt;
    }

    function extractTime(bubble) {
        const t = bubble.querySelector('.time, .time-inner, .MessageMeta time, .message-time');
        if (!t) return '';
        const raw = t.innerText || t.textContent || '';
        return raw.trim().split('\n')[0];
    }

    function extractMid(bubble) {
        if (bubble.dataset) {
            const v = bubble.dataset.mid || bubble.dataset.messageId;
            if (v) {
                const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
                if (!Number.isNaN(n) && n !== 0) return n;
            }
        }
        if (bubble.id && bubble.id.startsWith('message-')) {
            const n = parseInt(bubble.id.slice(8), 10);
            if (!Number.isNaN(n) && n !== 0) return n;
        }
        return 0;
    }

    function findMessages() {
        const set = new Set();
        for (const sel of MSG_SELECTORS) {
            try { document.querySelectorAll(sel).forEach(el => set.add(el)); } catch (_) {}
        }
        const arr = [...set].filter(el => {
            // De-dupe nested matches.
            let p = el.parentElement;
            while (p) {
                if (set.has(p) && p !== el) return false;
                p = p.parentElement;
            }
            return true;
        });

        const items = [];
        const seenMids = new Set();
        for (const el of arr) {
            const mid = extractMid(el);
            if (!mid) continue;            // service / date divider — skip
            if (seenMids.has(mid)) continue; // K and Z builds sometimes both match
            const text = extractText(el);
            if (!text) continue;            // voice / video / sticker / GIF — no text container
            seenMids.add(mid);
            items.push({ el, mid, text, time: extractTime(el) });
        }

        // Newest first by Telegram message ID.
        items.sort((a, b) => b.mid - a.mid);
        return items;
    }

    /* ==========================================================
       Show-more / "Развернуть" expander — clicked before each scan
       so long posts (> ~500 chars) reveal their full text instead
       of the truncated "Кр…" preview.
       ========================================================== */
    function clickIfShowMore(btn) {
        if (!btn) return false;
        const t = (btn.textContent || '').trim().toLowerCase();
        const looksLike = /^(show\s+more|показать\s+ещё|показать\s+больше|показать\s+полностью|развернуть(\s+пост)?)\.?$/.test(t);
        const classHit = btn.classList.contains('show-more') || btn.classList.contains('show-more-button');
        if (!looksLike && !classHit) return false;
        try { btn.click(); return true; } catch (_) { return false; }
    }

    function expandAllShowMore() {
        let count = 0;
        document.querySelectorAll(
            '.show-more-button, .show-more, ' +
            '.bubble .translatable-message button, .Message .MessageText button'
        ).forEach(btn => { if (clickIfShowMore(btn)) count++; });
        return count;
    }

    /* ==========================================================
       Telegram media silencer — while our panel is open, every
       <audio>/<video> on the page is paused proactively. This kills
       the "channel voice message blasts at 100% volume the second
       you click the extension icon" bug regardless of which
       Telegram code path triggered the play.
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
        silencerTimer = setInterval(silenceMediaOnce, 800);
    }
    function stopSilencer() {
        if (silencerTimer) { clearInterval(silencerTimer); silencerTimer = 0; }
    }

    /* ==========================================================
       Render
       ========================================================== */
    let currentPosts = [];
    let renderInFlight = false;

    async function render() {
        if (renderInFlight) return;
        renderInFlight = true;
        try {
            const expanded = expandAllShowMore();
            if (expanded > 0) {
                // Wait for Telegram to fetch and paint the full text.
                await new Promise(r => setTimeout(r, 600));
                silenceMediaOnce();
            }
            currentPosts = findMessages();

            $count.textContent = currentPosts.length;

            if (currentPosts.length === 0) {
                $list.innerHTML = `
                    <div class="tge-empty">
                        No text messages found.<br><br>
                        Open the chat or channel, scroll until the posts you need
                        are on screen, then hit <b>↻</b>.<br><br>
                        <small style="color:#666">Telegram only renders visible
                        messages — scroll up/down to load older history.</small>
                    </div>`;
                return;
            }

            const frag = document.createDocumentFragment();
            currentPosts.forEach((p, i) => {
                const item = document.createElement('div');
                item.className = 'tge-item';

                const meta = document.createElement('div');
                meta.className = 'tge-item-meta';
                const left = document.createElement('span');
                left.textContent = `#${i + 1}${p.time ? ' · ' + p.time : ''}`;
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
        } finally {
            renderInFlight = false;
        }
    }

    /* ==========================================================
       Top-bar actions
       ========================================================== */
    $refresh.addEventListener('click', () => render());

    $copyAll.addEventListener('click', async () => {
        if (!currentPosts.length) return;
        const text = serializeAll();
        const ok = await writeClipboard(text);
        $copyAll.textContent = ok ? '✓ Copied' : '✗ Failed';
        setTimeout(() => { $copyAll.textContent = 'Copy all'; }, 1000);
    });

    $export.addEventListener('click', () => {
        if (!currentPosts.length) return;
        const text = serializeAll();
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `tg-posts-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    function serializeAll() {
        return currentPosts
            .map((p, i) => `--- #${i + 1}${p.time ? ' · ' + p.time : ''} ---\n${p.text}`)
            .join('\n\n');
    }

    $close.addEventListener('click', closePanel);

    function openPanel() {
        panel.classList.add('open');
        toggleBtn.classList.add('active');
        toggleBtn.textContent = '✕';
        startSilencer();
        // Let the slide-in animation start before scanning, so a
        // fresh layout pass runs once and not in the middle of our DOM work.
        setTimeout(render, 80);
    }
    function closePanel() {
        panel.classList.remove('open');
        toggleBtn.classList.remove('active');
        toggleBtn.textContent = '📋';
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
       Auto-refresh observer.  Mutations from inside our own panel
       are ignored, otherwise rendering would loop on itself.
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
        '%c[Telegram Text Extractor v1.0.2]%c loaded.',
        'color:#2481cc;font-weight:bold;font-size:14px',
        'color:inherit'
    );
})();
