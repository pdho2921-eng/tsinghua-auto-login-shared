/* Windows distribution presentation in isolated Chromium on the development host.
   This does not execute Windows programs or claim Edge integration. */
const {chromium} = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
const extension = process.env.THU_TEST_EXTENSION || path.join(root, 'build/windows/preview-payload/extension');
const {extensionId} = require('../native/config.json');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'thu-windows-page-'));
const output = path.join(root, 'build/windows/page-check'); fs.mkdirSync(output, {recursive: true});
(async () => {
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {headless: true, channel: 'chromium',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
    await context.route('https://**/*', route => route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    assert.equal(new URL(worker.url()).host, extensionId);
    await worker.evaluate(helperVersion => {
      chrome.runtime.connectNative = () => {
        let listener;
        return {onMessage: {addListener(fn) {listener = fn;}}, onDisconnect: {addListener() {}}, disconnect() {},
          postMessage(request) {
            if (request.op !== 'status') throw new Error('Presentation test must not use credentials');
            setTimeout(() => listener({protocol: 1, ok: true, version: helperVersion, accounts: {identity: {configured: false, username: ''}, mail: {configured: false, username: ''}}}), 10);
          }};
      };
    }, require('../native/windows/config.json').version);
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForFunction(() => document.getElementById('connection-indicator').textContent === '已连接');
    assert.equal(await page.locator('#connection-success').isVisible(), true);
    await page.locator('#check').click();
    await page.waitForFunction(() => !document.getElementById('connection-success').hidden);
    await page.locator('#install-help').evaluate(el => {el.open = true;});
    const text = await page.locator('body').innerText();
    assert.match(text, /Windows/); assert.match(text, /安装\.exe/); assert.doesNotMatch(text, /Mac|macOS|钥匙串|\.command/);
    assert.ok(text.includes(`扩展版本 ${require('../native/windows/config.json').extensionVersion}`));
    await page.setViewportSize({width: 1000, height: 1000});
    await page.screenshot({path: path.join(output, 'windows-settings.png'), fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path: path.join(output, 'windows-settings-narrow.png'), fullPage: true});
    await page.goto(`chrome-extension://${extensionId}/preview.html`);
    for (const value of ['keychain-locked', 'storage-error', 'helper-timeout']) {
      await page.locator('#scenario').selectOption(value);
      const text = await page.locator('body').innerText(); assert.doesNotMatch(text, /Mac|macOS|钥匙串|\.command/);
    }
    assert.deepEqual(errors, []);
    console.log('PASS Windows packaged UI: exact extension ID, OS copy, mock connection success, narrow layout and errors. Native Windows/Edge integration NOT tested.');
  } finally {
    await context?.close(); fs.rmSync(profile, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
