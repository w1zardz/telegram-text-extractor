// ==UserScript==
// @name         Telegram Web — Posts Extractor
// @namespace    https://github.com/w1zardz/telegram-text-extractor
// @version      3.0.0
// @description  Slide-in panel listing all currently rendered text posts on web.telegram.org. Per-post copy, copy-all, export .txt. Bypasses Telegram's selection/copy blockers entirely.
// @match        https://web.telegram.org/*
// @run-at       document-end
// @grant        GM_setClipboard
// @noframes
// @homepageURL  https://github.com/w1zardz/telegram-text-extractor
// @supportURL   https://github.com/w1zardz/telegram-text-extractor/issues
// ==/UserScript==

(function () {
    'use strict';

    const css = `
        #tge-toggle {
            position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
            width: 52px; height: 52px; border-radius: 50%; border: 0;
            background: #2481cc; color: #fff;
            font: 700 22px/1 -apple-system, "Segoe UI", Roboto, sans-serif;
            cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.45);
            transition: transform .15s, background .15s;
        }
        #tge-toggle:hover  { background: #1f74b8; transform: scale(1.08); }
        #tge-toggle.active { background: #d73a49; }

        #tge-panel {
            position: fixed; top: 0; right: 0; bottom: 0;
            width: 420px; max-width: 95vw; z-index: 2147483645;
            background: #1c1c1d; color: #e8e8e8;
            box-shadow: -4px 0 24px rgba(0,0,0,.5);
            display: flex; flex-direction: column;
            transform: translateX(100%); transition: transform .25s ease;
            font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        #tge-panel.open { transform: translateX(0); }

        .tge-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 14px; border-bottom: 1px solid #2c2c2e;
            background: #232324;
        }
        .tge-title { font-weight: 600; font-size: 14px; }
        .tge-actions { display: flex; gap: 6px; }
        .tge-actions button {
            background: #2c2c2e; color: #e8e8e8; border: 0; border-radius: 6px;
            padding: 6px 10px; font-size: 12px; cursor: pointer;
            transition: background .12s;
        }
        .tge-actions button:hover { background: #3a3a3c; }
        .tge-actions button.primary { background: #2481cc; }
        .tge-actions button.primary:hover { background: #1f74b8; }

        .tge-list { flex: 1; overflow-y: auto; padding: 8px; }
        .tge-list::-webkit-scrollbar { width: 8px; }
        .tge-list::-webkit-scrollbar-thumb { background: #3a3a3c; border-radius: 4px; }

        .tge-item {
            background: #262627; border-radius: 8px; padding: 10px 12px;
            margin-bottom: 8px; border: 1px solid #2c2c2e;
            transition: border-color .12s;
        }
        .tge-item:hover { border-color: #3a3a3c; }
        .tge-item-meta {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 6px; font-size: 11px; color: #888;
        }
        .tge-item-text {
            white-space: pre-wrap; word-break: break-word;
            color: #e8e8e8; font-size: 13px;
            user-select: text !important;
            -webkit-user-select: text !important;
        }
        .tge-item-actions { margin-top: 8px; display: flex; gap: 6px; }
        .tge-item-actions button {
            background: transparent; color: #2481cc; border: 1px solid #2481cc;
            border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer;
            transition: background .12s, color .12s;
        }
        .tge-item-actions button:hover { background: #2481cc; color: #fff; }
        .tge-item-actions button.ok { background: #2ea44f; color: #fff; border-color: #2ea44f; }

        .tge-empty {
            text-align: center; color: #888; padding: 40px 20px; font-size: 13px;
        }

        #tge-panel, #tge-panel * {
            user-select: text !important;
            -webkit-user-select: text !important;
        }
        #tge-panel button, #tge-panel button * {
            user-select: none !important;
            -webkit-user-select: none !important;
        }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    (document.head || document.documentElement).appendChild(styleEl);

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'tge-toggle';
    toggleBtn.textContent = '📋';
    toggleBtn.title = 'Show all text posts';
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
            <div class="tge-empty">Click ↻ Refresh to scan visible messages</div>
        </div>
    `;
    document.body.appendChild(panel);

    const $list    = panel.querySelector('#tge-list');
    const $count   = panel.querySelector('#tge-count');
    const $refresh = panel.querySelector('#tge-refresh');
    const $copyAll = panel.querySelector('#tge-copy-all');
    const $export  = panel.querySelector('#tge-export');
    const $close   = panel.querySelector('#tge-close');

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
            try { document.querySelectorAll(sel).forEach(el => set.add(el)); } catch (_) {}
        }
        const arr = [...set].filter(el => {
            let p = el.parentElement;
            while (p) { if (set.has(p) && p !== el) return false; p = p.parentElement; }
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
            .replace(/ /g, ' ')
            .replace(/\s+\n/g, '\n')
            .trim();
    }

    function extractTime(el) {
        const t = el.querySelector('.time, .time-inner, .MessageMeta time, .message-time');
        return t ? t.innerText.trim().split('\n')[0] : '';
    }

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
                    Open the chat or channel, scroll until the posts you need
                    are on screen, then hit ↻.<br><br>
                    <small style="color:#666">Telegram only renders visible messages —<br>
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

    $refresh.addEventListener('click', render);

    $copyAll.addEventListener('click', async () => {
        if (!currentPosts.length) return;
        const text = currentPosts
            .map((p, i) => `--- #${i + 1}${p.time ? ' · ' + p.time : ''} ---\n${p.text}`)
            .join('\n\n');
        const ok = await writeClipboard(text);
        $copyAll.textContent = ok ? '✓ Copied' : '✗ Failed';
        setTimeout(() => { $copyAll.textContent = 'Copy all'; }, 1000);
    });

    $export.addEventListener('click', () => {
        if (!currentPosts.length) return;
        const text = currentPosts
            .map((p, i) => `--- #${i + 1}${p.time ? ' · ' + p.time : ''} ---\n${p.text}`)
            .join('\n\n');
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `tg-posts-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    $close.addEventListener('click', closePanel);
    function openPanel()  { panel.classList.add('open'); toggleBtn.classList.add('active'); toggleBtn.textContent = '✕'; render(); }
    function closePanel() { panel.classList.remove('open'); toggleBtn.classList.remove('active'); toggleBtn.textContent = '📋'; }
    toggleBtn.addEventListener('click', () => {
        panel.classList.contains('open') ? closePanel() : openPanel();
    });

    let renderDebounce = 0;
    const observer = new MutationObserver(() => {
        if (!panel.classList.contains('open')) return;
        clearTimeout(renderDebounce);
        renderDebounce = setTimeout(render, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    async function writeClipboard(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_) {}
        try {
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(text, 'text');
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
        } catch (_) { return false; }
    }

    console.log(
        '%c[TG-Extractor v3]%c loaded. Click the 📋 button bottom-right.',
        'color:#2481cc;font-weight:bold;font-size:14px',
        'color:inherit'
    );
})();
