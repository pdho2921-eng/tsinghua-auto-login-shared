const {contentGlobals, element} = require('./support.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const THU = require('../extension/policy.js');
const visible = {dispatchEvent() {}, getClientRects() { return [{}]; }};
function control(text, click = () => {}) { return {...visible, innerText: text, click}; }
function dialog(text, buttons) { return {...visible, innerText: text, contains: el => buttons.includes(el), querySelectorAll: () => buttons}; }
async function run({url, text, dialogs = [], loginControls = [], mailForm = false, password = 'fixture-secret', username = 'fixture-user'} = {}) {
  let interval, currentText = text, submits = 0, time = 0;
  const messages = [], navigations = [], claims = new Set(), notes = new Map();
  const user = {...visible, type: 'text', value: username};
  const pass = {...visible, type: 'password', value: password};
  const login = control('登录', () => { submits++; });
  const form = {action: 'https://mails.tsinghua.edu.cn/coremail/index.jsp?cus=1', matches: s => s === 'form.j-login-form',
    querySelector: () => ({value: 'mails.tsinghua.edu.cn'}), querySelectorAll: s => s === 'input' ? [user, pass] : [login]};
  pass.form = form;
  const document = {visibilityState: 'visible', body: {get innerText() {return currentText;}, append(el) {notes.set(el.id,el);}},
    querySelectorAll(s) { if (s === '.u-dialog,[role=dialog]') return dialogs; if (s === '.onload') return loginControls;
      if (s === 'input[type=password]') return mailForm ? [pass] : []; if (s === 'input,iframe') return mailForm ? [user,pass] : []; return []; },
    getElementById: id => notes.get(id), createElement: element, addEventListener() {}};
  const window = {}; window.top = window;
  const context = vm.createContext({...contentGlobals, THU, document, window, URL, Date: {now: () => time},
    location: {href: url, assign: u => navigations.push(u), reload: () => navigations.push('reload')},
    setInterval(fn) {interval = fn; return 1;}, clearInterval() {}, getComputedStyle: () => ({visibility: 'visible'}),
    chrome: {runtime: {id: 'fixture-extension', async sendMessage(message) {
      messages.push(message);
      if(message.op === 'begin') return {site: message.site, status: 'running', expectedUsername: 'fixture-user'};
      if(message.op === 'get-credential') return {ok: true, username: 'fixture-user', password: 'fixture-secret'};
      if(message.op === 'claim') {if(claims.has(message.action)) return false;claims.add(message.action);return true;}
      return true;
    }}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8'), context);
  await new Promise(setImmediate);
  return {messages,navigations,get submits(){return submits;},setText(t){currentText=t;},async tick(ms = 700){time += ms;interval();await new Promise(setImmediate);}};
}
test('portal stale workbench with no-access error follows the observed official login route once', async () => {
  const p = await run({url: THU.SITES.info.home, text: '我的工作台 退出 用户未登录，无权限访问。'});
  await p.tick();
  assert.deepEqual(p.navigations, [THU.SITES.info.login]);
  assert.equal(p.messages.some(m => m.op === 'done'), false);
  assert.equal(p.messages[0].site, 'info');
});
test('public portal login control is recognized and logged-in portal remains in place', async () => {
  const entry = await run({url: 'https://info.tsinghua.edu.cn/', text: '清华大学信息门户 登录', loginControls: [control('登录')]});
  assert.deepEqual(entry.navigations, [THU.SITES.info.login]);
  const home = await run({url: THU.SITES.info.home, text: '我的工作台 退出'});
  assert.equal(home.messages.length, 0);
  await home.tick(3000);
  assert.equal(home.messages[0].op, 'done');
  assert.deepEqual(home.navigations, []);
  home.setText('我的工作台 退出 用户未登录，无权限访问。'); await home.tick();
  assert.deepEqual(home.navigations, [THU.SITES.info.login]);
});
test('mail expiration confirms only its initialization-error dialog, never the underlying relogin button twice', async () => {
  let confirmed=0,relogged=0;
  const confirm=control('确定',()=>confirmed++), relogin=control('重新登录',()=>relogged++);
  const p = await run({url:'https://mails.tsinghua.edu.cn/coremail/XT/index.jsp',text:'系统信息 会话已过期, 请重新登录 初始化用户信息失败 确定',
    dialogs:[dialog('系统信息 会话已过期, 请重新登录 重新登录',[relogin]),dialog('系统信息 初始化用户信息失败 确定',[confirm])]});
  await p.tick();
  assert.equal(confirmed,1);assert.equal(relogged,0);
  assert.equal(p.messages.some(m=>m.op==='claim'&&m.action==='mail-confirm'),true);
});
test('remaining session-expired dialog can relogin, but an ordinary confirmation or message body cannot', async () => {
  let clicked=0;
  const relogin=control('重新登录',()=>clicked++);
  await run({url:'https://mails.tsinghua.edu.cn/coremail/XT/index.jsp',text:'会话已过期, 请重新登录',dialogs:[dialog('系统信息 会话已过期, 请重新登录 重新登录',[relogin])]});
  assert.equal(clicked,1);
  const confirm=control('确定',()=>clicked++);
  const ordinary=await run({url:'https://mails.tsinghua.edu.cn/coremail/XT/index.jsp',text:'邮件正文提到 初始化用户信息失败 确定',dialogs:[dialog('是否删除邮件 确定',[confirm])]});
  assert.equal(clicked,1);assert.equal(ordinary.messages.some(m=>m.op==='claim'),false);
});
test('mail uses the observed Coremail form and submits the shared account only once', async () => {
  const p=await run({url:THU.SITES.mails.home,text:'邮箱账号登录 用户名 密码 登录',mailForm:true,username:'fixture-user@mails.tsinghua.edu.cn'});
  await p.tick();assert.equal(p.submits,1);
  assert.equal(p.messages.some(m=>m.site==='mails'&&m.action==='submit'),true);
  assert.equal(JSON.stringify(p.messages).includes('fixture-secret'),false);
});
test('mail errors and verification prompts stop without submit', async () => {
  for(const text of ['邮箱账号登录 用户名或密码错误','邮箱账号登录 请输入验证码']) {
    const p=await run({url:THU.SITES.mails.home,text,mailForm:true});
    assert.equal(p.submits,0);assert.equal(p.messages.some(m=>m.op==='stop'),true);
  }
});
test('mail recognizes spaced navigation labels after its session check settles', async () => {
  const p = await run({url: 'https://mails.tsinghua.edu.cn/coremail/XT/index.jsp', text: '退出 写 信 收件箱'});
  assert.equal(p.messages.length, 0);
  await p.tick(3000);
  assert.equal(p.messages.filter(m => m.op === 'done').length, 1);
  await p.tick();
  assert.equal(p.messages.filter(m => m.op === 'done').length, 1);
  assert.deepEqual(p.navigations, []);
});
