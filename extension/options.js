const $ = id => document.getElementById(id);
const roles = ['identity', 'mail'];
let checking = false;
const messageFor = result => THUNative.errors[result?.error] || '操作未完成，请检查本机助手连接后重试。';
async function send(message) {
  try { return await chrome.runtime.sendMessage(message); }
  catch { return {ok: false, error: 'helper-unavailable'}; }
}
async function check() {
  if (checking) return;
  checking = true; $('check').disabled = true;
  $('connection-status').textContent = '正在检查本机助手…';
  try {
    const result = await send({op: 'vault-status'});
    $('connection-indicator').textContent = result?.ok ? '已连接' : '需要处理';
    $('connection-indicator').dataset.enabled = String(!!result?.ok);
    $('connection-status').textContent = result?.ok ? `本机助手已连接（${result.version}）。可以保存或更新账号密码。` : messageFor(result);
    $('install-help').open = !result?.ok;
    if (result?.ok) {
      const accounts = result.accounts || {};
      for (const role of roles) {
        const account = accounts[role];
        if (!$(`${role}-username`).value) $(`${role}-username`).value = account?.username || '';
        $(`${role}-state`).textContent = account?.configured ? '已保存' : '未保存';
        $(`${role}-delete`).disabled = !account?.configured;
      }
      await chrome.storage.local.set({username: accounts.identity?.username || '', mailUsername: accounts.mail?.username || ''});
    }
  } finally { checking = false; $('check').disabled = false; }
}
$('check').addEventListener('click', check);
for (const role of roles) {
  $(`${role}-form`).addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, controls = [...form.querySelectorAll('button,input')];
    const username = $(`${role}-username`).value.trim();
    const passwordField = $(`${role}-password`);
    controls.forEach(el => { el.disabled = true; });
    $(`${role}-result`).textContent = '正在保存到登录钥匙串…';
    try {
      const request = {op: 'vault-save', role, username, password: passwordField.value};
      passwordField.value = '';
      const pending = send(request); request.password = '';
      const result = await pending;
      $(`${role}-result`).textContent = result?.ok ? '已保存。刷新对应网站，或点击工具栏图标开始。' : messageFor(result);
      if (result?.ok) await chrome.storage.local.set({automatic: $('automatic').checked, paused: false, pausedSites: {}, retryAfter: 0});
    } finally { controls.forEach(el => { el.disabled = false; }); await check(); }
  });
  $(`${role}-delete`).addEventListener('click', async () => {
    if (!confirm('删除本机保存的此账号密码？对应网站将停止自动登录。')) return;
    $(`${role}-delete`).disabled = true;
    const result = await send({op: 'vault-delete', role});
    if (result?.ok) $(`${role}-username`).value = '';
    $(`${role}-result`).textContent = result?.ok ? '已从登录钥匙串删除。' : messageFor(result);
    await check();
  });
}
$('automatic').addEventListener('change', async () => {
  const automatic = $('automatic').checked;
  await chrome.storage.local.set({automatic, pausedSites: {}, retryAfter: 0});
  await chrome.storage.session.clear();
  $('mode-result').textContent = automatic ? '已开启。请刷新需要登录的网页。' : '已关闭自动模式。当前流程会停止；仍可点击工具栏图标手动启动。';
});
void chrome.storage.local.get({automatic: true}).then(settings => { $('automatic').checked = settings.automatic; });
void check();
