# 清华网站自动重登 · 试用版

## 傻逼清华天天退出登录，你不会以为自己的网站特别安全吧？赶紧给爷去死。
首次保存账号密码后，实现网络学堂、信息门户（含校外 WEBVPN）和学生邮箱登录失效后的原标签页自动重新登录。

当前为初步完成版，提供 macOS 和 Windows 两份安装包。只简单测试过 Mac 上的 Chrome 和 Windows 11 上的 Edge，其他系统和浏览器组合还需要反馈。

## 选择安装包

当前为初步完成版，只做过简单测试，很可能还有没遇到的问题，欢迎反馈。

| 系统 | 安装包 | 使用说明 | 测试情况 |
| --- | --- | --- | --- |
| Mac | [下载 Mac 安装包](https://github.com/pdho2921-eng/tsinghua-auto-login-shared/releases/download/v0.1.9-preview/tsinghua-auto-login-shared-macos.zip) | [Mac 使用说明](docs/MACOS.md) | 简单测试过本机和虚拟机上的 Chrome；Intel 芯片、旧版 macOS 和 Mac Edge 仍待反馈 |
| Windows 11 x64 | [下载 Windows 安装包](https://github.com/pdho2921-eng/tsinghua-auto-login-shared/releases/download/v0.1.9-preview/tsinghua-auto-login-shared-windows-x64-test.zip) | [Windows 使用说明](docs/WINDOWS.md) | 简单测试过 Windows 11 + Edge；Windows 10 及以下版本、Windows Chrome 仍待反馈 |

解压后，Mac 运行 `安装.command`，Windows 运行 `安装.exe`，再按自动打开的说明加载扩展、检查连接并保存账号密码。

已有旧版时，直接运行新包中的安装文件即可更新。完成后，在浏览器扩展管理页重新加载扩展，再刷新学校网站。更新保留已保存的密码和自动登录开关。

两份安装包各自只包含本系统适用的文件。完整版本说明和文件校验值见[本次发布页](https://github.com/pdho2921-eng/tsinghua-auto-login-shared/releases/tag/v0.1.9-preview)。

## 问题反馈

使用时遇到问题，可以在 [Issues](https://github.com/pdho2921-eng/tsinghua-auto-login-shared/issues) 中新建反馈。

请说明系统和浏览器版本、插件版本、出问题的网站，以及操作到哪一步失败。如果有提示，可以附上文字或截图；截图前遮住账号，不要发送密码、Cookie 或完整认证链接。

到达验证码或二次验证页面后，需要本人继续操作，这种情况不算自动提交失败。

## 使用方式

解压安装包后运行其中的 "安装.command(macOS)" 或 "安装.exe(Windows)"，完成安装后按自动打开的网页指引加载扩展。加载完成对应扩展时会自动打开设置页，完成连接自检和账号密码保存。

邮箱未单独保存凭据时使用清华账号，单独保存后优先使用邮箱凭据，删除后恢复回退。主动编辑登录框时暂停自动处理；收到验证码、二次验证或学校拒绝后停止，不循环提交密码。

插件适用范围由页面最下方的总开关与三个网站开关控制，默认均开启，可自行选择打开哪些网站的自动重连。日常使用时，在支持网站中左键工具栏图标在当前标签页手动激活重登，右键图标选择“选项”可返回设置页。

密码由系统保存：Mac 使用登录钥匙串，Windows 使用当前用户 DPAPI 加密，各系统的隐私说明随对应安装包提供。

## 开发资料

- [共用扩展与 Mac 开发说明](docs/DEVELOPMENT.md)
- [Windows 实现与验收边界](docs/WINDOWS_DEVELOPMENT.md)
- [验证记录](docs/VALIDATION.md)