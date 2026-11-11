const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../extension/policy.js');

// The real expired page was inspected in Chrome on 2026-11-11:
// <a class="chongxin" onclick="top.document.location='/'" style="cursor:pointer">登录网络学堂</a>
// In particular it has NO href. Execute the actual content script at this seam.
async function runExpiredPage({href = null, onclick = "top.document.location='/'"} = {}) {
  const messages = [], clicks = [], navigations = [];
  const nodes = new Map();
  const link = {
    innerText: '登录网络学堂', textContent: '登录网络学堂',
    href: href === null ? '' : new URL(href, policy.HOME).href,
    getAttribute(name) { return ({href, onclick})[name] ?? null; },
    getClientRects() { return [{}]; },
    click() { clicks.push('login'); }
  };
  const close = {innerText: '关闭', href: '', getClientRects() { return [{}]; }};
  const document = {
    visibilityState: 'visible',
    body: {innerText: '您未登录或登录失效\n登录网络学堂\n关闭', append(el) { nodes.set(el.id, el); }},
    querySelectorAll(selector) { return selector === 'a' ? [link, close] : []; },
    getElementById(id) { return nodes.get(id); },
    createElement() { return {style: {}, textContent: ''}; },
    addEventListener() {}
  };
  const window = {}; window.top = window;
  const context = vm.createContext({THU: policy, document, window, URL,
    location: {href: policy.HOME, assign(url) { navigations.push(url); }},
    getComputedStyle() { return {visibility: 'visible'}; },
    setInterval() { return 1; }, clearInterval() {},
    chrome: {runtime: {id: 'fixture-extension', async sendMessage(message) {
      messages.push(message);
      if (message.op === 'begin') return {status: 'running', expectedUsername: 'fixture-user'};
      if (message.op === 'claim') return true;
      return null;
    }}}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return {messages, clicks, navigations, notice: nodes.get('thu-login-helper-message')?.textContent};
}

test('real expired-page anchor without href advances instead of showing the reported stop message', async () => {
  const result = await runExpiredPage();
  assert.equal(result.messages.some(m => m.op === 'stop'), false, result.notice);
  assert.equal(result.messages.some(m => m.op === 'claim' && m.action === 'expired-link'), true);
  assert.equal(result.clicks.length + result.navigations.length, 1);
  assert.equal(result.navigations[0], 'https://learn.tsinghua.edu.cn/');
});

test('same-site normal href is supported without relying on inline scripts', async () => {
  const result = await runExpiredPage({href: '/f/login', onclick: null});
  assert.equal(result.messages.some(m => m.op === 'stop'), false);
  assert.equal(result.navigations[0], 'https://learn.tsinghua.edu.cn/f/login');
});
test('unrecognized inline code is not executed or treated as a login destination', async () => {
  for (const onclick of [null, "top.document.location='https://elsewhere.test/'", "top.document.location='/';otherCode()"] ) {
    const result = await runExpiredPage({onclick});
    assert.equal(result.messages.some(m => m.op === 'stop'), false);
    assert.equal(result.clicks.length + result.navigations.length, 0);
  }
});
test('invalid, insecure, external or unrelated targets are ignored safely', () => {
  for (const href of ['http://[', 'https://elsewhere.test/', 'http://learn.tsinghua.edu.cn/',
    'javascript:alert(1)', '/f/logout', '//learn.tsinghua.edu.cn.attacker.test/']) {
    assert.equal(policy.expiredLoginTarget(href, null, policy.HOME), null);
  }
  assert.equal(policy.expiredLoginTarget('/', null, 'https://elsewhere.test/'), null);
});
