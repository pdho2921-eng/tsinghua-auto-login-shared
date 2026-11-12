/* Reproduce sequential, explicit launches from options without resetting storage
   between sites. All school pages and credentials are synthetic and local. */
const {chromium} = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const {extensionId} = require('../native/config.json');
const policy = require('../extension/policy.js');
const extension = process.env.THU_TEST_EXTENSION || path.join(root, 'extension');
const mode = process.argv[2] || 'all';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'thu-settings-launch-'));
const AUTH = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/';
const optionsURL = `chrome-extension://${extensionId}/options.html`;
const headings = {learn: '网络学堂2018', info: '清华大学信息门户'};
let submitted = [];
const form = site => `<!doctype html><meta charset="utf-8"><h1>${site === 'mails' ? '学生邮箱' : '您即将登录 ' + headings[site]}</h1>
<form ${site === 'mails' ? 'class="j-login-form"' : ''} action="${site === 'mails' ? 'https://mails.tsinghua.edu.cn/coremail/index.jsp?cus=1' : AUTH + 'check'}">
<input name="username" type="text"><input name="password" type="password">
${site === 'mails' ? '<input type="hidden" name="domain" value="mails.tsinghua.edu.cn">' : ''}
<button type="button" onclick="if (document.querySelector('[name=username]').value !== 'fixture-user' || document.querySelector('[name=password]').value !== 'synthetic-secret') {document.getElementById('result').textContent='填写不匹配'; return;} document.querySelector('form').remove(); document.getElementById('result').textContent='请完成二次验证'; fetch('/fixture-submit-${site}', {method:'POST'});">登录</button>
</form><p id="result"></p>`;
(async () => {
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {headless: true, channel: 'chromium',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
    await context.route('https://**/*', route => {
      const u = new URL(route.request().url());
      const submittedSite = u.pathname.match(/^\/fixture-submit-(learn|info|mails)$/)?.[1];
      if (submittedSite) { submitted.push(submittedSite); return route.fulfill({status: 200, body: 'ok'}); }
      const site = Object.keys(policy.SITES).find(s => policy.SITES[s].home === u.href);
      // Use a fresh client navigation so Playwright also intercepts the auth request.
      if (site && site !== 'mails') return route.fulfill({contentType:'text/html',
        body:`<!doctype html><script>location.replace(${JSON.stringify(AUTH + `form/${site}/0`)})</script>`});
      const authSite = u.hostname === 'id.tsinghua.edu.cn' && u.pathname.match(/\/form\/(learn|info)\/0$/)?.[1];
      if (authSite || site === 'mails') return route.fulfill({contentType: 'text/html', body: form(authSite || site)});
      return route.abort();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(async () => {
      await chrome.storage.local.clear(); await chrome.storage.session.clear();
      globalThis.__fixtureReads = 0;
      chrome.runtime.connectNative = () => {
        let listener, closed = false;
        return {onMessage: {addListener(fn) {listener = fn;}}, onDisconnect: {addListener() {}}, disconnect() {closed = true;},
          postMessage(request) {
            let result = {ok: true};
            if (request.op === 'status') result = {ok: true, version: 'fixture', accounts: {
              identity: {configured: true, username: 'fixture-user'}, mail: {configured: false, username: ''}}};
            else if (request.op === 'get') { __fixtureReads++; result = {ok: true, username: 'fixture-user', password: 'synthetic-secret'}; }
            setTimeout(() => {if (!closed) listener({...result, protocol: 1});}, 10);
          }};
      };
    });
    const options = await context.newPage();
    await options.goto(optionsURL);
    await options.waitForFunction(() => document.getElementById('connection-indicator').textContent === '已连接');
    if (mode === 'connection' || mode === 'all') {
      assert.equal(await options.locator('#connection-success').isVisible(), true,
        'Opening options must show the first successful connection toast');
      await options.locator('#dismiss-connection-success').click();
      await options.locator('#check').click();
      await options.waitForFunction(() => !document.getElementById('connection-success').hidden);
      await options.locator('#dismiss-connection-success').click();
      await options.locator('#identity-password').fill('synthetic-update');
      await options.locator('#identity-form button[type=submit]').click();
      await options.waitForFunction(() => document.getElementById('identity-result').textContent.startsWith('已保存'));
      await options.waitForFunction(() => document.getElementById('connection-indicator').textContent === '已连接');
      assert.equal(await options.locator('#connection-success').isVisible(), false, 'Save background checks should stay quiet');
      console.log('PASS initial and manual connection notices; background save checks stay quiet.');
    }
    if (mode === 'links' || mode === 'all') {
      for (const [index, site] of ['learn', 'info', 'mails', 'learn'].entries()) {
        await options.bringToFront();
        const opened = context.waitForEvent('page');
        await options.locator(`.site-links a[href="${policy.SITES[site].home}"]`).click();
        const login = await opened; await login.bringToFront();
        try { await login.waitForFunction(() => document.getElementById('result')?.textContent === '请完成二次验证', null, {timeout: 7000}); }
        catch {
          const diagnostic = await worker.evaluate(async () => {
            const local = await chrome.storage.local.get(['retryAfter']);
            const session = await chrome.storage.session.get(null);
            return {reads: __fixtureReads, cooldownActive: local.retryAfter > Date.now(), leasePresent: !!session.submitting,
              states: Object.values(session).filter(v => v && typeof v.status === 'string').map(v => ({site:v.site,status:v.status,manual:v.manual}))};
          });
          const pageState = await login.evaluate(() => ({url:location.origin + location.pathname, title:document.title,
            visible:document.visibilityState, hasForm:!!document.querySelector('form'), hasResult:!!document.getElementById('result')}));
          console.log('REPRO (no account/password):', JSON.stringify({attempt:index+1, site, ...pageState, ...diagnostic}));
          assert.fail(`Settings launch ${index + 1} (${site}) did not fill and submit after the preceding 2FA stop`);
        }
        // Verify challenge detection stopped the flow and released the submit lease.
        await options.waitForFunction(async site => {
          const state = await chrome.storage.session.get(null);
          const settings = await chrome.storage.local.get('retryAfter');
          return !state.submitting && settings.retryAfter > Date.now() && Object.entries(state).some(
            ([key, value]) => key.startsWith('tab:') && value.site === site && value.status === 'blocked');
        }, site);
        assert.equal(submitted.filter(s => s === site).length, site === 'learn' && index === 3 ? 2 : 1);
        await login.close();
        console.log(`PASS settings launch ${index + 1}: ${site}, one submission, stopped at 2FA, tab closed.`);
      }
      assert.deepEqual(submitted, ['learn', 'info', 'mails', 'learn']);
      const stored = await worker.evaluate(async () => ({local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null)}));
      assert.ok(!JSON.stringify(stored).includes('synthetic-secret'));
    }
  } finally { await context?.close(); fs.rmSync(profile, {recursive: true, force: true}); }
})().catch(error => {console.error(error); process.exitCode = 1;});
