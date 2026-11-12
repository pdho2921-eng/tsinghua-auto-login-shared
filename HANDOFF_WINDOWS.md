# 清华网站自动重登 Windows 版开发交接

交接日期：2026-11-12。当前项目已完成 Mac 共享试用版；下一对话的目标是复用浏览器扩展，实现 Windows 本机助手与安装包。这里记录已确认的需求、现有代码和验收要求；Windows 方案尚未实现，不能把 Mac 测试结果当作 Windows 支持证明。

## 从哪里继续

- 共享版仓库：`/Users/pdho/Desktop/programs/plug-in/tsinghua-auto-login-shared`，独立 Git 仓库。先查看 `git status`、最近提交和本文，再读取 `docs/DEVELOPMENT.md`、`docs/VALIDATION.md`。
- 原个人版：`/Users/pdho/Desktop/programs/plug-in/yuketang-login/tsinghua-auto-login`。用户要求保持原文件不变，文件指纹记录在共享版 `docs/source-baseline.json`。
- 当前交付：扩展 **0.1.5**、Mac 助手 **0.1.3**、通信协议 **1**。三个数字含义不同，不要求扩展和助手版本相同。
- 当前 Mac 安装包：`dist/tsinghua-auto-login-shared-macos.zip`，校验值见同目录 `SHA256SUMS.txt`。`dist` 和 `build` 不进 Git。旧 ISO 是手工生成的历史传输介质，不随 ZIP 更新。
- 建议在同一仓库的新分支中开发，在 `native/windows/` 和 Windows 专用构建脚本中新增实现，继续共用 `extension/`。并行开发时使用独立 Git worktree，避免复制出多份失去同步的浏览器代码。跨系统工作时重新定位仓库，不依赖上述 Mac 绝对路径。

## 用户已经确认的产品要求

首次配置应少操作，接收者不安装编译工具、不执行多份命令行文件。采用“扩展设置页＋浏览器按需启动的本机助手”，没有独立应用窗口、登录启动项、后台常驻服务或开发者账号服务器。可接受一次安装操作；不要重新提出已经放弃的独立配套应用方案。

支持网络学堂、信息门户和学生邮箱。WEBVPN 是信息门户的校外入口，共用“信息门户”开关及清华账号，不增加第四个开关。总开关与三个网站开关共同控制自动模式。左键工具栏图标在当前标签页手动执行登录；右键“选项”打开设置。设置页、错误预览页和不支持的网站上，左键图标不导航。

邮箱未单独保存时，使用清华账号和密码；单独保存后优先使用邮箱凭据，删除后恢复清华凭据。账号可能是数字学号，也可能是拼音别名：登录时用保存的整组凭据替换网页预填，不要求两个名称相同。用户主动编辑登录框时暂停自动流程。

复制按钮只在当前设置页的对应输入框之间复制；眼睛图标只显示当前输入。两者都不能读取已保存密码。保存后清空密码框。用户已亲自修改 `开始使用.html` 和设置页的文案，后续应保留这些修改；新增或调整界面文案先与用户确认。

用户要求手动点击“检查连接”通过后弹出明显的“连接成功”。当前为绿色浮动提示，6 秒后消失，可手动关闭；首次打开设置页的自动检查及保存后的后台检查不弹出。此次小改动仅做一次针对性页面检查，不扩大测试范围。

收到验证码、二次验证、账号错误或学校拒绝后停止，不循环点击或重复发密码。用户明确允许实测时把“进入二次验证界面”视为自动提交成功，但这不等于进入网站主页；验证码由用户完成。

## 代码分工

| 文件 | 后续开发用途 |
| --- | --- |
| `extension/policy.js` | 精确主机、应用名、表单目的地、邮箱默认凭据、逐站开关和单次提交规则 |
| `extension/content.js` | 页面识别、填入凭据、等待学校按钮可用、点击原按钮、失效恢复 |
| `extension/background.js` | 同标签页流程、互斥、超时、冷却、工具栏行为 |
| `extension/credentials.js` | 设置页管理权限、绑定实际顶层文档、取用前后复查 |
| `extension/native.js` | 唯一的 Native Messaging 通信入口，12 秒超时、错误映射 |
| `extension/options.*` | 配置页、复制和显示、凭据保存、各网站开关 |
| `extension/notice.js` 与 `preview.*` | 实际错误提示及 24 种可直接检查的预览 |
| `native/config.json` | 固定助手名、扩展 ID、协议、Mac 助手版本；Windows 助手版本应独立管理 |
| `native/macos/main.swift` | 可参考的协议、凭据隔离、安装预检和失败恢复；不能用于 Windows |
| `scripts/build.py` | Mac 双架构构建、签名、ZIP、完整安装包验收后再发布 |
| `tests/` | 行为、凭据边界、原生通信、安装、真实浏览器中的虚拟学校页面回归 |

现有界面还有 Mac 专属“钥匙串”“Command＋Shift＋G”、安装路径和终端文件说明。Windows 实现需按平台切换这些说明、错误文案及隐私说明，不应直接交付一套写着 macOS 的页面，也不要为此复制整套网页规则。

## 必须遵守的通信协议

浏览器通过 Native Messaging 启动助手，以标准输入、标准输出交换消息。主机名为 `local.tsinghua_login_shared`，当前试用扩展 ID 为 `pnbhfnijipjaoakcolgejmlmmnbkmmbh`。允许来源是完整的 `chrome-extension://pnbhfnijipjaoakcolgejmlmmnbkmmbh/`，不能使用通配符。

每条消息是“4 字节小端长度＋UTF-8 JSON”。项目请求上限为 **65,536 字节**，每个进程只处理一个请求。不能用字符数计算长度。标准输出只写协议帧，日志和安装说明不能混入。Windows 的标准流要采用二进制读取和写入。浏览器还可能传入 `--parent-window=<数字>`；应解析这个已知参数，并保留对来源和其他参数的严格检查。[Chrome 文档](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

| 请求 | 成功回复的业务字段 |
| --- | --- |
| `{"protocol":1,"op":"status"}` | `ok:true`、助手 `version`、`accounts.identity` 和 `accounts.mail`；每组含 `configured`、`username`，不能含密码 |
| `{"protocol":1,"op":"save","role":"identity","username":"示例账号","password":"虚拟密码"}` | `ok:true` |
| `{"protocol":1,"op":"get","role":"identity"}` | `ok:true`、`username`、`password` |
| `{"protocol":1,"op":"delete","role":"identity"}` | `ok:true` |

每个回复都含 `protocol:1`。两种合法 `role` 为 `identity` 和 `mail`。拒绝额外字段、任意文件路径、执行命令、任意凭据名称和列出其他凭据的请求。失败返回 `ok:false,error:<代码>`；现有原生错误为 `protocol-mismatch`、`invalid-request`、`not-found`、`keychain-locked`、`storage-error`。Windows 的存储错误及界面名称需映射清楚，不应显示“请解锁 Mac 钥匙串”。

现有 Mac 输入限制：用户名去首尾空白，非空、最长 160 个 Swift 字符、不含控制字符；密码非空，最长 4096 个 Swift 字符。跨语言实现时明确 Unicode 字符与字节长度的区别，并以协议测试锁定行为，不能截断密码来适应存储限制。

密码不能进入 Chrome storage、同步存储、日志、剪贴板或网页消息通道。取用只回给发起请求的扩展脚本。扩展会用 `documentId` 绑定实际顶层文档，验证应用和表单目的地；异步取用后再核对页面、账号、凭据来源及开关。保留这些检查，不能以绕过它们的方式解决 Windows 连接问题。

## Windows 实现方案与成本

现有免费系统能力足以完成基础版本，不需要订阅。已有 KeePassXC 可以承担密码管理，但会新增安装、数据库解锁和配置成本，与本次精简共享版的已定方向不符。以下是供下一对话选择的实现方案，尚未承诺采用某种语言或完成日期。

| 方案 | 开发与验证成本 | 接收者成本 | 适用判断 |
| --- | --- | --- | --- |
| C# 与 .NET Native AOT | 中等；需要 Windows 构建工具和原生接口声明 | 发布为独立程序，无需额外安装 .NET | 优先评估，便于处理 JSON、安装及测试 |
| C++ 与 Win32 | 较高；需处理内存、编码、错误和 JSON 依赖 | 程序可较小，无额外密码管理软件 | 团队已有 C++ 基础时考虑 |
| KeePassXC 配合扩展 | 少写存储代码，但增加连接和解锁流程 | 需额外安装、建库和解锁 | 不作为当前产品的默认实现 |

Native AOT 可生成不依赖用户安装 .NET 运行时的程序，但需要相应目标平台的构建环境。[微软说明](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)

存储优先评估 Windows Credential Manager 的 `CRED_TYPE_GENERIC`，用独立的固定目标名区分 `identity` 和 `mail`，不要使用会参与系统网络认证的域密码类型。通过 `CredWriteW`、`CredReadW`、`CredDeleteW` 管理当前用户凭据，读取内存由 `CredFree` 释放。它不提供 Mac 钥匙串同样的逐程序授权体验，不能宣称能够隔离已取得当前 Windows 用户权限的其他程序。[写入接口](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)、[读取接口](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw)

一个必须先处理的差异：Credential Manager 的凭据数据上限为 **2560 字节**，现有协议允许的密码可能超过它。可以改用当前用户范围的 DPAPI 加密固定位置的凭据文件，并限制目录权限、原子替换文件；也可以在产品层明确更小的 Windows 输入限制，但需先确认并同步界面和测试。不要默默截断、分散保存到任意凭据名，或使用明文文件。DPAPI 不应设置 `CRYPTPROTECT_LOCAL_MACHINE`，因为这会把解密范围扩展到该电脑的其他用户。[凭据结构限制](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)、[DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)

## Windows 安装与卸载要求

建议按当前用户安装到 `%LOCALAPPDATA%\TsinghuaAutoLoginShared`。安装文件负责放置助手、扩展及主机配置，再分别注册 Chrome 和 Edge。避免要求管理员权限、手工编辑注册表或依次运行多份脚本。实际安装形式、签名和系统确认流程需在 Windows 上验证。

注册位置为以下键的默认字符串值，值是主机 JSON 文件的绝对路径；主机 JSON 的 `path` 指向助手程序：

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\local.tsinghua_login_shared
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\local.tsinghua_login_shared
```

两个浏览器分别注册，不依赖 Edge 对 Chrome 配置的兼容查找。检查 32 位与 64 位注册表视图和残留项，避免旧配置抢先生效。Edge 正式商店 ID 可能与加载解压扩展时不同，需要实测并同步允许来源。[Edge 文档](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)

安装前完成包身份、组件配对和文件完整性校验。先准备新文件，再整体切换；任一连接配置写入失败时恢复旧文件和旧注册。Windows 正在运行的 `.exe` 可能无法覆盖，必须有有限等待或明确提示，不能留下半安装状态。升级和卸载只处理本项目固定位置、固定注册项；遇到指向其他应用的同名注册先停止。

卸载默认保留账号密码，并在执行前说明如何删除；在设置页删除凭据是单独操作。重复安装、重复卸载和卸载后重装都应成功，不影响原个人版或其他程序。更新助手不得默默重置用户的自动登录开关。

签名、商店发布和许可证均未完成。正式分发前需单独核对成本；用户接受的预算上限约为每月 10 美元或一次性 200 美元，超出范围不作为主要方案。不得关闭系统安全检查来消除安装提示。

## 本次安装问题与避免重犯的方法

0.1.4 安装包内的扩展为 0.1.4、助手为 0.1.2。安装器错误地把扩展版本与助手版本作相等比较，所以完整解压也会报“扩展与助手不匹配”。扩展更新可以成功，不能证明完整包可以安装。

当前安装器分别记录扩展版本与助手版本，并核对同批构建的扩展文件指纹和助手文件。运行时兼容性仍由协议版本决定。安装前和暂存后均检查文件；失败时恢复整个旧安装及已写入的浏览器配置。Mac ZIP 构建必须先执行包内助手的安装、覆盖、卸载、重装测试，全部通过才替换发布 ZIP。

Windows 必须在最终交付压缩包或安装程序上做同样的闭环检查。仅编译通过、源代码测试通过、或把扩展文件直接复制进已配置的浏览器，都不足以证明新用户能完成安装。

## 已验证与仍待验证

- Mac 真实使用：网络学堂自动进入课程页；邮箱从真实过期页恢复收件箱；WEBVPN 自动提交记录为 `manual:false`、`submit-webvpn:true`，从其首页可进入信息门户。详细过程及限制见 `docs/VALIDATION.md`。
- WEBVPN 旧返回地址曾显示“漫游失败”，从正式入口进入正常；旧地址的自动恢复尚未验证，不应宣称已修复。
- 本轮 12 项原生安装与协议检查、80 项行为检查通过；安装修复通过临时用户目录验证，不接触真实账号。系统钥匙串检查使用一次性测试库；完整浏览器回归使用虚拟学校页面和虚拟密码。
- 完整浏览器回归连续两次通过，慢页面五种场景及 WEBVPN 六种场景通过。首次等待测试助手连接曾超时，随后未复现，原因未定位；详细记录见 `docs/VALIDATION.md`。新增连接成功提示已做针对性检查。
- 自然失效、长期运行、多网站同时失效仍需持续观察。Intel Mac、旧版 macOS、Mac Edge 和 Windows 均不能以构建成功替代实机验收。
- 目前没有可用的 Windows 构建或测试环境记录。下一对话先确认 Windows 版本、处理器架构、可用测试机器及 Chrome／Edge 版本，再实施；当前 Mac 上的 VirtualBuddy 虚拟机是 macOS，不能当作 Windows 测试机。

## 建议的开发顺序与验收

1. 确认 Windows 测试环境和存储方案，选择构建语言；保留已确认的产品行为。先实现协议的内存测试版本，再实现系统存储。
2. 用虚拟凭据验证两种角色的保存、更新、读取、删除、未找到和异常处理；测试分段管道、UTF-8、空或超长输入、非法来源、额外参数和多余字段。不要请求用户在聊天里提供真实密码。
3. 实现按用户安装、升级回滚、卸载保留凭据、卸载后重装。覆盖中文和空格路径、文件缺失、版本混用、注册冲突、文件占用和权限拒绝。
4. 在 Chrome 与 Edge 各加载扩展，验证真实浏览器到真实助手的通信，然后运行虚拟学校页面回归。确认新用户不需 Node、Python、.NET 运行时或编译工具。
5. 最后实测学校网站：逐站开关、邮箱默认凭据、数字学号预填替换、人工编辑暂停、慢页面只提交一次、二次验证停止、WEBVPN 连续认证、原标签页手动重登、设置页不跳转。
6. 从最终交付包在全新 Windows 用户环境安装，记录系统提示、操作次数和总耗时。更新隐私说明、平台文案、版本、校验值和验收记录，再交付。

现有 Mac 开发检查命令如下。Windows 对应测试要适配真实存储和注册表，不应跳过后沿用“全部通过”的表述。

```sh
python3 scripts/build.py
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p native_test.py -v
build/host --test-keychain
node tests/browser.cjs
node tests/slow-login.browser.cjs
node tests/webvpn.browser.cjs
git diff --check
```

开发机需要 Apple Command Line Tools、Python 3、Node，以及 `playwright-core` 和测试 Chromium。接收者不需要这些工具。Mac 上当前可用的 Node 位于 `/Users/pdho/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`，对应模块目录可用 `NODE_PATH` 指向；新环境应自行发现依赖路径，不能硬编码到产品。
