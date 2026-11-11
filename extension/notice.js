/* Shared rendering for school pages and the local visual preview. No credential access. */
(() => {
  const messages = Object.freeze({
    "context-retired": "助手扩展已重新加载或停用。请刷新此页面以加载当前版本。",
    "challenge": "学校要求额外验证，请在网页中自行完成。助手已停止，不会重复提交。",
    "login-error": "网页报告登录失败。助手已停止，请核对账号或密码。",
    "login-timeout": "自动登录等待超时。请在扩展设置页检查连接；需要重试时点击扩展按钮。",
    "changed-account": "填入的账号与助手设置不一致，已停止提交。",
    "wrong-destination": "表单提交地址不符合预期，已停止。",
    "wrong-application": "当前不是已支持网站的认证表单，助手不会提交。",
    "credential-unavailable": "未能取得已保存的密码。请打开扩展设置页检查连接。",
    "before-fill-changed": "填写前页面发生变化，请刷新后重试。",
    "after-username-changed": "填写账号后表单发生变化，请手动检查。",
    "before-submit-changed": "提交前页面或填写内容发生变化，助手已停止。请检查后重新启动。",
    "page-changed": "助手遇到页面变化，已停止。请手动登录或反馈当前页面。",
    "unrecognized-page": "助手未能识别当前页面，已停止。"
});
  function show(document, message, openSettings) {
    let el = document.getElementById('thu-login-helper-message');
    if (!el) {
      el = document.createElement('div'); el.id = 'thu-login-helper-message';
      el.style.cssText = 'position:fixed;bottom:20px;right:20px;box-sizing:border-box;width:430px;max-width:calc(100vw - 40px);padding:18px 20px;background:#fff7f7;color:#762d35;border:2px solid #b84b58;border-left-width:7px;border-radius:12px;box-shadow:0 8px 32px #42202838;z-index:2147483647;font:14px/1.7 system-ui,sans-serif;text-align:left;';
      el.setAttribute('role', 'alert'); el.setAttribute('aria-live', 'assertive');
      document.body.append(el);
    }
    el.textContent = message;
    const title = document.createElement('strong'); title.textContent = '自动登录已暂停';
    title.style.cssText = 'display:block;font-size:17px;line-height:1.5;margin-bottom:8px;color:#862e3d;';
    el.prepend(title);
    const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:10px;margin-top:14px;';
    const settings = document.createElement('button'); settings.type = 'button'; settings.textContent = '打开设置';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭提示';
    for (const button of [settings, close]) button.style.cssText = 'padding:6px 12px;border:1px solid #aeb7c5;border-radius:7px;background:#fff;color:#344357;font:13px/1.6 system-ui;cursor:pointer;';
    settings.addEventListener('click', openSettings || (() => {}));
    close.addEventListener('click', () => el.remove());
    if (openSettings) actions.append(settings);
    actions.append(close); el.append(actions);
  }
  globalThis.THUNotice = {show, messages};
  if (typeof module !== "undefined") module.exports = globalThis.THUNotice;
})();
