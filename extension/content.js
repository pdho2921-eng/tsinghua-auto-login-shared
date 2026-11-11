(() => {
  if (window.top !== window || THU.kind(location.href) === 'other') return;
  const context = () => ({site: THU.siteFor(location.href, document.body?.innerText || '')});
  let activeSite = context().site;
  let busy = false, finished = false, retired = false, timer;
  let fillRequested = false, filledByHelper = false, userEdited = false, markedDone = false, loggedSince = null;
  const invalidContext = error => /Extension context invalidated/i.test(error?.message || '');
  function hasRuntime() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }
  function retire() {
    if (retired) return;
    retired = true; finished = true;
    clearInterval(timer);
    document.removeEventListener('click', handleLogout, true);
    for (const type of ['beforeinput', 'paste', 'drop', 'keydown']) document.removeEventListener(type, handleEdit, true);
    if (document.body) note(THUNotice.messages['context-retired']);
  }
  async function send(message) {
    if (retired || !hasRuntime()) { retire(); return null; }
    try {
      // Invalidated extension APIs may throw before returning a Promise.
      const result = await chrome.runtime.sendMessage({...message, site: activeSite});
      // A reply received across an extension reload must not continue the old flow.
      if (retired || !hasRuntime()) { retire(); return null; }
      return result;
    } catch (error) {
      if (invalidContext(error) || !hasRuntime()) retire();
      return null;
    }
  }
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const label = el => (el.innerText || el.value || el.textContent || '').trim().replace(/[\uE000-\uF8FF\s]+/g, '');
  const isLogin = el => /^(登录|登錄|Login|Signin)$/i.test(label(el));
  const note = message => THUNotice.show(document, message, retired ? null : () => { void send({op: 'open-settings'}); });
  async function stop(message) {
    if (retired) return;
    finished = true; clearInterval(timer); note(message);
    await send({op: 'stop'});
  }
  function getForm() {
    const passwords = [...document.querySelectorAll('input[type=password]')].filter(el => visible(el) && !el.disabled && !el.readOnly);
    if (passwords.length !== 1) return {passwords, usernames: [], buttons: [], action: ''};
    const password = passwords[0];
    let root = password.form || password.parentElement;
    if (!password.form) {
      while (root && root !== document.body && ![...root.querySelectorAll('button,input[type=submit],input[type=button],a[type=button],[role=button]')].some(el => visible(el) && isLogin(el))) root = root.parentElement;
    }
    if (!root) return {passwords, usernames: [], buttons: [], action: ''};
    const usernames = [...root.querySelectorAll('input')].filter(el => visible(el) && !el.disabled && ['text', 'email', 'tel'].includes(el.type) && !/captcha|验证码|one.time|otp/i.test([el.name, el.id, el.placeholder, el.autocomplete].join(' ')));
    const buttons = [...root.querySelectorAll('button,input[type=submit],input[type=button],a[type=button],[role=button]')].filter(el => visible(el) && isLogin(el) && !el.disabled);
    return {passwords, usernames, buttons, action: password.form?.action || location.href, mailForm: !!password.form?.matches?.('form.j-login-form'), mailDomain: password.form?.querySelector?.('input[name=domain]')?.value || ''};
  }
  function assessForm(state) {
    const text = document.body?.innerText || '';
    const form = getForm();
    const challenge = [...document.querySelectorAll('input,iframe')].some(el => visible(el) && /captcha|验证码|短信验证|一次性|one.time.code|\botp\b/i.test([el.name, el.id, el.placeholder, el.autocomplete, el.title, el.src].join(' '))) || /请(?:输入|完成).{0,10}(?:验证码|二次验证)|请使用企业微信|请进行身份验证/.test(text);
    const error = /(?:密码|用户名|账号).{0,8}(?:错误|不正确|不存在)|登录失败|尝试次数|账户.{0,6}锁定/.test(text);
    const snapshot = {url: location.href, site: state.site || activeSite, applicationText: THU.authSite(text) === 'learn' ? '您即将登录 网络学堂2018' : THU.authSite(text) === 'info' ? '您即将登录 清华大学信息门户' : '', expectedUsername: state.expectedUsername,
      usernameCount: form.usernames.length, passwordCount: form.passwords.length, buttonCount: form.buttons.length,
      username: form.usernames[0]?.value, passwordReady: !!form.passwords[0]?.value,
      action: form.action, mailForm: form.mailForm, mailDomain: form.mailDomain, challenge, error, userEdited};
    return {form, snapshot, decision: THU.submission(snapshot)};
  }
  // Only extension code in this isolated world can call this inspector. No password value leaves it.
  globalThis.THUInspect = state => assessForm(state).snapshot;
  function setInput(el, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  }
  function mailExpiredControls() {
    // Coremail uses u-dialog. Scope confirmation to the observed error, never ordinary mail dialogs.
    const dialogs = [...document.querySelectorAll('.u-dialog,[role=dialog]')].filter(visible);
    const specific = dialogs.filter(el => {
      const text = label(el);
      return text.length < 500 && /初始化用户信息失败|会话已过期[,，]?请重新登录/.test(text);
    });
    const controls = specific.flatMap(el => [...el.querySelectorAll('button,[role=button]')].filter(visible));
    const confirms = [...new Set(controls.filter(el => label(el) === '确定' && specific.some(d => d.contains(el) && label(d).includes('初始化用户信息失败'))))];
    const relogins = [...new Set(controls.filter(el => label(el) === '重新登录'))];
    return {expired: specific.length > 0, confirm: confirms.length === 1 ? confirms[0] : null, relogin: relogins.length === 1 ? relogins[0] : null};
  }
  async function tick() {
    if (retired) return;
    if (!hasRuntime()) { retire(); return; }
    if (busy || finished || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const type = THU.kind(location.href);
      const text = document.body?.innerText || '';
      activeSite = THU.siteFor(location.href, text) || activeSite;
      // The server renders rejected logins at /check. This route can report errors, never autofill or submit.
      if (type === 'auth-result') {
        if (!THU.authSite(text)) return;
        const {snapshot} = assessForm({site: activeSite});
        if (snapshot.challenge) await stop(THUNotice.messages['challenge']);
        else if (snapshot.error) await stop(THUNotice.messages['login-error']);
        return;
      }
      const mail = type === 'mail-app' ? mailExpiredControls() : null;
      const infoExpired = type === 'info' && /用户未登录[，,]?\s*无权限访问/.test(text);
      const infoLogin = type === 'info' && [...document.querySelectorAll('.onload')].some(el => visible(el) && isLogin(el));
      const loggedIn = (type === 'learn' && text.includes('所学课程') && !text.includes('您未登录或登录失效')) ||
        (type === 'info' && !infoExpired && !infoLogin && text.includes('退出') && text.includes('我的工作台')) ||
        (type === 'mail-app' && !mail.expired && text.includes('收件箱') && /写\s*信/.test(text));
      if (loggedIn) {
        // Portal/mail shells appear before their async session checks finish.
        loggedSince ??= Date.now();
        if (type !== 'learn' && Date.now() - loggedSince < 3_000) return;
        if (!markedDone) await send({op: 'done'});
        markedDone = true; return;
      }
      markedDone = false; loggedSince = null;
      if ((type === 'form' && !THU.authSite(text)) ||
          (type === 'info' && !infoExpired && !infoLogin) ||
          (type === 'mail-app' && !mail.expired) ||
          ['redirect', 'info-redirect'].includes(type)) return;
      const state = await send({op: 'begin'});
      if (!state || state.status !== 'running') {
        if (state?.status === 'timeout') await stop(THUNotice.messages['login-timeout']);
        finished = true; clearInterval(timer);
        return;
      }
      if (type === 'learn' && text.includes('您未登录或登录失效')) {
        const links = [...document.querySelectorAll('a')]
          .filter(el => visible(el) && label(el) === '登录网络学堂')
          .map(el => ({el, target: THU.expiredLoginTarget(el.getAttribute('href'), el.getAttribute('onclick'), location.href)}))
          .filter(link => link.target);
        if (links.length === 1 && await send({op: 'claim', action: 'expired-link'})) location.assign(links[0].target);
        return;
      }
      if (type === 'entry') {
        const buttons = [...document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button]')].filter(el => visible(el) && isLogin(el));
        if (buttons.length === 1 && await send({op: 'claim', action: 'entry-login'})) buttons[0].click();
        return;
      }
      if (type === 'info') {
        if (await send({op: 'claim', action: 'info-login'})) location.assign(THU.SITES.info.login);
        return;
      }
      if (type === 'mail-app') {
        if (mail.confirm && await send({op: 'claim', action: 'mail-confirm'})) mail.confirm.click();
        else if (!mail.confirm && mail.relogin && await send({op: 'claim', action: 'mail-relogin'})) mail.relogin.click();
        return;
      }
      if (!['form', 'mail-login'].includes(type)) return;
      // The application label can arrive after document_idle on a dynamic login page.
      if (type === 'form' && !text.includes('您即将登录')) return;
      const {form, snapshot, decision: submitDecision} = assessForm(state);
      const decision = filledByHelper ? submitDecision : THU.filling(snapshot);
      const reasons = {
        'challenge': THUNotice.messages['challenge'],
        'login-error': THUNotice.messages['login-error'],
        'wrong-account': THUNotice.messages['changed-account'],
        'wrong-destination': THUNotice.messages['wrong-destination'],
        'wrong-application': THUNotice.messages['wrong-application'],
        'manual-input': THUNative.errors['manual-input']
      };
      if (reasons[decision]) return stop(reasons[decision]);
      if (decision === 'waiting-for-fill' && !fillRequested) {
        fillRequested = true;
        const originalURL = location.href;
        const result = await send({op: 'get-credential'});
        if (retired || finished || userEdited) { if (result?.password) result.password = ''; return; }
        if (!result?.ok) return stop(THUNative.errors[result?.error] || THUNotice.messages['credential-unavailable']);
        const current = assessForm(state);
        if (location.href !== originalURL || document.visibilityState !== 'visible' || THU.filling(current.snapshot) !== 'waiting-for-fill' ||
          current.form.usernames[0] !== form.usernames[0] || current.form.passwords[0] !== form.passwords[0]) {
          result.password = ''; return stop(THUNotice.messages['before-fill-changed']);
        }
        setInput(form.usernames[0], result.username);
        const afterUser = assessForm(state);
        if (location.href !== originalURL || THU.filling(afterUser.snapshot) !== 'waiting-for-fill' || afterUser.form.passwords[0] !== form.passwords[0] ||
          afterUser.form.usernames[0] !== form.usernames[0] || afterUser.form.usernames[0].value !== result.username) {
          result.password = ''; return stop(THUNotice.messages['after-username-changed']);
        }
        setInput(form.passwords[0], result.password);
        result.password = '';
        filledByHelper = true;
        return;
      }
      if (decision === 'submit' && await send({op: 'claim', action: 'submit'})) {
        if (retired || finished || userEdited) return;
        const current = assessForm(state);
        if (current.decision !== 'submit' || current.form.buttons[0] !== form.buttons[0]) {
          return stop(THUNotice.messages['before-submit-changed']);
        }
        // Revalidate after filling and claim before submitting. Never send field passwords back to the worker.
        form.buttons[0].click();
      }
    } finally { busy = false; }
  }
  function handleLogout(event) {
    if (retired || !hasRuntime()) { retire(); return; }
    const target = event.target.closest?.('a,button,[role=button],#logout,.j-logout');
    if (target && /^(退出|退出登录|登出|注销)$/.test(label(target))) {
      finished = true; clearInterval(timer); void send({op: 'pause'});
    }
  }
  function handleEdit(event) {
    if (!event.isTrusted || retired || finished) return;
    if (event.type === 'keydown' && !(['Backspace', 'Delete', 'Enter'].includes(event.key) || (event.key?.length === 1 && !event.metaKey && !event.ctrlKey))) return;
    const form = getForm();
    if (!form.usernames.includes(event.target) && !form.passwords.includes(event.target)) return;
    userEdited = true;
    void stop(THUNative.errors['manual-input']);
  }
  if (!hasRuntime()) { retire(); return; }
  try {
    chrome.runtime.onMessage?.addListener((message, sender, reply) => {
      if (retired || !hasRuntime()) { retire(); return; }
      if (message.op === 'site-context') reply(context());
    });
  } catch (error) {
    if (invalidContext(error) || !hasRuntime()) { retire(); return; }
    throw error;
  }
  document.addEventListener('click', handleLogout, true);
  for (const type of ['beforeinput', 'paste', 'drop', 'keydown']) document.addEventListener(type, handleEdit, true);
  timer = setInterval(() => { void tick().catch(() => stop(THUNotice.messages['page-changed'])); }, 700);
  void tick().catch(() => stop(THUNotice.messages['unrecognized-page']));
})();
