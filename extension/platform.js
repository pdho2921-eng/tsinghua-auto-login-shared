/* Only presentation differs by OS. Website policy and credential routing remain shared. */
(() => {
  const isWindows = /^win/i.test(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '');
  const windows = {
    'install-first': '解压完整试用包，双击“安装.exe”，等待显示安装完成。',
    'install-storage': '如提示无法访问已保存凭据，请确认正在使用原 Windows 账号；必要时重新保存密码。',
    'platform-support': '已在 Windows 11＋Edge 上做过简单测试，Windows 10 及以下版本、Windows Chrome 仍待实测反馈。',
    'storage-description': '密码由 Windows 加密保存在这台电脑，登录当前 Windows 账号后可自动使用',
    'manual-help': '关闭后，仍可点击工具栏图标或下方“打开网站”手动登录。右键图标选择“扩展选项”可返回设置页。',
    'uninstall-help': '如需卸载，先点击对应账号的“删除已保存密码”，再运行安装包中的“卸载.exe”，最后在浏览器中移除扩展。只运行卸载会保留已保存的账号密码。'
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
