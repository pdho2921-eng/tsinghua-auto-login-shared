/* Real Chromium, synthetic school pages and credentials; all network requests stay local. */
const {chromium} = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const {extensionId} = require('../native/config.json');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'thu-slow-login-'));
const origin = 'https://id.tsinghua.edu.cn';
const scenarios = ['learn-load', 'info-cold', 'mail-handler', 'mail-response'];
function fixture(scenario) {
  const mail = scenario.startsWith('mail');
  return `<!doctype html><meta charset="utf-8">
    <h1>${mail ? '学生邮箱' : '您即将登录 ' + (scenario.startsWith('learn') ? '网络学堂2018' : '清华大学信息门户')}</h1>
    <form ${mail ? 'class="j-login-form"' : 'id="theform"'} action="${mail ? 'https://mails.tsinghua.edu.cn/coremail/index.jsp?cus=1' : origin + '/do/off/ui/auth/login/check'}">
    <input name="username"><input type="password" name="password">
    ${mail ? '<input type="hidden" name="domain" value="mails.tsinghua.edu.cn">' : '<input type="hidden" id="fingerGenPrint3">'}
    <button type="button">登录</button></form>
    ${scenario === 'learn-load' ? '<img src="/fixture-delayed-image">' : ''}
    <script>
      window.attempts = 0; window.earlyClicks = 0; window.submits = 0; window.ready = false;
      const button = document.querySelector('button');
      button.addEventListener('click', () => { window.attempts++; if (!window.ready) window.earlyClicks++; });
      const submit = () => { if (!window.ready) return; window.submits++; setTimeout(() => window.responded = true, ${scenario === 'mail-response' ? 3500 : 10}); };
      if (${JSON.stringify(mail)}) {
        // Coremail binds its handler through jQuery after rendering the form.
        setTimeout(() => {
          button.jQueryFixture = {events: {click: [{handler: submit}]}};
          button.addEventListener('click', submit); window.ready = true;
        }, 2400);
      } else {
        button.onclick = submit;
        const initialize = () => setTimeout(() => {
          document.querySelector('#fingerGenPrint3').value = 'synthetic-ready-marker'; window.ready = true;
        }, ${scenario === 'info-cold' ? 2400 : 50});
        window.addEventListener('load', initialize);
      }
    </script>`;
}
(async () => {
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {headless: true, channel: 'chromium',
      args: [`--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`]});
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    let scenario;
    await context.route('https://**/*', async route => {
      if (new URL(route.request().url()).pathname === '/fixture-delayed-image') {
        await new Promise(resolve => setTimeout(resolve, 3000));
        return route.fulfill({status: 204, body: ''});
      }
      if (['id.tsinghua.edu.cn', 'mails.tsinghua.edu.cn'].includes(new URL(route.request().url()).hostname))
        return route.fulfill({contentType: 'text/html', body: fixture(scenario)});
      return route.abort();
    });
    await worker.evaluate(async () => {
      await chrome.storage.local.set({username: 'fixture-user', automatic: true});
      chrome.runtime.connectNative = () => {
        let listener;
        return {onMessage: {addListener(fn) {listener = fn;}}, onDisconnect: {addListener() {}}, disconnect() {},
          postMessage(request) {queueMicrotask(() => listener(request.op === 'status' ? {ok: true, protocol: 1, version: 'fixture', accounts: {identity: {configured: true, username: 'fixture-user'}}} : {ok: true, protocol: 1, username: 'fixture-user', password: 'synthetic-secret'}));}};
      };
    });
    for (scenario of scenarios) {
      await worker.evaluate(async () => {await chrome.storage.session.clear(); await chrome.storage.local.set({retryAfter: 0});});
      const page = await context.newPage();
      await page.goto(scenario.startsWith('mail') ? 'https://mails.tsinghua.edu.cn/' : origin + '/do/off/ui/auth/login/form/fixture/0');
      await page.waitForFunction(() => window.ready === true);
      await page.waitForFunction(() => document.querySelector('input[type=password]').value === 'synthetic-secret', null, {timeout: 10000});
      assert.equal(await page.evaluate(() => window.earlyClicks), 0, `${scenario}: clicked before the page finished initializing`);
      await page.waitForFunction(() => window.responded === true, null, {timeout: 10000});
      assert.equal(await page.evaluate(() => window.attempts), 1, `${scenario}: repeated click`);
      assert.equal(await page.evaluate(() => window.submits), 1);
      await page.close();
      console.log(`PASS: ${scenario} waits for initialization and submits once`);
    }
    assert.equal(new URL(worker.url()).host, extensionId);
  } finally {await context?.close(); fs.rmSync(profile, {recursive: true, force: true});}
})().catch(error => {console.error(error); process.exitCode = 1;});
