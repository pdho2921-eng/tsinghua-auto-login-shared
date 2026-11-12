# 开发与后续兼容

## 当前范围

用户已确认先做少量同学试用版，采用“扩展设置页＋无独立窗口的本机助手”。允许首次双击安装文件。目标是使用者无需安装开发工具、无需本机编译，日常无需手动启动助手。

源码从个人版 `9a20985`（0.3.2）中选择复制。原项目保持不变，文件指纹记在 `source-baseline.json`。共享版建立独立 Git 仓库，安装目录、钥匙串服务、扩展 ID 与个人版分开。

## 模块

| 文件 | 职责 |
| --- | --- |
| `extension/policy.js` | 三站点网址、应用名、表单目的地与提交规则 |
| `extension/content.js` | 页面识别、原标签页导航、实际填写与提交前复查 |
| `extension/notice.js` | 学校网页与预览页共用的错误提示样式、页面错误文案 |
| `extension/preview.*` | 24 种错误状态的独立视觉预览，无凭据通信或登录操作 |
| `extension/background.js` | 登录状态、提交互斥、失败冷却与工具栏操作 |
| `extension/credentials.js` | 设置页管理权限、实际文档检查与定向取用凭据 |
| `extension/native.js` | 有限时长的 Native Messaging 通信与错误说明 |
| `extension/options.*` | 首次设置、更新／删除凭据、总开关与三站点独立开关 |
| `native/macos/main.swift` | 系统钥匙串、受限通信、安装／卸载 |
| `native/config.json` | 助手名称、固定试用扩展 ID、协议和版本 |
| `scripts/build.py` | 生成两个架构的程序、临时签名及试用 ZIP |

三站点的识别、单次提交、原标签页和失败停止规则沿用个人版。邮箱优先使用独立保存的 `mail` 凭据，未配置时使用 `identity` 凭据；不复制或另存密码。删除邮箱凭据后恢复使用清华账号。后台统一解析当前网站的凭据来源，取用完成后再次核对来源和账号。

个人版的 6 秒等待用于 KeePassXC 填充与连接重启。共享版在确认表单后直接向本机助手取用凭据，因此移除了这段等待、恢复逻辑及 `management` 权限。

自动模式由总开关 `automatic` 与 `siteAutomatic` 的三个独立开关共同决定，旧设置中缺失的总开关和网站字段均按开启处理，与设置页一致；明确保存的关闭值保持不变。0.1.3 修复了从钥匙串恢复账号、尚未保存总开关时，界面开启而执行端关闭的问题。关闭网站后取消该网站的待执行流程，其他网站保持不变；取用和提交前都重新检查开关。工具栏点击建立一次明确的手动流程，允许在自动模式关闭时运行。设置页、预览页及不支持的网站上点击图标不导航。

邮箱过期恢复同时处理应用内的双层弹窗及服务器返回的 `.sysMessage` 页面。后者必须包含明确的会话过期提示与指向本邮箱 `/coremail/` 的 POST 表单，才返回邮箱首页；普通错误、邮件正文和其他表单均不触发。

0.1.4 将统一认证应用 `WEBVPN` 映射到 `info`，共用清华凭据、自动开关和退出暂停。新增 `webvpn.tsinghua.edu.cn` 的精确主机权限；网页脚本只处理根入口、`/login` 和实测的门户代理前缀，其他代理网站立即退出。代理前缀是学校对门户主机名的固定编码，不含账号或会话数据。网页结构或编码变化后需重新核对。

门户认证和 WEBVPN 认证分别使用 `submit`、`submit-webvpn` 单次标记，使同一标签页能依次完成两个应用的认证，但同一应用不会重复提交。两步仍共用提交互斥、冷却和停止条件；取用及就绪检查依据实际认证应用选择标记，并在异步检查后复查应用未改变。WEBVPN 资源站点或代理门户确认成功后释放占用与冷却。工具栏重登保留校外入口。

## 凭据通信

协议版本为整数 `1`，JSON 前加 4 字节小端长度。每个进程只处理一个请求；请求最大 64 KiB。生产入口只接受 `native/config.json` 对应的精确扩展来源。

操作为 `status`、`save`、`get`、`delete`；凭据角色只能为 `identity`、`mail`。不支持任意路径、命令、服务名或凭据列表。状态只返回账号名和是否配置。测试入口只使用内存或一次性测试钥匙串。

扩展内只有准确的 `options.html` 可管理凭据。取密码前，后台从浏览器核对标签页网址，用 `documentId` 在实际顶层文档的隔离环境中读取不含密码的表单快照，再验证应用名、目的地、验证码和错误提示。取用后复查文档及登录状态，回应只回到发起请求的内容脚本。内容脚本再次核对 DOM 和地址，填写后下一轮才申请提交。

0.1.1 将“可填写”与“可提交”分开判断：网页预填的学号或其他凭据不再阻止取用，填写时统一替换为已保存的整组凭据；实际返回的账号仍须与扩展保存的账号设置一致。监听真实编辑事件，在取用或提交等待期间检测到主动编辑便取消自动流程；程序填写及浏览器预填不按人工编辑处理。提交获准后再次检查暂停标记，避免等待期间的人工编辑仍被提交。

申请提交前执行只读就绪检查：由后台绑定当前 `documentId`，先核对隔离环境中的表单，再在页面环境中检查 `readyState=complete`、按钮可用及处理程序存在。Coremail 还检查其 jQuery 点击处理程序。0.1.3 移除了 0.1.2 对 `#fingerGenPrint3` 非空的要求：在用户虚拟机中，该字段持续为空，但学校自己的登录处理程序已可用，手动点击能进入二次验证。该字段不能作为扩展点击登录的必要条件。页面环境探针只返回布尔值，不接收用户名或密码，也不点击、调用页面登录函数或修改页面。检查后复查表单，最后仍由内容脚本触发原登录按钮，以保留学校的加密与验证流程。

成功与拒绝结果的确认不再受标签页可见性限制；填写和发起登录仍要求当前页可见。完成、停止、暂停或超时会释放该标签页的提交占用。没有加入循环点击或重复发送密码的补救逻辑。

统一认证的 `/do/off/ui/auth/login/check` 单独识别为 `auth-result`，仅显示学校错误或额外验证提示；不允许在该结果页取用或提交凭据，防止学校拒绝后重复尝试。

设置页复制按钮只在当前页面的对应输入框间复制，不使用剪贴板、不读取已保存密码；眼睛按钮仅改变当前输入的显示方式。保存后清空密码框并恢复隐藏状态。未保存账号的删除按钮使用普通光标，只有实际操作期间显示忙碌光标。

密码不写入 Chrome storage，也不通过 `window.postMessage` 或网页自定义事件传递。普通页面输入事件用于通知学校表单字段发生变化，这不构成独立的密码通信接口。页面本身必然能够读取填写到自己表单中的密码。

## Mac 实现与更新

安装目录：`~/Library/Application Support/TsinghuaAutoLoginShared/`。Chrome 和 Edge 各注册一个限定来源的 Native Messaging manifest。浏览器按需启动助手，不安装登录启动项或后台服务。

钥匙串使用独立服务 `local.tsinghua-login-shared.credentials.v1`，角色作为 account，账号密码作为条目数据。首次创建时仅授予当前助手读取访问。更新数据保留访问控制，避免每次保存都重新修改授权。后台读取不弹系统授权窗口，锁定或授权失效时返回明确错误。

试用版使用本地临时签名，不具备 Developer ID、公证或商店分发身份。换二进制后可能需要系统重新授权；正式发布须使用稳定签名并实测更新。当前基于 macOS 登录钥匙串的传统 Security API，其中部分已被 Apple 标记 deprecated；本机实际读写测试通过，但正式版发布前应重新评估长期 API 与签名方案。

0.1.5 修复安装器的组件版本比较：`BuildInfo.version` 是助手版本，`BuildInfo.extensionVersion` 是本次配套扩展版本。安装时核对配套扩展版本、公钥、完整文件指纹及助手文件；运行时仍按协议号兼容。指纹用于防止混包与缺件，不替代开发者签名。构建时校验公钥推导出的扩展 ID，安装前及暂存后复查文件。先暂存完整安装，再整体切换；写入 Chrome 或 Edge 连接配置失败时恢复旧目录与之前写入的配置，回滚失败则保留备份并给出路径。同名注册指向其他应用时拒绝覆盖。

`build.py` 先在临时目录生成候选 ZIP，再用包内助手完成安装、覆盖、卸载、重装及失败恢复检查；通过后才替换 `dist` 的发布 ZIP。该流程只用临时用户目录，不操作真实登录钥匙串。构建出的扩展文件发生变化后必须重新构建整包，不能只替换 ZIP 中的扩展却沿用旧的配套校验数据。

普通网络学堂课程页、作业页和加载中的空页面没有明确失效提示时，不建立自动重登流程，避免浏览正常内容时产生超时错误。

## Windows 与 Edge

浏览器代码采用 Chromium Manifest V3；Mac 安装器已生成 Edge 的独立连接配置。尚未进行 Edge 实机验收，不宣称已支持。

详细续接入口见仓库根目录 `HANDOFF_WINDOWS.md`。Windows 后续实现同一凭据协议，使用当前用户的系统凭据存储，并注册 Chrome／Edge 的用户级 Native Messaging 主机。系统凭据访问及安装程序需要单独实现；网页规则与设置页保持复用。Windows 启动参数还需处理浏览器传入的 `--parent-window`。不得直接复用 Mac 二进制或把未完成的 Windows 包列为可用版本。

试用扩展 ID 来自 manifest 中公开的固定公钥，没有保存私钥。正式商店 ID 需要重新核对并更新助手允许来源；不能假定它与试用 ID 一致。

## 构建与检查

开发机需要 Python 3、Node 和 Apple Command Line Tools。接收者只需要 ZIP 中的已编译程序。

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

WEBVPN 流程参考：[学校双因素认证操作指南](https://its.tsinghua.edu.cn/1wzcycejdh_content.jsp?urltype=news.NewsContentUrl&wbnewsid=4000&wbtreeid=1771)。已有免费 THU Info 提供独立校园客户端，但不能直接完成当前浏览器原标签页的重登需求，因此本轮扩展既有规则，不新增软件或费用。
