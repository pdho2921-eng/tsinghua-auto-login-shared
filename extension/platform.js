/* Only presentation differs by OS. Website policy and credential routing remain shared. */
(() => {
  const isWindows = /^win/i.test(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '');
  const windows = {
    'install-first': '解压完整试用包，双击“安装.exe”，等待显示安装完成。',
    'install-storage': '如提示无法访问已保存凭据，请确认正在使用原 Windows 账号；必要时重新保存密码。',
    'platform-support': 'Windows 试用目标为 Windows 11（Intel／AMD 64 位）＋Edge；兼容性以实机验收结果为准。',
    'storage-description': '密码由 Windows 加密保存在这台电脑，登录当前 Windows 账号后可自动使用',
    'uninstall-help': '卸载前可点击上方“删除已保存密码”，再运行试用包中的“卸载.exe”，最后在浏览器中移除扩展。'
  };
  const values = isWindows ? windows : {};
  globalThis.THUPlatform = {
    isWindows,
    saving: isWindows ? '正在由 Windows 加密保存…' : '正在保存到登录钥匙串…',
    deleted: isWindows ? '已删除本机保存的账号密码。' : '已从登录钥匙串删除。',
    apply(document) {
      for (const node of document.querySelectorAll('[data-platform]')) {
        if (values[node.dataset.platform]) node.textContent = values[node.dataset.platform];
      }
    }
  };
})();
