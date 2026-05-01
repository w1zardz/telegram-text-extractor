# Telegram Text Extractor — Copy text from Telegram channels (even when copying is disabled)

> **Browser extension that lets you copy text from Telegram Web channels and groups, including channels and groups where the owner has disabled copying / forwarding / saving content.** Works with `web.telegram.org` (K, A and Z versions). Per-message copy, copy-all, export every visible post to a `.txt` file. **Manifest V3.** No data leaves your browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green.svg)](manifest.json)
[![Works on](https://img.shields.io/badge/Works%20on-web.telegram.org-2481cc.svg)](https://web.telegram.org)
[![Chrome / Edge / Brave / Opera](https://img.shields.io/badge/Browsers-Chrome%20%7C%20Edge%20%7C%20Brave%20%7C%20Opera-orange.svg)](#installation)

If you have ever seen a Telegram channel with **"Copying is disabled"**, **"This message can't be copied"**, **"Saving content is disabled"**, or just discovered that text selection in Telegram Web is broken — this extension fixes that. It opens a side panel that lists every text post currently rendered on the page and gives you a normal **Copy** button on each one, plus **Copy all** and **Export to `.txt`**.

> ⚠️ **Use responsibly.** This is a personal tool for reading content you already have legitimate access to. Respect the copyright, privacy, and terms of the channels you read.

---

## Why this exists

Telegram channel owners can flip a switch called **"Restrict saving content"** which:

- disables text selection in the channel
- removes the **Copy** entry from the right-click menu
- blocks `Ctrl+C` / `Cmd+C`
- blocks forwarding messages out of the channel

That setting is enforced **client-side** in the Telegram Web UI. The text is still sitting in your browser's DOM — the UI just refuses to let you select it. This extension reads the text directly from the DOM, exposes it in its own panel where selection is not blocked, and gives you a real Copy button.

---

## Features

- 📋 **Copy text from Telegram Web channels even when copy is disabled**
- 📜 **Bulk copy** — every visible message in one click, separated by headers
- 💾 **Export to `.txt`** — timestamped filename, UTF-8
- 🎯 **Jump to message** — scroll back to the original post in the chat
- 🆕 **Newest first** — most recent posts at the top of the panel, no manual sort
- 🔄 **Auto-rescan** — as you scroll Telegram lazy-loads new messages, the panel refreshes automatically
- 🌐 **Works on all Telegram Web variants** — `web.telegram.org/k/`, `/a/`, `/z/` and the legacy build
- 🛡️ **Privacy-first** — 100% local, no network calls, no analytics, no tracking, no remote config
- 🪶 **Tiny** — ~14 KB total, vanilla JS, zero dependencies, zero external scripts
- 🌗 **Dark UI** that doesn't fight Telegram's theme
- ⚡ **Manifest V3** — runs on modern Chrome / Edge / Brave / Opera / Vivaldi / Arc

---

## Installation

### Option A — load unpacked (recommended for now)

1. **Download** this repo as ZIP and unzip — or `git clone https://github.com/w1zardz/telegram-text-extractor.git`
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`, `opera://extensions`, `arc://extensions`)
3. Toggle **Developer mode** on (top-right)
4. Click **Load unpacked**
5. Select the `telegram-text-extractor` folder
6. Open [web.telegram.org](https://web.telegram.org). Either click the **📋** button in the bottom-right corner, or click the extension's icon in the browser toolbar — both toggle the panel on the current tab.

### Option B — Firefox

Firefox MV3 support is in progress on a feature branch. For now use the userscript fallback in [`docs/userscript.user.js`](docs/userscript.user.js) with Tampermonkey or Violentmonkey.

---

## Usage

1. Open a Telegram channel or group on `web.telegram.org`.
2. Scroll until the messages you want are on screen (Telegram only renders visible messages — older history loads as you scroll up).
3. Click the floating **📋** button in the bottom-right.
4. The panel slides in. Click **↻** to scan, then either:
   - press **📋 Copy** on a single post,
   - **Copy all** to grab everything visible,
   - or **⬇ .txt** to download a `tg-posts-YYYY-MM-DD-HH-MM.txt` file.

To grab a long thread, just scroll up slowly with the panel open — new posts are picked up automatically as Telegram renders them.

---

## How it works (technical)

Telegram Web blocks copying with three layers of CSS / JS:

1. `user-select: none` on every message bubble.
2. A `copy` event listener that calls `e.preventDefault()`.
3. A `contextmenu` listener that swallows the right-click before the browser shows it.

But the message text is still **plain DOM** — the page isn't using a canvas or a screenshot trick. This extension:

- queries every rendered bubble using selectors that cover the K, A and Z builds (`[data-mid]`, `[data-message-id]`, `.Message`, `.bubble`, `[id^="message-"]`),
- de-duplicates nested matches (so a wrapper isn't counted twice with its child),
- strips noise nodes (timestamps, reactions, view counts, reply markup, ripple effects),
- extracts `innerText` and renders it inside the extension's own panel where `user-select` is forced back on,
- writes to the clipboard via `navigator.clipboard.writeText()` — the extension has the `clipboardWrite` permission, so this works regardless of the page's `copy` listener.

A `MutationObserver` keeps the panel in sync as Telegram virtualizes the message list.

---

## Permissions justification

| Permission | Why |
| --- | --- |
| `clipboardWrite` | To put extracted text on the clipboard. |
| `activeTab` | So the popup can wake the panel on the current Telegram tab. |
| `scripting` | Reserved for forced re-injection if the content script needs to be reloaded into a long-running tab. |
| `host_permissions: https://web.telegram.org/*` | Scopes the extension to Telegram Web only — it does **not** run anywhere else on the internet. |

The extension makes **zero network requests**. You can verify this in DevTools → Network with the extension active.

---

## FAQ

### Does this work for channels where the owner disabled copying?
Yes — that is exactly what it is built for. As long as the message is visible on your screen in Telegram Web, you can copy it.

### Does it work on the Telegram desktop / mobile apps?
No — the desktop and mobile apps render text in native code, not in a DOM. Use Telegram **Web** (`web.telegram.org`) in your browser.

### Will the channel owner see that I copied something?
No. Everything happens in your local browser. There is no server, no analytics, no telemetry, nothing.

### Can it download photos / videos / voice messages?
No. This is a **text** extractor only. There are other tools for media.

### Will it bypass Telegram's actual server-side restrictions (private channels you can't join)?
No. If you can't see the messages in Telegram Web, the extension can't see them either. It only reads what is already on your screen.

### Why a browser extension and not a Tampermonkey userscript?
The script is also available as a userscript ([`docs/userscript.user.js`](docs/userscript.user.js)), but as a real extension it loads automatically, has its own toolbar icon, doesn't require Tampermonkey/Violentmonkey, and can use the proper `clipboardWrite` permission instead of relying on `GM_setClipboard`.

### Is this against Telegram's ToS?
The extension does not interact with Telegram's API at all. It only reads the DOM of a page that is already loaded in your browser — the same data your eyes are reading. That said, the Telegram channel author explicitly asked you not to redistribute their content; respect that. **This tool is for personal note-taking, archiving messages you already have access to, and accessibility (screen-readers, translation tools, etc).**

---

## Roadmap

- [ ] Firefox MV3 packaging
- [ ] Markdown export (preserve bold / italic / links / code)
- [ ] JSON export with sender, timestamp, message ID
- [ ] Auto-scroll mode that walks the entire channel until the top
- [ ] Filter / search inside the panel
- [ ] Per-channel saved exports

PRs welcome.

---

## Search keywords

Stuff people actually google when they need this — listed so the right people find this repo.

**English** — copy text from Telegram channel, copy text from Telegram protected channel, copy disabled Telegram channel, Telegram restrict saving content, Telegram copy not working, copy from Telegram web, Telegram channel copy text disabled, telegram disable copy bypass, telegram protected content extractor, telegram web text selection blocked, save content disabled telegram, telegram cant select text, telegram cant copy paste, telegram copy paste not working, export telegram channel posts, telegram channel scraper text, telegram web extractor, telegram bulk copy messages, telegram chat exporter, telegram message saver, telegram channel archiver, copy locked telegram message, telegram channel without copy restriction, copy from restricted telegram channel chrome extension, telegram copy chrome extension, telegram chrome extension copy text, telegram chrome plugin copy.

**Русский** — копировать текст из закрытого телеграм канала, копирование запрещено в телеграмм, как скопировать текст в телеграм если запрещено, защита от копирования в телеграм обойти, телеграм веб не копирует текст, расширение для копирования текста из телеграм, выгрузить посты из канала телеграм, скачать сообщения из телеграм канала, как скопировать сообщение в телеграм если копирование отключено, телеграм запрет на копирование, обход запрета копирования в телеграм, копирование контента телеграм отключено, выгрузка постов канала, экспорт сообщений из телеграм веб, как сохранить пост из канала телеграм, выкачать текст канала, защищённый канал копирование, копировать из приватного канала, telegram копировать запрещено, telegram скопировать текст канал, скрипт копирования телеграм, юзерскрипт телеграм копирование, расширение хром телеграм копирование, обход защиты копирования телеграм веб, копирование закрытый канал, скопировать пост закрытого канала, как скопировать пост в телеграм веб, выгрузить чат телеграм текстом.

**Українською** — копіювати текст із закритого телеграм каналу, обхід заборони копіювання в телеграмі, як скопіювати повідомлення з телеграм каналу, експорт постів телеграм каналу.

---

## Related projects

If this extension doesn't fit your use-case, you might want one of these:

- [`telegram-export`](https://github.com/expectocode/telegram-export) — full archive of a chat using the Telegram API (requires API hash).
- [Telegram Desktop "Export chat history"](https://telegram.org/blog/export-and-more) — official desktop-only feature, doesn't work on protected channels either.
- Userscripts in the same niche: search GitHub for `tampermonkey telegram copy`.

This extension differs from the above by being **DOM-level**, **API-free**, **install-free** (no API hash, no phone, no login flow), and specifically focused on **channels with copy restrictions**.

---

## License

[MIT](LICENSE) — do whatever you want, no warranty.

## Credits

Built by [@w1zardz](https://github.com/w1zardz). If this saved you 30 minutes, drop a ⭐ on the repo so other people stuck on the same problem can find it.
