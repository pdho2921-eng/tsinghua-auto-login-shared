/* The only native transport. No secret is cached, logged or written to Chrome storage. */
(() => {
  const HOST = 'local.tsinghua_login_shared';
  const VERSION = 1;
  const errors = {
    'helper-unavailable': '尚未连接本机助手。请先运行安装文件，再点击“检查连接”。',
    'helper-timeout': '本机助手没有及时响应。请检查系统授权窗口，再重试。',
    'protocol-mismatch': '扩展与本机助手版本不匹配，请重新安装同一份试用包。',
    'keychain-locked': '登录钥匙串已锁定或尚未授权。请解锁钥匙串；更新助手后可重新保存密码。',
    'not-found': '尚未保存此网站的账号密码，请打开扩展设置页完成配置。',
    'invalid-request': '填写内容不完整，请检查账号和密码。',
    'storage-error': '未能访问系统钥匙串，请检查系统授权后重试。',
    'changed-page': '登录页面已变化，请刷新后重试。',
    'wrong-account': '网页中的账号与已保存账号不一致，请清空网页账号后重试。',
    'denied': '当前页面不符合自动填写条件。'
  };
  async function call(chrome, request) {
    return new Promise(resolve => {
      let port, settled = false;
      const finish = value => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { port?.disconnect(); } catch { /* already closed */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish({ok: false, error: 'helper-timeout'}), 12_000);
      try {
        port = chrome.runtime.connectNative(HOST);
        port.onMessage.addListener(result => {
          if (!result || result.protocol !== VERSION || typeof result.ok !== 'boolean') {
            finish({ok: false, error: 'protocol-mismatch'});
          } else finish(result);
        });
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          finish({ok: false, error: 'helper-unavailable'});
        });
        port.postMessage({...request, protocol: VERSION});
      } catch { finish({ok: false, error: 'helper-unavailable'}); }
    });
  }
  globalThis.THUNative = {call, errors};
  if (typeof module !== 'undefined') module.exports = globalThis.THUNative;
})();
