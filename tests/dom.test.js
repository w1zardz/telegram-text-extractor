/* Run with Node's test runner and Playwright available in NODE_PATH.
 * Fixtures follow Telegram Web A 28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80:
 * Message.tsx, MessageList.tsx, MessageListContent.tsx, MessageMeta.tsx.
 * They execute the unmodified content script in an actual browser DOM.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const offset = 0x100000000;
let browser;

before(async () => {
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const executablePath = process.env.TGE_BROWSER_EXECUTABLE || (fs.existsSync(macChrome) ? macChrome : undefined);
    browser = await chromium.launch({ headless: true, executablePath });
});
after(async () => { await browser?.close(); });

const message = (id, text, extra = '') => `<div class="Message message-list-item" id="message-${id}" data-message-id="${id}">
    <div class="message-content ${extra}"><div class="text-content">${text}<span class="MessageMeta">Edited · <a href="https://example.test/meta">42 views</a> <span class="message-time">11:21</span></span></div></div>
    <div class="bottom-marker" data-message-id="${id}"></div></div>`;
const aHistory = (body, label = 'May 1, 2022') => `<div class="MessageList custom-scroll" style="height:200px;overflow-y:auto">
    <div class="message-date-group"><div class="sticky-date">${label}</div>${body}</div><div style="height:600px"></div></div>`;
const kHistory = body => `<div class="chat tabs-tab"><div class="bubbles"><div class="scrollable scrollable-y bubbles-scrollable" style="height:200px;overflow-y:auto"><div class="bubbles-inner">${body}</div><div style="height:600px"></div></div></div></div>`;

async function boot(client, hash, html, initial = {}, lang = 'en', beforeOpen) {
    const context = await browser.newContext({ locale: lang, timezoneId: 'UTC' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"></head><body>${html}</body></html>` }));
    await page.goto(`https://web.telegram.org/${client}/#${hash}`);
    await page.evaluate(initial => {
        window.testStorage = structuredClone(initial);
        window.chrome.storage = { local: {
            get: async key => ({ [key]: window.testStorage[key] }),
            set: async values => Object.assign(window.testStorage, structuredClone(values)),
            remove: async key => { delete window.testStorage[key]; }
        } };
        window.chrome.runtime = { onMessage: { addListener() {} } };
        window.testDownloads = [];
        const urls = new Map();
        URL.createObjectURL = blob => { const url = `blob:test-${urls.size}`; urls.set(url, blob); return url; };
        URL.revokeObjectURL = url => urls.delete(url);
        const originalClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            if (this.download) urls.get(this.href)?.text().then(text => window.testDownloads.push({ name: this.download, text }));
            else originalClick.call(this);
        };
        Element.prototype.scrollIntoView = function () { window.testJump = this.id || this.dataset.mid; };
        document.querySelector('.MessageList')?.scrollTo(0, 400);
    }, initial);
    await page.addScriptTag({ path: path.join(root, 'content.js') });
    if (beforeOpen) await page.evaluate(beforeOpen);
    await page.locator('#tge-toggle').click();
    await page.waitForTimeout(150);
    return { page, context, errors, key: `tge:${hash}` };
}

async function saved(fixture, count) {
    await fixture.page.waitForFunction(({ key, count }) => window.testStorage[key]?.length === count,
        { key: fixture.key, count }, { timeout: 6000 });
    return fixture.page.evaluate(key => window.testStorage[key], fixture.key);
}

test('A reads only original message bodies, keeps line breaks, links, stable IDs and private source URLs', async () => {
    const hidden = `<div style="display:none">${aHistory(message(999, 'Cached other chat'))}</div>`;
    const fixture = await boot('a', '-1001629147115_42', hidden + aHistory(
        message(7101, 'First line<br>Second <a href="https://example.test/source">linked line</a><div class="translation-animation">Duplicate animation text</div><div class="Reactions">99 likes</div>')
        + message(7100, 'Forwarded caption', 'is-forwarded')
        + `<div class="Message ActionMessage" data-message-id="7099"><div class="text-content">Service event</div></div>`
        + message('1.5', 'Unsent message') + message(-1, 'Local message')
        + `<div class="Message" id="message-7098"><div class="RepliedMessage">Reply preview</div><div class="text-content">ID fallback only</div></div>`
        + message(7097, '')
    ));
    try {
        const posts = await saved(fixture, 3);
        assert.deepEqual(posts.map(p => p.mid).sort(), [7098, 7100, 7101]);
        const post = posts.find(p => p.mid === 7101);
        assert.equal(post.text, 'First line\nSecond linked line');
        assert.equal(post.source_url, 'https://t.me/c/1629147115/7101');
        assert.equal(post.ts, 0);
        assert.equal(post.date, '2022-05-01');
        assert.equal(post.time, '11:21');
        assert.deepEqual(post.links, ['https://example.test/source']);
        assert.equal(post.forwarded, false);
        assert.equal(posts.find(p => p.mid === 7100).forwarded, true);
        await fixture.page.locator('#tge-export-json').click();
        await fixture.page.waitForFunction(() => window.testDownloads.length === 1);
        const exported = JSON.parse(await fixture.page.evaluate(() => window.testDownloads[0].text));
        assert.equal(exported.chat, '-1001629147115_42');
        assert.equal(exported.posts.length, 3);
        assert.equal(exported.posts[0].mid, 7101);
        assert.deepEqual(fixture.errors, []);
    } finally { await fixture.context.close(); }
});

test('A supports Russian displayed dates and does not fabricate a basic-group source URL', async () => {
    const fixture = await boot('a', '-123', aHistory(message(55, 'Текст сообщения'), '1 мая 2022 г.'), {}, 'ru');
    try {
        const [post] = await saved(fixture, 1);
        assert.equal(post.date, '2022-05-01');
        assert.equal(post.source_url, null);
        assert.equal(post.ts, 0);
        await fixture.page.locator('#tge-until').fill('2023-01-01');
        await fixture.page.locator('#tge-auto').click();
        await fixture.page.waitForFunction(() => document.getElementById('tge-status').textContent.includes('Reached 2023-01-01'));
        assert.equal(await fixture.page.locator('#tge-auto').textContent(), '▲ Auto-collect');
        assert.deepEqual(fixture.errors, []);
    } finally { await fixture.context.close(); }
});

test('A preserves native emoji fallback alt text without importing ordinary image descriptions', async () => {
    const fixture = await boot('a', '-1001629147115', aHistory(
        message(25, 'Emoji <img class="emoji emoji-small" alt="🙂" src="./emoji.png"> end<img alt="Ordinary image description" src="./photo.png">')
        + message(24, '<img class="emoji" alt="😂" src="./emoji.png">')
    ));
    try {
        const posts = await saved(fixture, 2);
        assert.equal(posts.find(p => p.mid === 25).text, 'Emoji 🙂 end');
        assert.equal(posts.find(p => p.mid === 24).text, '😂');
        assert.deepEqual(fixture.errors, []);
    } finally { await fixture.context.close(); }
});

test('A harvests newly prepended history using its own scroll container', async () => {
    const fixture = await boot('a', '-1001629147115', aHistory(message(7101, 'Newest body')));
    try {
        await saved(fixture, 1);
        await fixture.page.evaluate(() => {
            const sc = document.querySelector('.MessageList');
            sc.scrollTop = 400;
            sc.addEventListener('scroll', () => {
                if (sc.scrollTop !== 0 || document.getElementById('message-7000')) return;
                sc.insertAdjacentHTML('afterbegin', '<div class="message-date-group"><div class="sticky-date">April 30, 2022</div><div class="Message" id="message-7000" data-message-id="7000"><div class="text-content" style="height:400px">Older body</div></div></div>');
            });
        });
        await fixture.page.locator('#tge-auto').click();
        const posts = await saved(fixture, 2);
        assert.equal(posts.find(p => p.mid === 7000).text, 'Older body');
        assert.equal(posts.find(p => p.mid === 7000).date, '2022-04-30');
        await fixture.page.locator('#tge-auto').click();
        assert.deepEqual(fixture.errors, []);
    } finally { await fixture.context.close(); }
});

test('A refuses a date cutoff when the displayed date cannot be interpreted', async () => {
    const fixture = await boot('a', '-1001629147115', aHistory(message(22, 'Undated body'), 'Unknown calendar label'));
    try {
        const [post] = await saved(fixture, 1);
        assert.equal(post.date, 'Unknown calendar label');
        await fixture.page.locator('#tge-until').fill('2023-01-01');
        await fixture.page.locator('#tge-auto').click();
        await fixture.page.waitForFunction(() => document.getElementById('tge-status').textContent.includes('Date unavailable'));
        assert.equal(await fixture.page.locator('#tge-auto').textContent(), '▲ Auto-collect');
        assert.deepEqual(fixture.errors, []);
    } finally { await fixture.context.close(); }
});

test('A unknown oldest loaded day stops cutoff even when visible and cached dates are known', async () => {
    const mixed = `<div class="MessageList custom-scroll" style="height:200px;overflow-y:auto">
        <div class="message-date-group"><div class="sticky-date">Unknown older day</div>${message(20, 'Older frontier')}</div>
        <div class="message-date-group"><div class="sticky-date">May 1, 2022</div>${message(21, 'Recognized newer day')}</div><div style="height:600px"></div></div>`;
    const fixture = await boot('a', '-1001629147115', mixed, {
        'tge:-1001629147115': [{ mid: 10, text: 'Historical cache outside the loaded frontier', date: '2018-01-01', ts: 0 }]
    });
    try {
        await saved(fixture, 3);
        const before = await fixture.page.locator('.MessageList').evaluate(el => el.scrollTop);
        await fixture.page.locator('#tge-until').fill('2020-01-01');
        await fixture.page.locator('#tge-auto').click();
        await fixture.page.waitForFunction(() => document.getElementById('tge-status').textContent.includes('Date unavailable at the oldest loaded post'));
        assert.equal(await fixture.page.locator('#tge-auto').textContent(), '▲ Auto-collect');
        assert.equal(await fixture.page.locator('.MessageList').evaluate(el => el.scrollTop), before);
        assert.deepEqual(fixture.errors, []);
    } finally { await fixture.context.close(); }
});

test('K retains expansion, decodes channel IDs, migrates saved IDs and jumps to packed DOM IDs', async () => {
    const raw = offset + 7101;
    const html = kHistory(`<div class="bubbles-date-group"><div class="bubbles-date-group__title">Today</div>
        <div class="bubble" id="k-post" data-mid="${raw}" data-timestamp="1651363200"><div class="reply">Reply noise</div><div class="translatable-message">Short<button class="show-more">Show more</button></div><span class="time-inner">17:20</span></div>
        <div class="bubble service" data-mid="${offset + 7000}"><div class="translatable-message">Service</div></div>
        <div class="bubble" data-mid="${offset * 2 + 1}"><div class="translatable-message">Ephemeral</div></div>
        </div>`);
    const initial = { 'tge:-1629147115': [{ mid: raw, text: 'Short', date: 'Today' }, { mid: offset + 6999, text: 'Previously kept body', date: '2022-04-30' }] };
    const fixture = await boot('k', '-1629147115', html, initial, 'en', () => {
        document.querySelector('.show-more').onclick = () => {
            document.querySelector('.translatable-message').innerHTML = 'Expanded first line<br>Second <a href="https://example.test/k">link</a>';
        };
    });
    try {
        await fixture.page.waitForFunction(key => window.testStorage[key]?.some(p => p.mid === 7101 && p.text.includes('Expanded')), fixture.key, { timeout: 6000 });
        const posts = await saved(fixture, 2);
        const post = posts.find(p => p.mid === 7101);
        assert.equal(post.dom_mid, raw);
        assert.equal(post.text, 'Expanded first line\nSecond link');
        assert.equal(post.ts, 1651363200);
        assert.equal(post.date, '2022-05-01');
        assert.equal(post.source_url, 'https://t.me/c/1629147115/7101');
        assert.deepEqual(post.links, ['https://example.test/k']);
        assert.ok(posts.some(p => p.mid === 6999));
        await fixture.page.locator('.tge-item-actions button').first().click();
        assert.equal(await fixture.page.evaluate(() => window.testJump), 'k-post');
        assert.deepEqual(fixture.errors, []);
    } finally { await fixture.context.close(); }
});

test('K ignores a hidden cached chat and keeps current-channel provenance and expansion scoped', async () => {
    const hidden = `<div style="display:none">${kHistory(`<div class="bubbles-date-group"><div class="bubbles-date-group__title">Today</div><div class="bubble" data-mid="${offset + 99}" data-timestamp="1651363200"><div class="translatable-message">Foreign cached chat<button class="show-more" id="hidden-expand">Show more</button></div></div></div>`)}</div>`;
    const visible = kHistory(`<div class="bubbles-date-group"><div class="bubbles-date-group__title">Today</div><div class="bubble" data-mid="${offset + 7101}" data-timestamp="1651363200"><div class="translatable-message">Current channel body</div></div></div>`);
    const fixture = await boot('k', '-1629147115', hidden + visible, {}, 'en', () => {
        document.getElementById('hidden-expand').onclick = () => { window.testHiddenExpanded = true; };
    });
    try {
        const posts = await saved(fixture, 1);
        assert.equal(posts[0].mid, 7101);
        assert.equal(posts[0].text, 'Current channel body');
        assert.equal(posts[0].source_url, 'https://t.me/c/1629147115/7101');
        assert.equal(await fixture.page.evaluate(() => !!window.testHiddenExpanded), false);
        assert.deepEqual(fixture.errors, []);
    } finally { await fixture.context.close(); }
});

test('Unsupported client banner states separate logins; version and permissions stay consistent', async () => {
    const fixture = await boot('z', '-123', '<div>No supported history</div>');
    try {
        const banner = await fixture.page.locator('#tge-list').textContent();
        assert.match(banner, /Web K or A/);
        assert.match(banner, /separate logins/);
        assert.doesNotMatch(banner, /session is shared|session shared/i);
        assert.deepEqual(await fixture.page.evaluate(() => window.testStorage), {});
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
        assert.equal(manifest.version, '1.1.1');
        assert.match(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), /const VERSION = '1\.1\.1'/);
        assert.deepEqual(manifest.permissions, ['clipboardWrite', 'storage', 'unlimitedStorage', 'activeTab', 'scripting']);
        assert.deepEqual(fixture.errors, []);
    } finally { await fixture.context.close(); }
});
