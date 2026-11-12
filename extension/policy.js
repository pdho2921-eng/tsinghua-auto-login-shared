/* Pure site and submission rules. No passwords, cookies, or network APIs. */
(() => {
  const SITES = Object.freeze({
    learn: {name: '网络学堂', home: 'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/'},
    info: {name: '信息门户', home: 'https://info.tsinghua.edu.cn/f/info/gxfw_fg/common/index', login: 'https://info.tsinghua.edu.cn/f/redirectLoginUrl?type=u'},
    mails: {name: '学生邮箱', home: 'https://mails.tsinghua.edu.cn/'}
  });
  const HOME = SITES.learn.home;
  function trustedURL(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.port && !u.username && !u.password ? u : null; }
    catch { return null; }
  }
  function kind(value) {
    const u = trustedURL(value); if (!u) return 'other';
    if (u.hostname === 'learn.tsinghua.edu.cn') {
      if (/^\/f\/wlxt\//.test(u.pathname)) return 'learn';
      if (['/', '/f/login', '/f/redirectByStuOrTeacher'].includes(u.pathname)) return 'entry';
    }
    if (u.hostname === 'info.tsinghua.edu.cn') {
      if (u.pathname === '/' || /^\/f\/info(?:\/|_mobile\/)/.test(u.pathname)) return 'info';
      if (u.pathname === '/f/redirectLoginUrl') return 'info-redirect';
    }
    if (u.hostname === 'mails.tsinghua.edu.cn') {
      if (['/', '/coremail/', '/coremail/index.jsp'].includes(u.pathname)) return 'mail-login';
      if (u.pathname === '/coremail/XT/index.jsp') return 'mail-app';
    }
    if (u.hostname === 'id.tsinghua.edu.cn') {
      if (/^\/do\/off\/ui\/auth\/login\/form\/[^/]+(?:\/\d+)?\/?$/.test(u.pathname)) return 'form';
      if (u.pathname === '/do/off/ui/auth/login/check') return 'auth-result';
      if (u.pathname === '/do/off/ui/auth/login/checkSingle') return 'redirect';
    }
    return 'other';
  }
  function authSite(text = '') {
    const match = text.replace(/[\uE000-\uF8FF]/g, '').match(/您即将登录\s*[:：]?\s*(网络学堂2018|清华大学信息门户)(?=\s|$|[.。…])/);
    return match ? (match[1] === '网络学堂2018' ? 'learn' : 'info') : null;
  }
  function siteFor(value, text = '') {
    const u = trustedURL(value); if (!u) return null;
    const site = {'learn.tsinghua.edu.cn': 'learn', 'info.tsinghua.edu.cn': 'info', 'mails.tsinghua.edu.cn': 'mails'}[u.hostname];
    return site || (['form', 'auth-result'].includes(kind(value)) ? authSite(text) : null);
  }
  const isLearnApplication = text => authSite(text) === 'learn';
  const mailAccount = value => String(value || '').trim().replace(/@mails\.tsinghua\.edu\.cn$/i, '');
  function credentialFor(site, settings = {}) {
    const role = site === 'mails' && settings.mailUsername ? 'mail' : 'identity';
    return {role, username: Object.hasOwn(SITES, site || '') ? (role === 'mail' ? settings.mailUsername : settings.username) || '' : ''};
  }
  const automaticAllowed = (site, settings = {}) => !!settings.automatic && Object.hasOwn(SITES, site || '') && settings.siteAutomatic?.[site] !== false;
  function submission(s) {
    const page = kind(s.url), site = siteFor(s.url, s.applicationText);
    if (!['form', 'mail-login'].includes(page)) return 'wrong-page';
    if (!site || (s.site && s.site !== site)) return 'wrong-application';
    if (s.challenge) return 'challenge';
    if (s.error) return 'login-error';
    if (!s.expectedUsername) return 'unconfigured';
    if (s.usernameCount !== 1 || s.passwordCount !== 1 || s.buttonCount !== 1) return 'ambiguous-form';
    let action;
    try { action = trustedURL(new URL(s.action || s.url, s.url).href); } catch { return 'wrong-destination'; }
    if (page === 'form' && (!action || action.origin !== 'https://id.tsinghua.edu.cn' || action.pathname !== '/do/off/ui/auth/login/check')) return 'wrong-destination';
    if (page === 'mail-login' && (!s.mailForm || !action || action.origin !== 'https://mails.tsinghua.edu.cn' || action.pathname !== '/coremail/index.jsp' || (s.mailDomain && s.mailDomain !== 'mails.tsinghua.edu.cn'))) return 'wrong-destination';
    if (!s.username || !s.passwordReady) return 'waiting-for-fill';
    if (site === 'mails' ? mailAccount(s.username) !== mailAccount(s.expectedUsername) : s.username.trim() !== s.expectedUsername.trim()) return 'wrong-account';
    return 'submit';
  }
  function expiredLoginTarget(href, onclick, pageURL) {
    if (kind(pageURL) !== 'learn') return null;
    let target;
    if (typeof href === 'string' && href.trim()) {
      try { target = new URL(href, pageURL); } catch { return null; }
    } else if (typeof onclick === 'string' && /^\s*top\.document\.location\s*=\s*(['"])\/\1\s*;?\s*$/.test(onclick)) target = new URL('/', pageURL);
    else return null;
    return kind(target.href) === 'entry' ? target.href : null;
  }
  function filling(snapshot) {
    // Form ownership and destination still matter; its prefilled account is not our credential source.
    const decision = submission({...snapshot, username: '', passwordReady: false});
    return decision === 'waiting-for-fill' && snapshot.userEdited ? 'manual-input' : decision;
  }
  function actionAllowed(page, action) {
    return ({'expired-link': ['learn'], 'entry-login': ['entry'], 'info-login': ['info'],
      'mail-confirm': ['mail-app'], 'mail-relogin': ['mail-app'], submit: ['form', 'mail-login']})[action]?.includes(page) || false;
  }
  function claim(state, action, now) {
    if (!state || state.status !== 'running' || state.expires <= now) return null;
    if (!['expired-link', 'entry-login', 'info-login', 'mail-confirm', 'mail-relogin', 'submit'].includes(action) || state.steps[action]) return null;
    return {...state, steps: {...state.steps, [action]: true}};
  }
  const api = {HOME, SITES, kind, authSite, siteFor, isLearnApplication, credentialFor, automaticAllowed, submission, filling, expiredLoginTarget, actionAllowed, claim};
  globalThis.THU = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
