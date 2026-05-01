/* Telegram Text Extractor — background service worker.
 *
 * Toggles the in-page panel directly when the toolbar icon is clicked,
 * so we never open a separate popup window. Opening a popup makes the
 * Telegram tab briefly lose focus, and when the popup closes the tab
 * resumes any visible media (videos / voice messages) that Telegram
 * had paused — that was the mystery "channel sound on click" bug.
 */

const TG_URL = /^https:\/\/web\.telegram\.org\//;

chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || !tab.id) return;

    if (!TG_URL.test(tab.url || '')) {
        await chrome.tabs.create({ url: 'https://web.telegram.org/' });
        return;
    }

    try {
        await chrome.tabs.sendMessage(tab.id, { type: 'tge-toggle' });
    } catch (e) {
        // Content script not loaded yet (e.g. tab opened before the
        // extension was installed). Inject it on demand, then retry.
        try {
            await chrome.scripting.insertCSS({
                target: { tabId: tab.id },
                files: ['content.css']
            });
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
            });
            await chrome.tabs.sendMessage(tab.id, { type: 'tge-toggle' });
        } catch (_) {
            // Tab is on an internal chrome:// page or similar — ignore.
        }
    }
});
