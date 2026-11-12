/* Presentation only: no messages to the helper, storage access, or login actions. */
const cases = [
  ['login-error', '学校报告账号或密码错误'],
  ['manual-input', '主动编辑登录信息'],
  ['challenge', '学校要求额外验证'],
  ['helper-unavailable', '尚未连接本机助手'],
  ['helper-timeout', '本机助手响应超时'],
  ['protocol-mismatch', '扩展与助手不兼容'],
  ['keychain-locked', globalThis.THUPlatform?.isWindows ? 'Windows 凭据无法读取' : '钥匙串锁定或未授权'],
  ['not-found', '尚未保存账号密码'],
  ['invalid-request', '填写内容不完整'],
  ['storage-error', globalThis.THUPlatform?.isWindows ? 'Windows 加密凭据访问失败' : '系统钥匙串访问失败'],
  ['wrong-account', '保存的账号与设置不一致'],
  ['changed-page', '取用期间页面变化'],
  ['denied', '页面不符合填写条件'],
  ['login-timeout', '自动登录等待超时'],
  ['changed-account', '填写后账号被改动'],
  ['wrong-destination', '提交地址不符合预期'],
  ['wrong-application', '不支持的认证表单'],
  ['credential-unavailable', '未能取得已保存密码'],
  ['before-fill-changed', '填写前页面变化'],
  ['after-username-changed', '填写账号后表单变化'],
  ['before-submit-changed', '提交前页面变化'],
  ['page-changed', '页面处理异常'],
  ['unrecognized-page', '未能识别页面'],
  ['context-retired', '扩展已重新加载或停用']
];
const picker = document.getElementById('scenario');
for (const [key, label] of cases) {
  const option = document.createElement('option');
  option.value = key; option.textContent = label; picker.append(option);
}
function openSettings() {
  if (location.protocol === 'chrome-extension:' && globalThis.chrome?.runtime?.openOptionsPage) {
    void chrome.runtime.openOptionsPage();
  } else {
    document.getElementById('preview-status').textContent = '此处仅预览按钮效果。实际使用时会打开扩展设置页。';
  }
}
function show() {
  document.getElementById('preview-status').textContent = '';
  THUNotice.show(document, THUNotice.messages[picker.value] || THUNative.errors[picker.value],
    picker.value === 'context-retired' ? null : openSettings);
}
picker.addEventListener('change', show);
document.getElementById('show-again').addEventListener('click', show);
show();
