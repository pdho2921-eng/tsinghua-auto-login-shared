/* Real Mac installer + isolated Chromium. Only temporary homes, virtual account
   metadata and a harmless work page are used; no Keychain credentials are read. */
const {chromium} = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const {extensionId} = require('../native/config.json');
const targetVersion = require('../extension/manifest.json').version;
const previous = process.env.THU_OLD_MAC_ARCHIVE || path.join(root, 'build/upgrade-baseline/tsinghua-auto-login-shared-macos.zip');
const current = path.join(root, 'dist/tsinghua-auto-login-shared-macos.zip');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'thu-mac-upgrade-'));
const unpack = (archive, folder) => {
  execFileSync('/usr/bin/ditto', ['-x', '-k', archive, path.join(temp, folder)]);
  return path.join(temp, folder, '清华网站自动重登-共享试用版');
};
(async () => {
  let context;
  try {
    assert.ok(fs.existsSync(previous), 'Set THU_OLD_MAC_ARCHIVE to an actual previous Mac package');
    const oldPackage = unpack(previous, 'old'), newPackage = unpack(current, 'new');
    const oldVersion = JSON.parse(fs.readFileSync(path.join(oldPackage, 'extension/manifest.json'))).version;
    assert.notEqual(oldVersion, targetVersion);
    const home = path.join(temp, 'temporary-home');
    execFileSync(path.join(oldPackage, 'native/host'), ['--test-install', home, oldPackage]);
    const extension = path.join(home, 'Library/Application Support/TsinghuaAutoLoginShared/extension');
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {headless: true, channel: 'chromium',
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']});
    await context.route('https://**/*', route => route.abort());
    const manager = await context.newPage(); await manager.goto('chrome://extensions/');
    await manager.locator('#devMode').click();
    const cdp = await context.browser().newBrowserCDPSession();
    assert.equal((await cdp.send('Extensions.loadUnpacked', {path: extension})).id, extensionId);
    // Stop any automatically opened first-install options page before storing fixtures.
    for (const page of context.pages()) if (page.url().startsWith('chrome-extension://')) await page.close();
    const original = await context.newPage(); await original.goto(`chrome-extension://${extensionId}/preview.html`);
    assert.equal(await original.evaluate(() => chrome.runtime.getManifest().version), oldVersion);
    const expected = {username:'fixture-account', automatic:false, siteAutomatic:{learn:false, info:true, mails:false}};
    await original.evaluate(value => chrome.storage.local.set(value), expected);
    const work = await context.newPage(); await work.setContent('<input id="draft" value="unsaved fixture work">');
    execFileSync(path.join(newPackage, 'native/host'), ['--test-install', home, newPackage]);
    assert.equal(await work.locator('#draft').inputValue(), 'unsaved fixture work');
    await original.evaluate(() => chrome.runtime.reload()).catch(error => {
      if (!/closed|destroyed/i.test(error.message)) throw error;
    });
    // runtime.reload returns before the new extension is ready; inspect a page
    // after that transition instead of requiring an idle MV3 worker to wake.
    const probe = await context.newPage();
    for (let attempt = 0; ; attempt++) {
      try {
        await probe.goto(`chrome-extension://${extensionId}/preview.html`);
        assert.equal(await probe.evaluate(() => chrome.runtime.getManifest().version), targetVersion);
        break;
      } catch (error) { if (attempt >= 15) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal(await probe.evaluate(() => chrome.runtime.id), extensionId);
    assert.deepEqual(await probe.evaluate(() => chrome.storage.local.get(['username','automatic','siteAutomatic'])), expected);
    assert.equal(await work.locator('#draft').inputValue(), 'unsaved fixture work');
    console.log(`PASS actual Mac ${oldVersion} -> ${targetVersion} upgrade while Chromium stays open; reload keeps extension ID, account metadata, toggles and work page.`);
    // A user may previously have loaded the unpacked extension from Downloads.
    // Loading the same identity from the fixed path must not require uninstalling.
    const moved = await cdp.send('Extensions.loadUnpacked', {path: path.join(newPackage, 'extension')});
    assert.equal(moved.id, extensionId);
    const check = await context.newPage(); await check.goto(`chrome-extension://${extensionId}/preview.html`);
    assert.deepEqual(await check.evaluate(() => chrome.storage.local.get(['username','automatic','siteAutomatic'])), expected);
    console.log('PASS loading the same extension identity from another directory preserves browser settings without uninstalling (Chromium).');
  } finally { await context?.close(); fs.rmSync(temp, {recursive:true, force:true}); }
})().catch(error => {console.error(error); process.exitCode = 1;});
