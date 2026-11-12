const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const THU = require('../extension/policy.js');
const FORM = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/fixture/0';
function harness() {
  const calls = [], writes = [], local = {username: 'fixture-user', mailUsername: 'fixture-user', automatic: true};
  const state = {site: 'learn', status: 'running', expires: Date.now()+120000, steps: {}};
  const session = {'tab:5': state};
  const sender = {id: 'fixture-extension', url: FORM, tab: {id: 5}, frameId: 0, documentId: 'document-1', documentLifecycle: 'active'};
  const snapshot = {url: FORM, site: 'learn', expectedUsername: 'fixture-user', username: '', passwordReady: false,
    usernameCount: 1, passwordCount: 1, buttonCount: 1, action: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/check',
    applicationText: '您即将登录 网络学堂2018', challenge: false, error: false};
  let tab = {url: FORM}, result = {ok: true, protocol: 1, username: 'fixture-user', password: 'synthetic-secret'}, during, duringReady;
  const chrome = {runtime: {id: sender.id, getURL: p => `chrome-extension://${sender.id}/${p}`},
    tabs: {get: async () => tab},
    scripting: {executeScript: async options => {
      assert.deepEqual(JSON.parse(JSON.stringify(options.target)), {tabId: 5, documentIds: ['document-1']});
      if (options.world === 'MAIN') {
        assert.equal(options.args, undefined, 'no credential data is sent to the page-world readiness probe');
        await duringReady?.();
        return [{frameId: 0, documentId: 'document-1', result: true}];
      }
      assert.equal(options.world, 'ISOLATED');
      return [{frameId: 0, documentId: 'document-1', result: structuredClone(snapshot)}];
    }}, storage: {
      session: {get: async k => ({[k]: session[k]}), clear: async () => {for (const k of Object.keys(session)) delete session[k];}},
      local: {get: async defaults => ({...defaults, ...local}), set: async data => {writes.push(structuredClone(data)); Object.assign(local, data);}}
    }};
  const ctx = vm.createContext({THU, Date, Set, Object, String, chrome, THUNative: {call: async (_c, request) => {
    calls.push(structuredClone(request)); await during?.(); return structuredClone(result);
  }}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/credentials.js'), 'utf8'), ctx);
  return {sender, state, snapshot, calls, writes, session, local, chrome,
    setResult(r) {result = r;}, during(fn) {during = fn;}, setTab(t) {tab = t;},
    read: role => ctx.THUCredentials.readForPage(chrome, sender, state, 'fixture-user', role),
    ready: () => ctx.THUCredentials.readyForSubmit(chrome, sender, state, 'fixture-user'),
    duringReady(fn) {duringReady = fn;},
    manage: (message, s = {id: sender.id, url: chrome.runtime.getURL('options.html')}) => ctx.THUCredentials.manage(chrome, message, s)};
}
test('one exact top-level login document receives only its own credential', async () => {
  const h = harness(); const r = await h.read();
  assert.equal(r.password, 'synthetic-secret');
  assert.deepEqual(h.calls, [{op: 'get', role: 'identity'}]);
  assert.equal(h.writes.length, 0);
});
test('submission readiness is a read-only check bound to the exact eligible document', async () => {
  const h = harness();
  Object.assign(h.snapshot, {username: 'fixture-user', passwordReady: true});
  assert.equal(await h.ready(), true);
  assert.deepEqual(h.calls, []);
  h.state.steps.submit = true;
  assert.equal(await h.ready(), false);
  delete h.state.steps.submit;
  h.sender.frameId = 1;
  assert.equal(await h.ready(), false);
});
test('navigation, manual input and new errors during readiness checking cancel submission', async () => {
  for (const change of [h => h.setTab({url: 'https://evil.test/'}), h => {h.snapshot.userEdited = true;}, h => {h.snapshot.error = true;}]) {
    const h = harness(); Object.assign(h.snapshot, {username: 'fixture-user', passwordReady: true});
    h.duringReady(() => change(h));
    assert.equal(await h.ready(), false);
    assert.deepEqual(h.calls, []);
  }
});
test('prefilled student number does not block using the configured login-name credential', async () => {
  const h = harness();
  h.snapshot.username = '2099000001';
  const result = await h.read();
  assert.equal(result.ok, true, `credential flow stopped: ${result.error}; native requests: ${h.calls.length}`);
  assert.equal(result.username, 'fixture-user');
});
test('untrusted senders, child frames, inactive documents and missing document IDs cannot read', async () => {
  for (const patch of [{id: 'other'}, {frameId: 1}, {documentId: ''}, {documentLifecycle: 'prerender'},
    {url: 'http://id.tsinghua.edu.cn/'}, {url: 'https://id.tsinghua.edu.cn.evil.test/'}]) {
    const h = harness(); Object.assign(h.sender, patch);
    assert.equal((await h.read()).ok, false); assert.equal(h.calls.length, 0);
  }
});
test('expired, submitted and blocked attempts cannot request credentials', async () => {
  for (const patch of [{expires: 0}, {steps: {submit: true}}, {status: 'blocked'}]) {
    const h = harness(); Object.assign(h.state, patch);
    assert.equal((await h.read()).ok, false); assert.equal(h.calls.length, 0);
  }
});
test('background independently rejects wrong application, destination, extra verification and ambiguous form', async () => {
  for (const patch of [{applicationText: '您即将登录 其他应用'}, {action: 'https://evil.test/'},
    {challenge: true}, {error: true}, {passwordCount: 2}, {userEdited: true}]) {
    const h = harness(); Object.assign(h.snapshot, patch);
    assert.equal((await h.read()).ok, false); assert.equal(h.calls.length, 0);
  }
});
test('a pending navigation prevents a native read', async () => {
  const h = harness(); h.setTab({url: FORM, pendingUrl: 'https://evil.test/'});
  assert.equal((await h.read()).ok, false); assert.equal(h.calls.length, 0);
});
test('navigation, changed form or cancelled state while native read is pending never returns a password', async () => {
  for (const change of [h => h.setTab({url: 'https://evil.test/'}), h => {h.snapshot.challenge = true;},
    h => {h.snapshot.action = 'https://evil.test/';}, h => {h.snapshot.userEdited = true;}, h => {delete h.session['tab:5'];}]) {
    const h = harness(); h.during(() => change(h));
    const r = await h.read(); assert.equal(r.ok, false); assert.equal(r.password, undefined);
  }
});
test('mail gets the separate mail slot and checks its own form', async () => {
  const h = harness(); h.state.site = 'mails'; h.sender.url = THU.SITES.mails.home; h.setTab({url: h.sender.url});
  Object.assign(h.snapshot, {url: h.sender.url, site: 'mails', action: 'https://mails.tsinghua.edu.cn/coremail/index.jsp?cus=1',
    applicationText: '', mailForm: true, mailDomain: 'mails.tsinghua.edu.cn'});
  assert.equal((await h.read()).ok, true); assert.equal(h.calls[0].role, 'mail');
});
test('mail can use identity credentials when explicitly resolved as the fallback source', async () => {
  const h = harness(); h.state.site = 'mails'; h.sender.url = THU.SITES.mails.home; h.setTab({url: h.sender.url});
  h.local.mailUsername = '';
  Object.assign(h.snapshot, {url: h.sender.url, site: 'mails', action: 'https://mails.tsinghua.edu.cn/coremail/index.jsp?cus=1',
    applicationText: '', mailForm: true, mailDomain: 'mails.tsinghua.edu.cn'});
  assert.equal((await h.read('identity')).ok, true);
  assert.deepEqual(h.calls, [{op: 'get', role: 'identity'}]);
});
test('disabling a site or changing its credential source during native retrieval cancels the reply', async () => {
  for (const change of [h => {h.local.siteAutomatic = {learn: false};}, h => {h.local.username = 'changed-user';}]) {
    const h = harness(); h.during(() => change(h));
    assert.equal((await h.read()).password, undefined);
  }
});
test('keychain errors are surfaced and unexpected native usernames never escape', async () => {
  const h = harness(); h.setResult({ok: false, error: 'keychain-locked'});
  assert.equal((await h.read()).error, 'keychain-locked');
  h.setResult({ok: true, username: 'someone-else', password: 'synthetic-secret'});
  assert.equal((await h.read()).password, undefined);
});
test('website content cannot save, delete or inspect account status', async () => {
  const h = harness();
  for (const op of ['vault-status', 'vault-save', 'vault-delete']) {
    assert.equal((await h.manage({op, role: 'identity', username: 'u', password: 'synthetic-secret'}, h.sender)).error, 'denied');
  }
  assert.equal(h.calls.length, 0);
});
test('settings save and delete update only account metadata and invalidate attempts', async () => {
  const h = harness(); h.setResult({ok: true});
  assert.equal((await h.manage({op: 'vault-save', role: 'identity', username: ' fixture-user ', password: 'synthetic-secret'})).ok, true);
  assert.equal(h.writes[0].username, 'fixture-user'); assert.equal(h.session['tab:5'], undefined);
  assert.equal(JSON.stringify(h.writes).includes('synthetic-secret'), false);
  await h.manage({op: 'vault-delete', role: 'identity'}); assert.equal(h.writes[1].username, '');
});
test('failed saves do not replace configured accounts', async () => {
  const h = harness(); h.setResult({ok: false, error: 'storage-error'});
  await h.manage({op: 'vault-save', role: 'identity', username: 'fixture-user', password: 'synthetic-secret'});
  assert.equal(h.writes.length, 0); assert.ok(h.session['tab:5']);
});
test('settings cannot request arbitrary roles or use a get operation', async () => {
  const h = harness();
  for (const msg of [{op: 'vault-get', role: 'identity'}, {op: 'vault-delete', role: '../other'},
    {op: 'vault-save', role: 'mail', username: 'u', password: ''}]) assert.equal((await h.manage(msg)).ok, false);
  assert.equal(h.calls.length, 0);
});
