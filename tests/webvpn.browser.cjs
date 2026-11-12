/* Isolated browser: every school response is a local fixture; credentials are synthetic. */
const {chromium} = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const {extensionId} = require('../native/config.json');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'thu-webvpn-'));
const AUTH = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/';
const VPN = 'https://webvpn.tsinghua.edu.cn/';
const PORTAL = VPN + 'https/77726476706e69737468656265737421f9f9479369247b59700f81b9991b2631506205de/f/info/gxfw_fg/common/index';
let mode = 'direct', submissions = [];
(async () => {
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {headless: true, channel: 'chromium', args: [`--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`]});
    await context.route('https://**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'id.tsinghua.edu.cn' && url.pathname.endsWith('/check')) {
        const stage = url.searchParams.get('stage'); submissions.push(stage);
        return route.fulfill({contentType:'text/html', body:`<script>location.replace(${JSON.stringify(stage === 'info' ? AUTH + 'form/webvpn/0' : VPN)})</script>`});
      }
      let body;
      if (url.hostname === 'id.tsinghua.edu.cn') {
        const stage = url.pathname.includes('/info/') ? 'info' : 'webvpn';
        body = `<h1>您即将登录 ${stage === 'info' ? '清华大学信息门户' : 'WEBVPN'}</h1>${mode === 'challenge' ? '<p>请输入验证码</p>' : ''}<form method="post" action="${AUTH}check?stage=${stage}"><input name="username"><input type="password" name="password"><button type="button" onclick="this.form.requestSubmit()">登录</button></form>`;
      } else if (url.href === VPN) {
        body = '<h1>清华大学WebVPN</h1><p>欢迎您</p><h2>常用网站</h2><a href="/logout">退出</a>';
      } else if (url.href === PORTAL) {
        body = mode === 'expired' ? '<p>我的工作台 退出 用户未登录，无权限访问</p>' : '<h1>我的工作台</h1><a>退出</a>';
      } else if (url.hostname === 'webvpn.tsinghua.edu.cn' && url.pathname.endsWith('/f/redirectLoginUrl')) {
        return route.fulfill({contentType:'text/html', body:`<script>location.replace(${JSON.stringify(AUTH + 'form/webvpn/0')})</script>`});
      } else return route.abort();
      return route.fulfill({contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8">' + body});
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
      globalThis.requests = 0;
      chrome.runtime.connectNative = () => {
        let listener;
        return {onMessage: {addListener(fn) {listener=fn;}}, onDisconnect: {addListener() {}}, disconnect() {}, postMessage(request) {if(request.op === 'get') requests++; queueMicrotask(() => listener(request.op === 'status' ? {ok:true,protocol:1,version:'fixture',accounts:{identity:{configured:true,username:'fixture-user'}}} : {ok:true,protocol:1,username:'fixture-user',password:'synthetic-secret'}));}};
      };
    });
    const page = await context.newPage();
    const reset = async (siteAutomatic = {}) => {
      submissions = [];
      await worker.evaluate(async values => {requests=0; await chrome.storage.session.clear(); await chrome.storage.local.set({username:'fixture-user', automatic:true, retryAfter:0, pausedSites:{}, siteAutomatic:values});}, siteAutomatic);
    };
    const state = () => worker.evaluate(async () => Object.values(await chrome.storage.session.get(null)).find(s => s.site === 'info'));
    for (const entry of ['direct','chain','expired']) {
      mode=entry; await reset();
      await page.goto(entry === 'expired' ? PORTAL : AUTH + `form/${entry === 'chain' ? 'info' : 'webvpn'}/0`);
      try { await page.waitForURL(VPN, {timeout:10000}); } catch(error) { console.log({mode, path:new URL(page.url()).pathname, submissions, state:await state(), text:await page.locator('body').innerText()}); throw error; }
      await page.waitForTimeout(4000);
      assert.equal((await state())?.status, 'done');
      assert.equal((await state()).manual, false);
      assert.deepEqual(submissions, entry === 'chain' ? ['info','webvpn'] : ['webvpn']);
      assert.equal(await worker.evaluate(() => requests), submissions.length);
      assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('retryAfter')).retryAfter), 0);
      console.log(`PASS: ${entry} WEBVPN flow submits each application once, reaches gateway and releases cooldown`);
    }
    mode='direct'; await reset({info:false}); await page.goto(AUTH+'form/webvpn/0'); await page.waitForTimeout(1800);
    assert.equal(await worker.evaluate(() => requests),0); assert.equal(await page.locator('input[type=password]').inputValue(),'');
    console.log('PASS: disabling information portal also stops WEBVPN before reading credentials');
    mode='challenge'; await reset(); await page.goto(AUTH+'form/webvpn/0'); await page.waitForTimeout(1800);
    assert.equal(await worker.evaluate(() => requests),0); assert.equal(submissions.length,0);
    console.log('PASS: WEBVPN extra verification stops without reading or submitting credentials');
    mode='direct'; await reset(); await page.goto(PORTAL); await page.waitForTimeout(4000);
    assert.equal(await worker.evaluate(() => requests),0);
    assert.equal(page.url(),PORTAL);
    console.log('PASS: proxied information portal stays on its original page');
  } finally {await context?.close(); fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error => {console.error(error); process.exitCode=1;});
