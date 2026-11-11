const {contentGlobals, element} = require('./support.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const THU = require('../extension/policy.js');
const flush = () => new Promise(setImmediate);
const lost = () => new Error('Extension context invalidated.');

function page({send, text = '用户未登录，无权限访问。', register = () => {}, url = THU.SITES.info.home} = {}) {
  let interval, cleared = false;
  const messages = [], navigations = [], notes = new Map(), listeners = new Map();
  const runtime = {id: 'fixture-extension', onMessage: {addListener: register}, sendMessage(message) {
    messages.push(message);
    return send ? send(message) : Promise.resolve(message.op === 'begin' ? {site: 'info', status: 'running'} : true);
  }};
  const document = {visibilityState: 'visible', body: {innerText: text, append(el) {notes.set(el.id, el);}},
    querySelectorAll: () => [], getElementById: id => notes.get(id), createElement: element,
    addEventListener(name, listener) {listeners.set(name, listener);},
    removeEventListener(name, listener) {if (listeners.get(name) === listener) listeners.delete(name);}};
  const window = {}; window.top = window;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8'), {
    ...contentGlobals, THU, window, document, chrome: {runtime}, URL, Date,
    location: {href: url, assign: url => navigations.push(url)},
    setInterval(fn) {interval = fn; return 1;}, clearInterval() {cleared = true;},
    getComputedStyle: () => ({visibility: 'visible'})
  });
  return {runtime, document, messages, navigations, get cleared() {return cleared;},
    get note() {return notes.get('thu-login-helper-message')?.textContent || '';},
    async tick() {interval?.(); await flush();},
    async logout() {listeners.get('click')?.({target: {closest: () => ({innerText: '退出'})}}); await flush();},
    hasLogoutListener() {return listeners.has('click');}};
}

for (const mode of ['synchronous throw', 'rejected promise']) {
  test(`invalidated context during ${mode} retires the old page without an unhandled error`, async () => {
    const p = page({send() {if (mode === 'synchronous throw') throw lost(); return Promise.reject(lost());}});
    await flush();
    assert.equal(p.cleared, true);
    assert.match(p.note, /刷新/);
    assert.equal(p.hasLogoutListener(), false);
    await p.tick(); await p.logout();
    assert.equal(p.messages.length, 1);
    assert.deepEqual(p.navigations, []);
  });
}
test('a hidden idle page retires when its runtime ID disappears, before sending any message', async () => {
  const p = page({text: '信息门户加载中'});
  await flush();
  p.runtime.id = undefined;
  p.document.visibilityState = 'hidden';
  await p.tick();
  assert.equal(p.cleared, true);
  assert.match(p.note, /刷新/);
  assert.equal(p.hasLogoutListener(), false);
  assert.equal(p.messages.length, 0);
});
test('a reply from an invalidated runtime cannot continue into navigation', async () => {
  let resolve;
  const p = page({send(message) {return message.op === 'begin' ? new Promise(done => {resolve = done;}) : Promise.resolve(true);}});
  p.runtime.id = undefined;
  resolve({site: 'info', status: 'running'});
  await flush();
  assert.equal(p.messages.length, 1);
  assert.deepEqual(p.navigations, []);
  assert.match(p.note, /刷新/);
});
test('invalidation while registering a listener stops before polling begins', async () => {
  const p = page({register() {throw lost();}});
  await flush();
  assert.equal(p.cleared, true);
  assert.match(p.note, /刷新/);
  assert.equal(p.messages.length, 0);
  assert.equal(p.hasLogoutListener(), false);
});
test('a normal message rejection is not labelled as an extension update', async () => {
  const p = page({send: () => Promise.reject(new Error('Could not establish connection.'))});
  await flush();
  assert.equal(p.note, '');
  assert.deepEqual(p.navigations, []);
});
test('the real SSO rejection route shows an alert without fetching or resubmitting credentials', async () => {
  const p = page({url: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/check', text: '您即将登录 网络学堂2018\n您的用户名或密码不正确，请重试！'});
  await flush();
  assert.match(p.note, /登录失败/);
  assert.deepEqual(p.messages.map(m => m.op), ['stop']);
  assert.equal(p.cleared, true);
});
