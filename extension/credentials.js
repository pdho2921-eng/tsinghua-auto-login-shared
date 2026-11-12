/* Privileged entry points: settings may mutate credentials, exact login documents may read one. */
(() => {
  const roles = new Set(['identity', 'mail']);
  const failure = error => ({ok: false, error});
  const sameAccount = (a, b, site) => site === 'mails'
    ? String(a).replace(/@mails\.tsinghua\.edu\.cn$/i, '') === String(b).replace(/@mails\.tsinghua\.edu\.cn$/i, '')
    : a === b;
  const isSettings = (chrome, sender) => sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL('options.html') && (sender.frameId === undefined || sender.frameId === 0);

  async function manage(chrome, message, sender) {
    if (!isSettings(chrome, sender)) return failure('denied');
    const {op, role} = message;
    if (op === 'vault-status') return THUNative.call(chrome, {op: 'status'});
    if (!roles.has(role) || !['vault-save', 'vault-delete'].includes(op)) return failure('invalid-request');
    if (op === 'vault-save' && (typeof message.username !== 'string' || !message.username.trim() ||
      message.username.length > 160 || typeof message.password !== 'string' || !message.password || message.password.length > 4096)) return failure('invalid-request');
    const result = await THUNative.call(chrome, op === 'vault-delete' ? {op: 'delete', role}
      : {op: 'save', role, username: message.username.trim(), password: message.password});
    if (result.ok) {
      // Invalidate any old in-flight attempt when credentials change.
      await chrome.storage.session.clear();
      const field = role === 'identity' ? 'username' : 'mailUsername';
      await chrome.storage.local.set({[field]: op === 'vault-save' ? message.username.trim() : '', pausedSites: {}, retryAfter: 0});
    }
    return result;
  }

  async function inspect(chrome, sender, state, expectedUsername) {
    const tab = await chrome.tabs.get(sender.tab.id);
    if (tab.url !== sender.url || tab.pendingUrl) return null;
    const results = await chrome.scripting.executeScript({
      target: {tabId: sender.tab.id, documentIds: [sender.documentId]},
      world: 'ISOLATED',
      func: (username, site) => globalThis.THUInspect?.({expectedUsername: username, site}) || null,
      args: [expectedUsername, state.site]
    });
    const r = results[0];
    if (results.length !== 1 || r.frameId !== 0 || r.documentId !== sender.documentId || r.result?.url !== sender.url) return null;
    return r.result;
  }
  async function readyForSubmit(chrome, sender, state, expectedUsername) {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) ||
      !sender.documentId || (sender.documentLifecycle && sender.documentLifecycle !== 'active') ||
      state?.status !== 'running' || state.expires <= Date.now() || !expectedUsername ||
      !['form', 'mail-login'].includes(THU.kind(sender.url))) return false;
    try {
      const before = await inspect(chrome, sender, state, expectedUsername);
      if (!before || state.steps[THU.submitAction(before)] || before.userEdited || THU.submission(before) !== 'submit') return false;
      // Read-only page-world probe: handlers are not visible in the content script's isolated world.
      // It returns one boolean and never reads a username, password, request body, or stored credential.
      const results = await chrome.scripting.executeScript({
        target: {tabId: sender.tab.id, documentIds: [sender.documentId]}, world: 'MAIN',
        func: () => {
          if (document.readyState !== 'complete') return false;
          const visible = el => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
          const passwords = [...document.querySelectorAll('input[type=password]')].filter(visible);
          if (passwords.length !== 1 || !passwords[0].form) return false;
          const form = passwords[0].form;
          const buttons = [...form.querySelectorAll('button,input[type=submit],input[type=button],a[type=button],[role=button]')]
            .filter(el => visible(el) && /^(登录|登錄|Login|Signin)$/i.test((el.innerText || el.value || el.textContent || '').replace(/[\uE000-\uF8FF\s]+/g, '')));
          if (buttons.length !== 1) return false;
          const button = buttons[0];
          if (button.disabled || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('aria-busy') === 'true' ||
            form.getAttribute('aria-busy') === 'true' || button.classList.contains('disabled')) return false;
          // The school's optional #fingerGenPrint3 can remain empty on a fresh Mac.
          // Its own login handler still accepts the form and handles any extra verification.
          // Do not turn that field into an extension-only prerequisite for clicking Login.
          if (typeof button.onclick === 'function' || button.type === 'submit') return true;
          // Observed Coremail handler: $('.j-submit').click(handler). Read only its readiness flag.
          return Object.keys(button).some(key => /^jQuery/.test(key) &&
            button[key]?.events?.click?.some(event => typeof event.handler === 'function'));
        }
      });
      if (results.length !== 1 || results[0].frameId !== 0 || results[0].documentId !== sender.documentId || results[0].result !== true) return false;
      const after = await inspect(chrome, sender, state, expectedUsername);
      return !!after && !after.userEdited && THU.submitAction(after) === THU.submitAction(before) && THU.submission(after) === 'submit';
    } catch { return false; }
  }
  async function readForPage(chrome, sender, state, expectedUsername, role = state?.site === 'mails' ? 'mail' : 'identity') {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) ||
      !sender.documentId || (sender.documentLifecycle && sender.documentLifecycle !== 'active') || !expectedUsername ||
      state?.status !== 'running' || state.expires <= Date.now() ||
      !['form', 'mail-login'].includes(THU.kind(sender.url)) || !roles.has(role) || (state.site !== 'mails' && role !== 'identity')) return failure('denied');
    try {
      const before = await inspect(chrome, sender, state, expectedUsername);
      if (!before || state.steps[THU.submitAction(before)]) return failure('denied');
      if (THU.filling(before) === 'manual-input') return failure('manual-input');
      if (THU.filling(before) !== 'waiting-for-fill') return failure('denied');
      const result = await THUNative.call(chrome, {op: 'get', role});
      if (!result.ok) return result;
      if (typeof result.password !== 'string' || !result.password || typeof result.username !== 'string' ||
        !sameAccount(result.username, expectedUsername, state.site)) return failure('wrong-account');
      const after = await inspect(chrome, sender, state, expectedUsername);
      const latest = (await chrome.storage.session.get(`tab:${sender.tab.id}`))[`tab:${sender.tab.id}`];
      if (!latest || latest.status !== 'running' || latest.expires !== state.expires || latest.steps[THU.submitAction(before)]) return failure('changed-page');
      const settings = await chrome.storage.local.get({username: '', mailUsername: '', automatic: true, siteAutomatic: {}});
      const currentCredential = THU.credentialFor(state.site, settings);
      if ((!state.manual && !THU.automaticAllowed(state.site, settings)) || currentCredential.role !== role ||
        !sameAccount(currentCredential.username, expectedUsername, state.site)) return failure('changed-page');
      if (after && THU.filling(after) === 'manual-input') return failure('manual-input');
      if (state.expires <= Date.now() || !after || THU.submitAction(after) !== THU.submitAction(before) || THU.filling(after) !== 'waiting-for-fill') return failure('changed-page');
      // Returned only to the initiating extension content script, never to a page message channel.
      return {ok: true, username: result.username, password: result.password};
    } catch { return failure('changed-page'); }
  }
  globalThis.THUCredentials = {manage, readForPage, readyForSubmit};
  if (typeof module !== 'undefined') module.exports = globalThis.THUCredentials;
})();
