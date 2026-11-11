const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const policy = require('../extension/policy.js');
const FORM = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/example-app/0';
const snapshot = () => ({url: FORM, applicationText: '您即将登录\n网络学堂2018\n用户密码登录',
  expectedUsername: 'test-user', username: 'test-user', usernameCount: 1, passwordCount: 1,
  passwordReady: true, buttonCount: 1, action: '/do/off/ui/auth/login/check', challenge: false, error: false});

test('only exact HTTPS hosts and known authentication routes are eligible', () => {
  assert.equal(policy.kind(FORM), 'form');
  for (const url of ['http://id.tsinghua.edu.cn/do/off/ui/auth/login/form/a/0',
    'https://id.tsinghua.edu.cn.attacker.test/do/off/ui/auth/login/form/a/0',
    'https://id.tsinghua.edu.cn/f/account/settings',
    'https://id.tsinghua.edu.cn:8443/do/off/ui/auth/login/form/a/0',
    'https://user@id.tsinghua.edu.cn/do/off/ui/auth/login/form/a/0']) assert.equal(policy.kind(url), 'other');
});
test('correct filled form is eligible, without passing password contents to policy', () => {
  assert.equal(policy.submission(snapshot()), 'submit');
  assert.equal(Object.hasOwn(snapshot(), 'password'), false);
});
test('never submit another application, account, challenge or failed login', () => {
  for (const [change, expected] of [
    [{applicationText: '您即将登录 信息门户'}, 'wrong-application'],
    [{applicationText: '您即将登录 网络学堂20180'}, 'wrong-application'],
    [{username: 'someone-else'}, 'wrong-account'],
    [{challenge: true}, 'challenge'], [{error: true}, 'login-error'],
    [{action: 'https://attacker.test/collect'}, 'wrong-destination'],
    [{usernameCount: 2}, 'ambiguous-form'], [{buttonCount: 2}, 'ambiguous-form'],
    [{passwordReady: false}, 'waiting-for-fill'], [{expectedUsername: ''}, 'unconfigured']
  ]) assert.equal(policy.submission({...snapshot(), ...change}), expected);
});
test('each navigation/submit step can be claimed once and expired attempts stop', () => {
  const state = {status: 'running', expires: 200, steps: {}};
  const next = policy.claim(state, 'submit', 100);
  assert.ok(next);
  assert.equal(policy.claim(next, 'submit', 101), null);
  assert.equal(policy.claim(state, 'submit', 200), null);
  assert.equal(policy.claim({...state, status: 'blocked'}, 'submit', 100), null);
  assert.equal(policy.claim(state, 'unknown', 100), null);
});

function storage(seed = {}) {
  const values = structuredClone(seed);
  return {
    values,
    async get(keys) {
      if (typeof keys === 'string') return {[keys]: structuredClone(values[keys])};
      return {...structuredClone(keys), ...structuredClone(values)};
    },
    async set(data) { Object.assign(values, structuredClone(data)); },
    async remove(key) { delete values[key]; }
  };
}
function background(local = storage({username: 'test-user', mailUsername: 'test-user', automatic: true}), session = storage(), tabContext = null) {
  const event = {addListener() {}};
  let click;
  const navigations = [], created = [];
  const context = vm.createContext({THU: policy, importScripts() {}, Date, Promise,
    chrome: {storage: {local, session}, runtime: {id: 'test-extension', onMessage: event, onInstalled: event, async openOptionsPage() {}},
      alarms: {onAlarm: event},
      action: {onClicked: {addListener(fn) { click = fn; }}, async setBadgeText() {}, async setTitle() {}},
      tabs: {onRemoved: event, async sendMessage() { return tabContext; }, async create(data) { created.push(data); return {id: 99}; },
        async update(id, data) { navigations.push({id, ...data}); }}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  return {context, local, session, navigations, created, click: tab => click(tab), handle: (op, sender) => context.handle(op, sender)};
}
const sender = (tab = 1, url = policy.HOME) => ({id: 'test-extension', frameId: 0, tab: {id: tab}, url});
test('toolbar restart stays in the clicked tab even when Chrome omits its URL', async () => {
  for (const tab of [{id: 7}, {id: 7, url: FORM}, {id: 7, url: policy.HOME}]) {
    const worker = background(undefined, undefined, tab.url === FORM ? {site: 'learn'} : null);
    await worker.click(tab);
    assert.equal(worker.created.length, 0, 'login must not open another tab');
    assert.equal(worker.navigations[0]?.id, 7);
    assert.equal(worker.navigations[0]?.url, policy.HOME);
    assert.equal(worker.session.values['tab:7'].status, 'running');
  }
});
test('a restored Learn identity form can resume automatically after browser session storage is cleared', async () => {
  const worker = background();
  assert.equal(await worker.handle({op: 'begin'}, sender(7, FORM)), null);
  const state = await worker.handle({op: 'begin', site: 'learn'}, sender(7, FORM));
  assert.equal(state.status, 'running');
  await worker.handle({op: 'pause', site: 'learn'}, sender(7, FORM));
  assert.equal(await worker.handle({op: 'begin', site: 'learn'}, sender(8, FORM)), null);
});
test('submit guard survives navigation and a service worker restart', async () => {
  const worker = background();
  await worker.handle({op: 'begin'}, sender());
  assert.equal(await worker.handle({op: 'claim', action: 'submit', site: 'learn'}, sender(1, FORM)), true);
  const restarted = background(worker.local, worker.session);
  assert.equal(await restarted.handle({op: 'claim', action: 'submit', site: 'learn'}, sender(1, FORM)), false);
  assert.ok(worker.local.values.retryAfter > Date.now());
});
test('submission claims from a course page are rejected without consuming the attempt', async () => {
  const worker = background();
  await worker.handle({op: 'begin'}, sender());
  assert.equal(await worker.handle({op: 'claim', action: 'submit', site: 'learn'}, sender()), false);
  assert.equal(await worker.handle({op: 'claim', action: 'submit', site: 'learn'}, sender(1, FORM)), true);
});
test('parallel tabs cannot submit a password at the same time', async () => {
  const worker = background();
  await worker.handle({op: 'begin'}, sender(1));
  await worker.handle({op: 'begin'}, sender(2));
  assert.equal(await worker.handle({op: 'claim', action: 'submit', site: 'learn'}, sender(1, FORM)), true);
  assert.equal(await worker.handle({op: 'claim', action: 'submit', site: 'learn'}, sender(2, FORM)), false);
});
test('explicit logout pauses future automatic attempts and frames cannot trigger actions', async () => {
  const worker = background();
  await worker.handle({op: 'pause'}, sender());
  assert.equal(await worker.handle({op: 'begin'}, sender(2)), null);
  assert.equal(await worker.handle({op: 'begin'}, {...sender(), frameId: 1}), null);
  assert.equal(await worker.handle({op: 'begin'}, sender(1, 'https://elsewhere.test/')), null);
});
test('a failed attempt suppresses immediate automatic retries in a new tab', async () => {
  const worker = background();
  await worker.handle({op: 'begin'}, sender());
  await worker.handle({op: 'stop'}, sender(1, FORM));
  assert.equal(await worker.handle({op: 'begin'}, sender(2)), null);
});
test('successful course return clears cooldown and the active submission lease', async () => {
  const worker = background();
  await worker.handle({op: 'begin'}, sender());
  await worker.handle({op: 'claim', action: 'submit', site: 'learn'}, sender(1, FORM));
  assert.equal(await worker.handle({op: 'done'}, sender(1)), true);
  assert.equal(worker.local.values.retryAfter, 0);
  assert.equal(worker.session.values.submitting, undefined);
});

const INFO = policy.SITES.info.home, MAIL = policy.SITES.mails.home;
test('observed portal identity URL without a trailing /0 is an authentication form', () => {
  assert.equal(policy.kind('https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/10000ea055dd8d81d09d5a1ba55d39ad'), 'form');
});
test('each site restarts in its original tab, including an identity form whose URL is absent', async () => {
  for (const [url, site, tabContext] of [[INFO, 'info', null], [MAIL, 'mails', null], [undefined, 'info', {site: 'info'}]]) {
    const worker = background(undefined, undefined, tabContext);
    await worker.click({id: 42, url});
    assert.equal(worker.created.length, 0);
    assert.equal(worker.navigations[0].id, 42);
    assert.equal(worker.navigations[0].url, policy.SITES[site].home);
    assert.equal(worker.session.values['tab:42'].site, site);
  }
});
test('a Learn attempt cannot silently turn into a different SSO application', async () => {
  const worker = background();
  await worker.handle({op: 'begin'}, sender());
  assert.equal(await worker.handle({op: 'claim', action: 'submit', site: 'info'}, sender(1, FORM)), null);
  assert.equal(await worker.handle({op: 'begin', site: 'info'}, sender(1, FORM)), null);
  assert.equal(await worker.handle({op: 'claim', action: 'submit', site: 'learn'}, sender(1, FORM)), true);
});
test('logout pauses only that website, and mail can use its separately configured account', async () => {
  const worker = background(storage({username: 'test-user', mailUsername: 'mail-user@mails.tsinghua.edu.cn', automatic: true}));
  await worker.handle({op: 'pause'}, sender(1, INFO));
  assert.equal(await worker.handle({op: 'begin'}, sender(2, INFO)), null);
  assert.equal((await worker.handle({op: 'begin'}, sender(3))).status, 'running');
  assert.equal((await worker.handle({op: 'begin'}, sender(4, MAIL))).expectedUsername, 'mail-user@mails.tsinghua.edu.cn');
});
test('portal and email actions are bound to their expected page types', async () => {
  const worker = background();
  await worker.handle({op: 'begin'}, sender(1, INFO));
  assert.equal(await worker.handle({op: 'claim', action: 'submit'}, sender(1, INFO)), false);
  assert.equal(await worker.handle({op: 'claim', action: 'info-login'}, sender(1, INFO)), true);
  assert.equal(await worker.handle({op: 'claim', action: 'info-login'}, sender(1, INFO)), false);
  await worker.handle({op: 'begin'}, sender(2, MAIL));
  assert.equal(await worker.handle({op: 'claim', action: 'submit'}, sender(2, MAIL)), true);
});
test('SSO application labels and direct mail forms use strict destination and account checks', () => {
  assert.equal(policy.authSite('您即将登录\n清华大学信息门户'), 'info');
  assert.equal(policy.authSite('您即将登录 清华大学信息门户仿冒'), null);
  assert.equal(policy.submission({...snapshot(), site: 'info', applicationText: '您即将登录 清华大学信息门户'}), 'submit');
  assert.equal(policy.submission({...snapshot(), site: 'info'}), 'wrong-application');
  const mail = {...snapshot(), site: 'mails', url: MAIL, action: '/coremail/index.jsp?cus=1', mailForm: true, mailDomain: 'mails.tsinghua.edu.cn', username: 'test-user@mails.tsinghua.edu.cn'};
  assert.equal(policy.submission(mail), 'submit');
  for (const patch of [{mailDomain: 'mail.tsinghua.edu.cn'}, {mailForm: false}, {action: 'https://elsewhere.test/'}, {action: '/coremail/password-reset'}, {action: 'http://['}]) assert.equal(policy.submission({...mail, ...patch}), 'wrong-destination');
  assert.equal(policy.submission({...mail, username: 'test-user@elsewhere.test'}), 'wrong-account');
  assert.equal(policy.submission({...mail, challenge: true}), 'challenge');
  for (const url of ['https://mails.tsinghua.edu.cn.evil.test/', 'http://info.tsinghua.edu.cn/', 'https://mails.tsinghua.edu.cn:444/', 'https://user@info.tsinghua.edu.cn/']) assert.equal(policy.kind(url), 'other');
});
test('an interim remembered username does not stop the attempt before the password manager finishes filling', () => {
  assert.equal(policy.submission({...snapshot(), username: 'remembered-old-account', passwordReady: false}), 'waiting-for-fill');
});

test('a still-loading identity tab never defaults to the wrong website', async () => {
  const worker = background();
  await worker.click({id: 42, url: FORM});
  assert.equal(worker.navigations.length, 0);
  await worker.session.set({'tab:42': {site: 'info', status: 'running', expires: Date.now()+10000, steps: {}}});
  await worker.click({id: 42, url: FORM});
  assert.equal(worker.navigations[0].url, INFO);
});
