document.getElementById('open').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    if (!/^https:\/\/web\.telegram\.org\//.test(tab.url || '')) {
        await chrome.tabs.create({ url: 'https://web.telegram.org/' });
        return;
    }
    try {
        await chrome.tabs.sendMessage(tab.id, { type: 'tge-toggle' });
        window.close();
    } catch (e) {
        await chrome.tabs.reload(tab.id);
    }
});
