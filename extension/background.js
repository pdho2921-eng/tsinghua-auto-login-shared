importScripts('policy.js', 'native.js', 'credentials.js');
// Ordinary settings remain inaccessible to website content scripts.
void chrome.storage.local.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'});
const TTL = 120_000;
const COOLDOWN = 600_000;
let queue = Promise.resolve();
const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
const fresh = (site = 'learn') => ({site, status: 'running', expires: Date.now() + TTL, steps: {}});
const key = id => `tab:${id}`;
async function badge(tabId, text, title) {
  await chrome.action.setBadgeText({tabId, text});
  await chrome.action.setTitle({tabId, title});
}
async function handle(message, sender) {
  if (!message || typeof message.op !== 'string') return null;
  if (message.op.startsWith('vault-')) return THUCredentials.manage(chrome, message, sender);
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || THU.kind(sender.url) === 'other') return null;
  const tabId = sender.tab.id, storageKey = key(tabId);
  const settings = await chrome.storage.local.get({username: '', mailUsername: '', automatic: false, paused: false, pausedSites: {}, retryAfter: 0});
  const stored = await chrome.storage.session.get(storageKey);
  let state = stored[storageKey];
  const page = THU.kind(sender.url);
  const site = THU.siteFor(sender.url) || (page === 'form' && ['learn', 'info'].includes(message.site) ? message.site : null);
  // Identity forms must stay bound to the application that began this attempt.
  if (state && site && (state.site || 'learn') !== site) {
    if (page === 'form' && state.status === 'running') return null;
    state = null;
  }
  if (message.op === 'get-credential') {
    const expected = state?.site === 'mails' ? settings.mailUsername : settings.username;
    return THUCredentials.readForPage(chrome, sender, state, expected);
  }
  if (message.op === 'pause') {
    if (!site) return null;
    await chrome.storage.local.set({pausedSites: {...settings.pausedSites, [site]: true}});
    if (state) await chrome.storage.session.set({[storageKey]: {...state, status: 'paused'}});
    await badge(tabId, '停', '已暂停自动登录；点击扩展按钮可重新启动');
    return null;
  }
  if (message.op === 'begin') {
    if (!(site === 'mails' ? settings.mailUsername : settings.username)) return {status: 'unconfigured'};
    if (!state || state.status === 'done' || (['blocked', 'timeout'].includes(state.status) && state.expires <= Date.now() && settings.retryAfter <= Date.now())) {
      const eligible = !!site && (['learn', 'entry', 'info', 'mail-login', 'mail-app'].includes(page) || page === 'form');
      if (!eligible || !settings.automatic || settings.pausedSites[site] || (site === 'learn' && settings.paused) || settings.retryAfter > Date.now()) return null;
      state = fresh(site);
      await chrome.storage.session.set({[storageKey]: state});
    }
    if (state.status === 'running' && state.expires <= Date.now()) {
      state = {...state, status: 'timeout'};
      await chrome.storage.session.set({[storageKey]: state});
      await badge(tabId, '!', '登录超时；点击扩展按钮可手动重试');
    }
    return {...state, expectedUsername: state.site === 'mails' ? settings.mailUsername : settings.username};
  }
  if (message.op === 'claim') {
    if (!site || !state || (state.site || 'learn') !== site || !THU.actionAllowed(page, message.action)) return false;
    const next = THU.claim(state, message.action, Date.now());
    if (!next) return false;
    // Commit before clicking. Survives navigation, service-worker sleep, and concurrent messages.
    if (message.action === 'submit') {
      const active = await chrome.storage.session.get('submitting');
      if (active.submitting && active.submitting.until > Date.now() && active.submitting.tabId !== tabId) return false;
      await chrome.storage.session.set({submitting: {tabId, until: Date.now() + TTL}});
      await chrome.storage.local.set({retryAfter: Date.now() + COOLDOWN});
    }
    await chrome.storage.session.set({[storageKey]: next});
    return true;
  }
  if (message.op === 'done' && state?.status === 'running' && ['learn', 'info', 'mail-app'].includes(page) && (state.site || 'learn') === site) {
    await chrome.storage.session.set({[storageKey]: {...state, status: 'done'}});
    const active = await chrome.storage.session.get('submitting');
    if (active.submitting?.tabId === tabId) await chrome.storage.session.remove('submitting');
    await chrome.storage.local.set({retryAfter: 0});
    await badge(tabId, '✓', `已进入${THU.SITES[site].name}`);
    return true;
  }
  if (message.op === 'stop' && state?.status === 'running') {
    await chrome.storage.session.set({[storageKey]: {...state, status: 'blocked'}});
    await chrome.storage.local.set({retryAfter: Date.now() + COOLDOWN});
    await badge(tabId, '!', '自动登录已停止；请查看网页上的提示');
  }
  return null;
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  serial(() => handle(message, sender)).then(reply).catch(() => reply(null));
  return true;
});
chrome.action.onClicked.addListener(tab => serial(async () => {
  const settings = await chrome.storage.local.get({username: '', mailUsername: '', pausedSites: {}});
  if (!settings.username && !settings.mailUsername) return chrome.runtime.openOptionsPage();
  if (!Number.isInteger(tab?.id) || tab.id < 0) return;
  let context;
  try { context = await chrome.tabs.sendMessage(tab.id, {op: 'site-context'}, {frameId: 0}); } catch { /* Page may predate extension reload. */ }
  let site = (Object.hasOwn(THU.SITES, context?.site || '') && context.site) || THU.siteFor(tab.url);
  if (!site && ['form', 'redirect'].includes(THU.kind(tab.url))) {
    const saved = (await chrome.storage.session.get(key(tab.id)))[key(tab.id)];
    if (Object.hasOwn(THU.SITES, saved?.site || '')) site = saved.site;
    else { await badge(tab.id, '', '认证页面仍在加载；请稍后再次点击'); return; }
  }
  site ||= 'learn';
  if (!(site === 'mails' ? settings.mailUsername : settings.username)) return chrome.runtime.openOptionsPage();
  await chrome.storage.local.set({paused: false, pausedSites: {...settings.pausedSites, [site]: false}, retryAfter: 0});
  await chrome.storage.session.set({[key(tab.id)]: fresh(site)});
  await badge(tab.id, '', `正在重新进入${THU.SITES[site].name}`);
  await chrome.tabs.update(tab.id, {url: THU.SITES[site].home, active: true});
}).catch(() => {}));
chrome.tabs.onRemoved.addListener(id => { void serial(async () => {
  await chrome.storage.session.remove(key(id));
  const active = await chrome.storage.session.get('submitting');
  if (active.submitting?.tabId === id) await chrome.storage.session.remove('submitting');
}); });
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});
