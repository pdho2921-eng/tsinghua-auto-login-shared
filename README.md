# 清华网站自动重登 · 试用版

学校网站经常退出登录，重复输入账号密码很麻烦。这个插件用于在登录失效后自动重新登录。首次保存账号密码后，可处理网络学堂、信息门户（含校外 WEBVPN）和学生邮箱的登录，并继续使用原标签页。

当前为初步完成版，提供 macOS 和 Windows 两份安装包。只简单测试过 Mac 上的 Chrome 和 Windows 11 上的 Edge，很可能还有没遇到的问题，欢迎反馈。

## 选择安装包

| 系统 | 安装包 | 使用说明 | 测试情况 |
| --- | --- | --- | --- |
| Mac | [下载 Mac 安装包](https://github.com/pdho2921-eng/tsinghua-auto-login-shared/releases/download/v0.1.9-preview.1/tsinghua-auto-login-shared-macos.zip) | [Mac 使用说明](docs/MACOS.md) | 简单测试过本机和虚拟机上的 Chrome；Intel 芯片、旧版 macOS 和 Mac Edge 仍待反馈 |
| Windows 11 x64 | [下载 Windows 安装包](https://github.com/pdho2921-eng/tsinghua-auto-login-shared/releases/download/v0.1.9-preview.1/tsinghua-auto-login-shared-windows-x64-test.zip) | [Windows 使用说明](docs/WINDOWS.md) | 简单测试过 Windows 11 + Edge；Windows 10 及以下版本、Windows Chrome 仍待反馈 |

解压后，Mac 运行 `安装.command`，Windows 运行 `安装.exe`，再按自动打开的说明加载扩展、检查连接并保存账号密码。

已有旧版时，直接运行新包中的安装文件即可更新。完成后，在浏览器扩展管理页重新加载扩展，再刷新学校网站。更新保留已保存的密码和自动登录开关。

两份安装包各自只包含本系统适用的文件。完整版本说明和文件校验值见[本次发布页](https://github.com/pdho2921-eng/tsinghua-auto-login-shared/releases/tag/v0.1.9-preview.1)。安装程序尚未获得系统认可的发布者签名，遇到系统拦截时请查看对应使用说明；许可证和文件校验值不能代替可信签名。

## 问题反馈

使用时遇到问题，可以在 [Issues](https://github.com/pdho2921-eng/tsinghua-auto-login-shared/issues) 中新建反馈。

请说明系统和浏览器版本、插件版本、出问题的网站，以及操作到哪一步失败。如果有提示，可以附上文字或截图；截图前遮住账号，不要发送密码、Cookie 或完整认证链接。

到达验证码或二次验证页面后，需要本人继续操作，这种情况不算自动提交失败。

## 使用方式

邮箱未单独保存凭据时使用清华账号，单独保存后优先使用邮箱凭据，删除后恢复回退。主动编辑登录框时暂停自动处理；收到验证码、二次验证或学校拒绝后停止，不循环提交密码。

插件适用范围由页面最下方的总开关与三个网站开关控制，默认均开启，可自行选择打开哪些网站的自动重连。日常使用时，在支持网站中左键工具栏图标在当前标签页手动激活重登，右键图标选择“选项”可返回设置页。

设置页的三个“打开网站”链接会新开标签页并启动一次登录，即使自动模式关闭，也允许这一次主动操作。遇到验证码或二次验证后停止，后续由本人继续操作。

密码由系统保存：Mac 使用登录钥匙串，Windows 使用当前用户 DPAPI 加密。详情见[隐私说明](PRIVACY.md)，各系统的说明也随对应安装包提供。

## 许可证

除另有说明的第三方材料外，本项目源代码采用 [MIT 许可证](LICENSE)，允许修改、分发和商业使用，请保留版权及许可声明。第三方组件和图标按各自的许可条件使用，来源与声明见[第三方材料说明](THIRD_PARTY_NOTICES.md)。

本项目为个人开发的非官方工具，与清华大学及相关网站运营方不存在官方隶属或背书关系。

## 开发资料

- [共用扩展与 Mac 开发说明](docs/DEVELOPMENT.md)
- [Windows 实现与验收边界](docs/WINDOWS_DEVELOPMENT.md)
- [验证记录](docs/VALIDATION.md)
