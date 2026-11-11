# 开发与后续兼容

## 当前范围

用户已确认先做少量同学试用版，采用“扩展设置页＋无独立窗口的本机助手”。允许首次双击安装文件。目标是使用者无需安装开发工具、无需本机编译，日常无需手动启动助手。

源码从个人版 `9a20985`（0.3.2）中选择复制。原项目保持不变，文件指纹记在 `source-baseline.json`。共享版建立独立 Git 仓库，安装目录、钥匙串服务、扩展 ID 与个人版分开。

## 模块

| 文件 | 职责 |
| --- | --- |
| `extension/policy.js` | 三站点网址、应用名、表单目的地与提交规则 |
| `extension/content.js` | 页面识别、原标签页导航、实际填写与提交前复查 |
| `extension/background.js` | 登录状态、提交互斥、失败冷却与工具栏操作 |
| `extension/credentials.js` | 设置页管理权限、实际文档检查与定向取用凭据 |
| `extension/native.js` | 有限时长的 Native Messaging 通信与错误说明 |
| `extension/options.*` | 首次设置、更新／删除凭据、自动模式开关 |
| `native/macos/main.swift` | 系统钥匙串、受限通信、安装／卸载 |
| `native/config.json` | 助手名称、固定试用扩展 ID、协议和版本 |
| `scripts/build.py` | 生成两个架构的程序、临时签名及试用 ZIP |

三站点的识别、单次提交、原标签页和失败停止规则沿用个人版。身份认证与邮箱分别保存，不再默认把邮箱凭据等同于清华统一身份凭据。只有已保存对应账号的网站才启动。

个人版的 6 秒等待用于 KeePassXC 填充与连接重启。共享版在确认表单后直接向本机助手取用凭据，因此移除了这段等待、恢复逻辑及 `management` 权限。

## 凭据通信

协议版本为整数 `1`，JSON 前加 4 字节小端长度。每个进程只处理一个请求；请求最大 64 KiB。生产入口只接受 `native/config.json` 对应的精确扩展来源。

操作为 `status`、`save`、`get`、`delete`；凭据角色只能为 `identity`、`mail`。不支持任意路径、命令、服务名或凭据列表。状态只返回账号名和是否配置。测试入口只使用内存或一次性测试钥匙串。

扩展内只有准确的 `options.html` 可管理凭据。取密码前，后台从浏览器核对标签页网址，用 `documentId` 在实际顶层文档的隔离环境中读取不含密码的表单快照，再验证应用名、目的地、验证码和错误提示。取用后复查文档及登录状态，回应只回到发起请求的内容脚本。内容脚本再次核对 DOM 和地址，填写后下一轮才申请提交。

密码不写入 Chrome storage，也不通过 `window.postMessage` 或网页自定义事件传递。普通页面输入事件用于通知学校表单字段发生变化，这不构成独立的密码通信接口。页面本身必然能够读取填写到自己表单中的密码。

## Mac 实现与更新

安装目录：`~/Library/Application Support/TsinghuaAutoLoginShared/`。Chrome 和 Edge 各注册一个限定来源的 Native Messaging manifest。浏览器按需启动助手，不安装登录启动项或后台服务。

钥匙串使用独立服务 `local.tsinghua-login-shared.credentials.v1`，角色作为 account，账号密码作为条目数据。首次创建时仅授予当前助手读取访问。更新数据保留访问控制，避免每次保存都重新修改授权。后台读取不弹系统授权窗口，锁定或授权失效时返回明确错误。

试用版使用本地临时签名，不具备 Developer ID、公证或商店分发身份。换二进制后可能需要系统重新授权；正式发布须使用稳定签名并实测更新。当前基于 macOS 登录钥匙串的传统 Security API，其中部分已被 Apple 标记 deprecated；本机实际读写测试通过，但正式版发布前应重新评估长期 API 与签名方案。

## Windows 与 Edge

浏览器代码采用 Chromium Manifest V3；Mac 安装器已生成 Edge 的独立连接配置。尚未进行 Edge 实机验收，不宣称已支持。

Windows 后续实现同一凭据协议，使用当前用户的系统凭据存储，并注册 Chrome／Edge 的用户级 Native Messaging 主机。系统凭据访问及安装程序需要单独实现；网页规则与设置页保持复用。Windows 启动参数还需处理浏览器传入的 `--parent-window`。不得直接复用 Mac 二进制或把未完成的 Windows 包列为可用版本。

试用扩展 ID 来自 manifest 中公开的固定公钥，没有保存私钥。正式商店 ID 需要重新核对并更新助手允许来源；不能假定它与试用 ID 一致。

## 构建与检查

开发机需要 Python 3、Node 和 Apple Command Line Tools。接收者只需要 ZIP 中的已编译程序。

```sh
python3 scripts/build.py
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p native_test.py -v
build/host --test-keychain
node tests/browser.cjs
git diff --check
```

浏览器检查需要 `playwright-core` 和已安装的测试 Chromium；可以通过 `NODE_PATH` 指向现有依赖。检查使用临时浏览器资料，学校网址全部由本地虚拟页面替代。检查先通过真实 Native Messaging 调用已编译助手的内存测试入口，验证来源及协议状态响应；之后用模拟凭据响应检查填写流程。系统钥匙串真实读写由独立的一次性钥匙串检查覆盖。这些结果不等于真实网站的新机首次安装验收。

`dist/` 仅保留一份当前安装包及其 SHA-256。中间文件放在忽略的 `build/`。不把私人数据库、账号、密码、机器配置或签名私钥纳入仓库或分发包。

## 资料

- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)
- [Windows 凭据写入](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)
- [Apple Developer ID](https://developer.apple.com/developer-id/)
- [Apple 钥匙串应用访问规则](https://developer.apple.com/documentation/security/secaccesscreate(_:_:_:))

前期已比较免费 THU Auto Login、Learn Helper、浏览器保存密码及 Bitwarden。现有资料未能确认其完整覆盖三个站点的失效重登；用户最终选择复用当前站点规则，新增精简系统助手。项目自身代码的公开许可证尚未决定；第三方图标的原有来源与许可文件随资源保留。
