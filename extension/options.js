const $ = id => document.getElementById(id);
const roles = ['identity', 'mail'];
let checking = false;
let connectionNoticeTimer;
function hideConnectionNotice() {
  clearTimeout(connectionNoticeTimer);
  $('connection-success').hidden = true;
}
$('dismiss-connection-success').addEventListener('click', hideConnectionNotice);
const configured = {identity: false, mail: false};
function syncFieldTools() {
  for (const button of document.querySelectorAll('[data-copy-from]')) {
    button.disabled = !$(button.dataset.copyFrom).value || $(button.dataset.copyTo).disabled;
  }
  for (const button of document.querySelectorAll('[data-reveal]')) {
    const input = $(button.dataset.reveal);
    button.disabled = !input.value || input.disabled;
    if (!input.value) {
      input.type = 'password'; button.setAttribute('aria-pressed', 'false');
      button.title = '显示密码'; button.setAttribute('aria-label', '显示密码');
    }
  }
  for (const role of roles) $(`${role}-delete`).disabled = !configured[role] || $(`${role}-form`).dataset.busy === 'true';
}
for (const button of document.querySelectorAll('[data-copy-from]')) {
  button.addEventListener('click', () => {
    const target = $(button.dataset.copyTo);
    target.value = $(button.dataset.copyFrom).value;
    target.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
for (const button of document.querySelectorAll('[data-reveal]')) {
  button.addEventListener('click', () => {
    const input = $(button.dataset.reveal), showing = input.type === 'password';
    input.type = showing ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(showing));
    button.title = showing ? '隐藏密码' : '显示密码';
    button.setAttribute('aria-label', button.title);
  });
}
for (const input of document.querySelectorAll('.fields input')) input.addEventListener('input', syncFieldTools);
const messageFor = result => THUNative.errors[result?.error] || '操作未完成，请检查本机助手连接后重试。';
async function send(message) {
  try { return await chrome.runtime.sendMessage(message); }
  catch { return {ok: false, error: 'helper-unavailable'}; }
}
async function check({notifySuccess = false} = {}) {
  if (checking) return;
  hideConnectionNotice();
  checking = true; $('check').disabled = true;
  $('check').setAttribute('aria-busy', 'true');
  $('connection-status').textContent = '正在检查本机助手…';
  try {
    const result = await send({op: 'vault-status'});
    $('connection-indicator').textContent = result?.ok ? '已连接' : '需要处理';
    $('connection-indicator').dataset.enabled = String(!!result?.ok);
    $('connection-status').dataset.state = result?.ok ? 'success' : 'error';
    $('connection-status').textContent = result?.ok ? `本机助手已连接（助手版本 ${result.version}）。可以保存或更新账号密码。` : messageFor(result);
    $('install-help').open = !result?.ok;
    if (result?.ok) {
      const accounts = result.accounts || {};
      for (const role of roles) {
        const account = accounts[role];
        configured[role] = !!account?.configured;
        if (!$(`${role}-username`).value) $(`${role}-username`).value = account?.username || '';
        $(`${role}-state`).textContent = account?.configured ? '已保存' : (role === 'mail' && accounts.identity?.configured ? '使用清华账号' : '未保存');
        $(`${role}-delete`).disabled = !account?.configured;
      }
      await chrome.storage.local.set({username: accounts.identity?.username || '', mailUsername: accounts.mail?.username || ''});
      if (notifySuccess) {
        $('connection-success').hidden = false;
        connectionNoticeTimer = setTimeout(hideConnectionNotice, 6000);
      }
    }
  } finally { checking = false; $('check').disabled = false; $('check').removeAttribute('aria-busy'); syncFieldTools(); }
}
$('check').addEventListener('click', () => check({notifySuccess: true}));
for (const role of roles) {
  $(`${role}-form`).addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, controls = [...form.querySelectorAll('button,input')];
    const username = $(`${role}-username`).value.trim();
    const passwordField = $(`${role}-password`);
    controls.forEach(el => { el.disabled = true; });
    form.dataset.busy = 'true';
    form.querySelector('[type=submit]').setAttribute('aria-busy', 'true');
    $(`${role}-result`).textContent = '正在保存到登录钥匙串…';
    try {
      const request = {op: 'vault-save', role, username, password: passwordField.value};
      passwordField.value = '';
      syncFieldTools();
      const pending = send(request); request.password = '';
      const result = await pending;
      $(`${role}-result`).textContent = result?.ok ? '已保存。刷新对应网站，或点击工具栏图标开始。' : messageFor(result);
      $(`${role}-result`).dataset.state = result?.ok ? 'success' : 'error';
      if (result?.ok) await chrome.storage.local.set({automatic: $('automatic').checked, paused: false, pausedSites: {}, retryAfter: 0});
    } finally {
      form.dataset.busy = 'false'; form.querySelector('[type=submit]').removeAttribute('aria-busy');
      controls.forEach(el => { el.disabled = false; }); syncFieldTools(); await check();
    }
  });
  $(`${role}-delete`).addEventListener('click', async () => {
    const confirmation = role === 'mail'
      ? '删除单独保存的邮箱账号密码？邮箱将改用清华账号。'
      : '删除本机保存的清华账号密码？使用此凭据的网站将停止自动登录。';
    if (!confirm(confirmation)) return;
    $(`${role}-delete`).disabled = true;
    $(`${role}-delete`).setAttribute('aria-busy', 'true');
    const result = await send({op: 'vault-delete', role});
    if (result?.ok) $(`${role}-username`).value = '';
    $(`${role}-result`).textContent = result?.ok ? '已从登录钥匙串删除。' : messageFor(result);
    $(`${role}-result`).dataset.state = result?.ok ? 'success' : 'error';
    $(`${role}-delete`).removeAttribute('aria-busy');
    await check();
  });
}
$('automatic').addEventListener('change', async () => {
  const automatic = $('automatic').checked;
  await chrome.storage.local.set({automatic, pausedSites: {}, retryAfter: 0});
  await chrome.storage.session.clear();
  $('mode-result').textContent = automatic ? '已开启。请刷新需要登录的网页。' : '已关闭自动模式。可点击工具栏图标手动执行登录，右键图标选择‘选项’可返回本界面修改设置';
});
let siteSettingsQueue = Promise.resolve();
for (const site of Object.keys(THU.SITES)) {
  $(`auto-${site}`).addEventListener('change', () => {
    const enabled = $(`auto-${site}`).checked;
    siteSettingsQueue = siteSettingsQueue.then(async () => {
      const settings = await chrome.storage.local.get({siteAutomatic: {}});
      await chrome.storage.local.set({siteAutomatic: {...settings.siteAutomatic, [site]: enabled}});
      // Cancel only this site's attempts; a different site's login can continue.
      const states = await chrome.storage.session.get(null);
      const keys = Object.keys(states).filter(key => key.startsWith('tab:') && states[key]?.site === site);
      if (keys.includes(`tab:${states.submitting?.tabId}`)) keys.push('submitting');
      if (keys.length) await chrome.storage.session.remove(keys);
      $('site-mode-result').textContent = enabled
        ? `已开启${THU.SITES[site].name}的自动登录。请刷新对应网页。`
        : `已关闭${THU.SITES[site].name}的自动登录。仍可点击工具栏图标手动执行登录。`;
    }).catch(() => { $('site-mode-result').textContent = '设置未能保存，请刷新本页后重试。'; });
  });
}
void chrome.storage.local.get({automatic: true, siteAutomatic: {}}).then(settings => {
  $('automatic').checked = settings.automatic;
  for (const site of Object.keys(THU.SITES)) $(`auto-${site}`).checked = settings.siteAutomatic[site] !== false;
});
void check();
syncFieldTools();
