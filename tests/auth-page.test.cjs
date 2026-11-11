const {contentGlobals, element} = require('./support.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../extension/policy.js');

// Observed: <form id="theform" method="post" action="/do/off/ui/auth/login/check">
// <a class="btn btn-lg btn-primary btn-block" type="button" onclick="doLogin(); return false;">登录</a>
for (const editingDuringClaim of [false, true]) test(editingDuringClaim ? 'manual editing while awaiting a submit claim cancels submission' : 'real auth form with an anchor submit control is submitted once after filling', async () => {
  const messages = [], clicks = [], listeners = new Map(); let interval, resolveClaim;
  const visible = {dispatchEvent() {}, getClientRects() { return [{}]; }};
  const username = {...visible, type: 'text', value: 'fixture-user', name: 'username'};
  const password = {...visible, type: 'password', value: 'synthetic-test-password'};
  const login = {...visible, tagName: 'A', innerText: '登录', click() { clicks.push('login'); }};
  const form = {action: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/check', querySelectorAll(selector) {
    if (selector === 'input') return [username, password];
    return selector.split(',').includes('a[type=button]') || selector.split(',').includes('a') ? [login] : [];
  }};
  password.form = form;
  const document = {visibilityState: 'visible', body: {innerText: '您即将登录\n网络学堂2018\n用户名\n密码\n登录', append() {}},
    querySelectorAll(selector) { if (selector === 'input[type=password]') return [password]; if (selector === 'input,iframe') return [username, password]; return []; },
    getElementById() { return null; }, createElement: element, addEventListener(type, handler) {listeners.set(type, handler);}};
  const window = {}; window.top = window;
  const context = vm.createContext({...contentGlobals, THU: policy, document, window, URL,
    location: {href: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/fixture-app/0'},
    getComputedStyle() { return {visibility: 'visible'}; }, setInterval(fn) { interval = fn; return 1; }, clearInterval() {},
    chrome: {runtime: {id: 'fixture-extension', async sendMessage(message) { messages.push(message); if (message.op === 'claim' && editingDuringClaim) return new Promise(resolve => {resolveClaim = resolve;}); if (message.op === 'get-credential') return {ok: true, username: 'fixture-user', password: 'synthetic-test-password'}; return message.op === 'begin' ? {status: 'running', expectedUsername: 'fixture-user'} : true; }}}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  interval(); await new Promise(setImmediate);
  if (editingDuringClaim) {
    listeners.get('beforeinput')({isTrusted: true, target: password, type: 'beforeinput'});
    password.value = 'manually-edited-password';
    resolveClaim(true); await new Promise(setImmediate);
  }
  assert.equal(clicks.length, editingDuringClaim ? 0 : 1);
  assert.equal(messages.some(message => message.op === 'stop'), editingDuringClaim);
  assert.equal(JSON.stringify(messages).includes('synthetic-test-password'), false);
});
