/* Real isolated Chromium; school URLs are fulfilled locally; native responses use virtual credentials. */
const {chromium} = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const {extensionId} = require('../native/config.json');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'thu-shared-browser-'));
const output = path.join(root, 'build/browser-check');
fs.mkdirSync(output, {recursive: true});
const FORM = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/fixture/0';
let mode = 'learn', submits = 0;
const fixture = () => `<!doctype html><meta charset="utf-8"><h1>${mode === 'mail' ? '学生邮箱' : '您即将登录 ' + (mode === 'info' ? '清华大学信息门户' : '网络学堂2018')}</h1>
${mode === 'challenge' ? '<p>请输入验证码</p>' : ''}
<form ${mode === 'mail' ? 'class="j-login-form"' : ''} action="${mode === 'mail' ? 'https://mails.tsinghua.edu.cn/coremail/index.jsp?cus=1' : mode === 'evil' ? 'https://evil.test/' : 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/check'}">
<input type="text" name="username"><input type="password" name="password">
${mode === 'mail' ? '<input type="hidden" name="domain" value="mails.tsinghua.edu.cn">' : ''}
<button type="button" onclick="window.submits=(window.submits||0)+1;document.getElementById('result').textContent='fixture submitted'">登录</button></form><p id="result"></p>`;
(async () => {
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {headless: true, channel: 'chromium',
      args: [`--disable-extensions-except=${path.join(root, 'extension')}`, `--load-extension=${path.join(root, 'extension')}`]});
    await context.route('https://**/*', route => {
      if (['id.tsinghua.edu.cn', 'mails.tsinghua.edu.cn'].includes(new URL(route.request().url()).hostname))
        return route.fulfill({contentType: 'text/html', body: fixture()});
      return route.abort();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    assert.equal(new URL(worker.url()).host, extensionId);
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForFunction(() => document.getElementById('connection-indicator').textContent !== '正在检查');
    assert.match(await page.locator('#connection-status').innerText(), /未连接|没有及时响应/);
    console.log('PASS: real extension loads and handles missing native helper');
    // Register a test-only, memory-backed host inside this disposable browser profile.
    const nativeDir = path.join(profile, 'NativeMessagingHosts'); fs.mkdirSync(nativeDir, {recursive: true});
    const wrapper = path.join(profile, 'memory-host');
    const shellQuote = s => `'${s.replaceAll("'", "'\"'\"'")}'`;
    fs.writeFileSync(wrapper, `#!/bin/sh\n[ "$1" = "chrome-extension://${extensionId}/" ] || exit 1\nexec ${shellQuote(path.join(root, 'build/host'))} --test-protocol\n`, {mode: 0o700});
    fs.writeFileSync(path.join(nativeDir, 'local.tsinghua_login_shared.json'), JSON.stringify({name: 'local.tsinghua_login_shared',
      description: 'Disposable test host', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`]}));
    await page.locator('#check').click();
    await page.waitForFunction(() => document.getElementById('connection-indicator').textContent === '已连接', null, {timeout: 15000});
    console.log('PASS: real browser-to-native pipe, extension origin and framed status response (memory-only vault)');
    await worker.evaluate(() => {
      globalThis.__testVault = {}; globalThis.__testRequests = []; globalThis.__testNativeError = null;
      chrome.runtime.connectNative = () => {
        let listener, disconnected = false;
        return {onMessage: {addListener(fn) {listener = fn;}}, onDisconnect: {addListener() {}},
          disconnect() {disconnected = true;}, postMessage(request) {
            const copy = structuredClone(request);
            __testRequests.push({op: copy.op, role: copy.role});
            queueMicrotask(() => {
              if (disconnected) return;
              let r;
              if (__testNativeError) r = {ok: false, error: __testNativeError};
              else if (copy.op === 'status') r = {ok: true, version: 'fixture', accounts: Object.fromEntries(['identity','mail'].map(role => [role, {configured: !!__testVault[role], username: __testVault[role]?.username || ''}]))};
              else if (copy.op === 'save') {__testVault[copy.role] = {username: copy.username, password: copy.password}; r = {ok: true};}
              else if (copy.op === 'delete') {delete __testVault[copy.role]; r = {ok: true};}
              else if (copy.op === 'get') r = __testVault[copy.role] ? {ok: true, ...__testVault[copy.role]} : {ok: false, error: 'not-found'};
              listener({...r, protocol: 1});
            });
          }};
      };
    });
    await page.locator('#check').click();
    await page.waitForFunction(() => document.getElementById('connection-indicator').textContent === '已连接');
    for (const [role, username] of [['identity', 'fixture-user'], ['mail', 'fixture-mail']]) {
      await page.locator(`#${role}-username`).fill(username);
      await page.locator(`#${role}-password`).fill('synthetic-browser-secret');
      await page.locator(`#${role}-form button[type=submit]`).click();
      await page.waitForFunction(r => document.getElementById(`${r}-result`).textContent.startsWith('已保存'), role);
      assert.equal(await page.locator(`#${role}-password`).inputValue(), '');
    }
    const storage = await worker.evaluate(async () => ({local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null)}));
    assert.ok(!JSON.stringify(storage).includes('synthetic-browser-secret'));
    assert.equal(storage.local.automatic, true);
    console.log('PASS: settings save separate accounts, clear password boxes and never persist secrets');
    await page.setViewportSize({width: 1000, height: 1100});
    await page.screenshot({path: path.join(output, 'settings-desktop.png'), fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path: path.join(output, 'settings-mobile.png'), fullPage: true});
    console.log('PASS: desktop and narrow settings layout');

    const login = await context.newPage();
    for (const site of ['learn', 'info', 'mail']) {
      mode = site;
      await worker.evaluate(async () => {await chrome.storage.session.clear(); await chrome.storage.local.set({retryAfter: 0});});
      await login.goto(site === 'mail' ? 'https://mails.tsinghua.edu.cn/' : FORM);
      await login.waitForFunction(() => window.submits === 1);
      assert.equal(await login.locator('input[type=text]').inputValue(), site === 'mail' ? 'fixture-mail' : 'fixture-user');
      assert.equal(await login.locator('input[type=password]').inputValue(), 'synthetic-browser-secret');
      await login.waitForTimeout(1500);
      assert.equal(await login.evaluate(() => window.submits), 1);
      submits++;
    }
    console.log(`PASS: ${submits} site flows fill and submit once through real extension messaging and document inspection`);
    for (const invalid of ['challenge', 'evil']) {
      mode = invalid;
      await worker.evaluate(async () => {await chrome.storage.session.clear(); await chrome.storage.local.set({retryAfter: 0}); __testRequests.length = 0;});
      await login.goto(FORM);
      await login.waitForFunction(() => !!document.getElementById('thu-login-helper-message'));
      assert.equal(await login.locator('input[type=password]').inputValue(), '');
      assert.equal(await worker.evaluate(() => __testRequests.filter(r => r.op === 'get').length), 0);
    }
    console.log('PASS: extra verification and wrong form destinations never request a password');
    await worker.evaluate(() => {__testNativeError = 'keychain-locked';});
    await page.locator('#check').click();
    await page.waitForFunction(() => document.getElementById('connection-status').textContent.includes('锁定'));
    await worker.evaluate(() => {__testNativeError = null;});
    await page.locator('#check').click();
    await page.waitForFunction(() => document.getElementById('connection-indicator').textContent === '已连接');
    page.on('dialog', d => d.accept());
    await page.locator('#mail-delete').click();
    await page.waitForFunction(() => document.getElementById('mail-state').textContent === '未保存');
    assert.equal(await worker.evaluate(() => !!__testVault.mail), false);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: locked-keychain guidance and credential deletion; no page errors');
  } finally { await context?.close(); fs.rmSync(profile, {recursive: true, force: true}); }
})().catch(error => {console.error(error); process.exitCode = 1;});
