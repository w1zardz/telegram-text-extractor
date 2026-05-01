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
       from leaking to Telegram's global "copy is disabled"
       handler, which otherwise plays its deny-toast sound.
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
    document.addEventListener('cut',  swallow, true);
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
       Message discovery — multi-selector strategy
       Covers all known Telegram Web variants (K, A, Z, legacy).
       ========================================================== */
    const MSG_SELECTORS = [
        '[data-mid]',
        '[data-message-id]',
        '.Message',
        '.bubble',
        '[id^="message-"]'
    ];

    function findMessages() {
        const set = new Set();
        for (const sel of MSG_SELECTORS) {
            try {
                document.querySelectorAll(sel).forEach(el => set.add(el));
            } catch (_) {}
        }

        const arr = [...set].filter(el => {
            let p = el.parentElement;
            while (p) {
                if (set.has(p) && p !== el) return false;
                p = p.parentElement;
            }
            return true;
        }).filter(el => extractText(el).length > 0);

        arr.sort((a, b) =>
            (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1
        );
        return arr;
    }

    function extractText(el) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll([
            '.time', '.time-inner', '.MessageMeta', '.message-time',
            '.reactions', '.Reactions', '.ReactionStaticEmoji',
            '.post-views', '.views', '.message-views',
            '.edited', '.is-edited',
            '.reply-markup', '.RippleEffect', '.ripple-container',
            'button', '.btn-icon', '.Button',
            '.tge-copy-btn'
        ].join(',')).forEach(n => n.remove());
        return (clone.innerText || clone.textContent || '')
            .replace(/ /g, ' ')
            .replace(/\s+\n/g, '\n')
            .trim();
    }

    function extractTime(el) {
        const t = el.querySelector('.time, .time-inner, .MessageMeta time, .message-time');
        return t ? t.innerText.trim().split('\n')[0] : '';
    }

    /* ==========================================================
       Render
       ========================================================== */
    let currentPosts = [];

    function render() {
        const messages = findMessages();
        currentPosts = messages
            .map(el => ({ el, text: extractText(el), time: extractTime(el) }))
            .filter(p => p.text.length > 0);

        $count.textContent = currentPosts.length;

        if (currentPosts.length === 0) {
            $list.innerHTML = `
                <div class="tge-empty">
                    No text messages found.<br><br>
                    Open the chat or channel, scroll until the posts you need are
                    on screen, then hit <b>↻</b>.<br><br>
                    <small style="color:#666">Telegram only renders visible messages —
                    scroll up/down to load older history.</small>
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
            jumpBtn.className = 'tge-jump';
            jumpBtn.textContent = '→ Jump';
            const copyBtn = document.createElement('button');
            copyBtn.className = 'tge-copy';
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
    $refresh.addEventListener('click', render);

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
        render();
    }
    function closePanel() {
        panel.classList.remove('open');
        toggleBtn.classList.remove('active');
        toggleBtn.textContent = '📋';
    }
    toggleBtn.addEventListener('click', () => {
        panel.classList.contains('open') ? closePanel() : openPanel();
    });

    /* Open the panel when the user clicks the toolbar icon (popup falls back here). */
    chrome.runtime?.onMessage?.addListener((msg) => {
        if (msg && msg.type === 'tge-toggle') {
            panel.classList.contains('open') ? closePanel() : openPanel();
        }
    });

    /* ==========================================================
       Auto-refresh while panel is open (Telegram virtualizes the DOM —
       scrolling reveals new messages).
       ========================================================== */
    let renderDebounce = 0;
    const observer = new MutationObserver(() => {
        if (!panel.classList.contains('open')) return;
        clearTimeout(renderDebounce);
        renderDebounce = setTimeout(render, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    /* ==========================================================
       Clipboard write — extension has clipboardWrite permission, so
       navigator.clipboard works even on pages that block selection.
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
        '%c[Telegram Text Extractor]%c loaded. Click the 📋 button bottom-right.',
        'color:#2481cc;font-weight:bold;font-size:14px',
        'color:inherit'
    );
})();
