# Windows 版开发与验收

## 已确定范围

用户已确认 Windows 11、Intel x64、Edge；由同学在 Windows 电脑测试，用户转交安装包。采用当前用户 DPAPI，不缩小协议密码长度。保留现有设置页布局，仅替换必需的平台说明。Mac 与 Windows 分别分发，安装包仅含相应系统的文件。

Windows 助手版本与 Windows 扩展版本独立记录在 `native/windows/config.json`。`native/config.json` 仍记录共享主机名、扩展 ID、协议，以及 Mac 助手版本。当前 Windows 扩展 0.1.9、助手 0.1.2；Mac 扩展 0.1.8、助手 0.1.4，通信协议仍为 1。用户最新要求同步 Mac 的设置页登录入口，并检查两版升级行为；之前 0.1.7 仅改 Windows 的限制已被这次请求替代。

从 0.1.8 起，两版设置页首次连接成功与手动检查成功都会显示浮动提示，保存／删除后的后台检查保持安静。三个网站链接发送受限的 `open-site` 请求，只允许设置页的精确来源和顶层页面使用，拒绝任意 URL 和非字符串的网站编号。后台先创建空白标签页并保存一次手动尝试，再导航到固定网站入口，避免快速重定向先遇到旧冷却状态。主动启动不修改自动开关、退出暂停或普通自动尝试的等待时间；不抢占其他标签页的提交占用。失败时清理空白标签页和状态，并向设置页明确返回错误。

两版原本已支持覆盖旧安装。Windows 0.1.1 增加 `SetupErrors`：失败恢复后的提示保留具体阶段、异常类型和 HRESULT；区分共享冲突、访问拒绝、校验失败和恢复失败，不能把访问拒绝直接认定为浏览器占用。安装成功时区分首次安装与覆盖更新，更新不要求重新保存账号。没有自动结束浏览器进程、改写浏览器用户资料或删除凭据。

Windows 0.1.2 针对实机截图“替换旧版本文件 / IOException / 80070005”修复目录替换依赖。当旧目录移动返回访问拒绝或共享冲突，且目录仍完整位于原位置时，切换到逐文件更新。每个差异文件先备份，再将恢复记录落盘，最后以文件替换操作切换；一致文件跳过。提交后清理无用旧文件，被占用的无用文件可以延后清理。失败或下次启动按新日志恢复每个改动文件和注册表；旧版整目录事务仍可恢复。没有绕过文件访问权限，单文件写入被拒绝时仍停止并保留具体错误。

新增覆盖：旧目录移动固定返回 80070005 时升级成功；逐文件模式的起始、已有文件、新文件、助手文件及注册表失败恢复；实际生成的日志在模拟进程中断后的恢复。Windows 专用检查额外持有不允许删除共享的真实目录句柄，以及锁定旧助手文件；这些检查只会在 Windows 上执行，Mac 上的注入检查不能替代它们。

连续登录回归见 `tests/settings-launch.browser.cjs`，测试使用虚拟学校页面和虚拟密码，依次完成网络学堂、信息门户、邮箱、再次网络学堂，均在二次验证处停止并关闭标签页。网站之间不清空状态。它补上了此前逐站测试清除状态而遗漏的路径。

## 实现

- `native/windows/Core/Protocol.cs`：严格消息格式、字段和来源验证；二进制帧；每进程一个请求。用户名去首尾空白，不允许控制或格式字符；用户名和密码分别最多 160、4096 个扩展字素簇。使用 .NET `StringInfo`，与 Swift `String.count` 采用同类字符计数；Unicode 版本演进可能造成少数字符分段差异。网页原有 `maxlength` 仍按 UTF-16 单元限制，未扩大既有网页输入范围。
- `Core/DpapiVault.cs`：固定两个角色、当前用户 DPAPI、私有目录权限、拒绝链接、加密后的同卷原子替换。存储目录与安装目录分开。密码不截断，不写明文文件，不进入日志。托管字符串无法保证即时清零；可控的输入输出字节数组及解密本机缓冲区会清零。
- `Host/`：Windows GUI 子系统程序，直接读取继承的二进制标准流，不开应用窗口。严格接受扩展来源及可选 `--parent-window`；10 秒进程上限早于扩展的 12 秒超时。生产入口没有内存测试或任意存储目录参数。
- `Core/Installation.cs`：检查内嵌包哈希、精确文件清单、扩展身份和各组件版本；暂存后再切换。保存恢复日志；失败或下次启动时恢复目录与注册。每个目录移动最多等待约 2 秒。旧文件无法清理时保留已提交日志，下次运行继续清理。
- `Core/WindowsRegistrations.cs`：分别处理 Edge 与 Chrome 的用户级连接配置，并检查两个注册表视图。发现任何同名电脑级配置或其他应用的用户级配置即停止，不改写它们。Chrome 配置为兼容预留，本轮验收只针对 Edge。
- `Setup/`：单文件安装程序和同一程序命名的卸载入口。无需管理员或额外运行时；卸载前显示保留凭据说明。安装与卸载程序从原始分发包运行，避免自删除正在执行的程序。不会设置启动项、后台服务、浏览器策略或重置自动模式开关。

当前采用 .NET 10 **自包含、裁剪、单文件发布**，可以在 Mac 生成 Windows x64 候选文件。不是 Native AOT；这是为了在尚无直接可操作的 Windows 构建机时先生成可转交的包。运行时自带组件可能在当前用户临时目录解包。Native AOT 可在未来有 Windows 构建环境时评估，不改变产品使用方式。

## 构建

开发机需要 Python 3 和 .NET 10 SDK。接收者不需要这些工具。SDK 可从微软官网下载到本地独立目录，不必全局安装。构建工具产生的数据保存在忽略的 `build/windows` 与各项目 `bin/obj`。

```sh
python3 scripts/build_windows.py --dotnet /path/to/dotnet
```

脚本从同一份 `extension/` 生成 Windows 专用副本，生成常量、运行协议与事务检查、发布真实 x64 程序、校验内嵌负载与外层 ZIP。输出 `dist/tsinghua-auto-login-shared-windows-x64-test.zip`；文件名明确表明 Windows 实机验收待完成。Mac 仍运行 `python3 scripts/build.py`，输出独立 Mac ZIP。`scripts/package_shared.py` 负责按平台复制说明和维护两包校验值；安装包不包含开发文档、测试代码或另一系统的安装入口。

## 检查与证据边界

`native/windows/Tests` 使用内存凭据、临时文件目录与模拟注册表完成协议及安装事务测试。运行在 Windows 时会额外使用一次性目录测试真实 DPAPI；不会读取用户实际凭据。恢复与冲突测试包含全新安装和升级的多个失败位置、注册写入拒绝、重复安装卸载、角色隔离、长 Unicode 密码、非法帧与来源、混包和路径逃逸。

```sh
dotnet run --project native/windows/Tests/Tests.csproj -c Release
dotnet run --project native/windows/Tests/Tests.csproj -c Release -- --payload build/windows/payload.zip
node --test tests/*.test.cjs
```

浏览器回归需安装 `playwright-core` 及其 Chromium。将 `build/windows/payload.zip` 解压到 `build/windows/acceptance-payload`，指定其中的 Windows 扩展副本；用实际打包副本核对平台文案与交付版本：

```sh
THU_TEST_EXTENSION="$PWD/build/windows/acceptance-payload/extension" node tests/settings-launch.browser.cjs all
THU_TEST_EXTENSION="$PWD/build/windows/acceptance-payload/extension" node tests/windows-package.browser.cjs
```

前者在同一份浏览器状态中连续提交四次并逐次核对二次验证停止，后者检查 Windows 文案、版本与页面显示。测试只使用虚拟学校页面和虚拟凭据。

生产助手只能在 Windows 上验证。Mac 上通过的协议测试、模拟注册表测试、PE 文件检查、Chromium 页面测试都不能替代以下验收：

1. 最终 ZIP 在新的 Windows 用户目录解压；记录系统提示、安装操作次数和时间。
2. 真正的 DPAPI 保存、更新、读取、删除，以及目录权限和异常处理。
3. 真正的 32/64 位注册表连接、外部注册冲突、权限拒绝、运行中助手被占用、安装失败后的恢复。
4. Edge 加载扩展；确认扩展 ID 与固定来源一致；检查真实浏览器到实际助手的通信。
5. Windows 的隔离虚拟学校页面回归，以及用户同意下的三个学校网站实测。
6. 从同一个最终包覆盖安装、卸载、重复卸载、重装，确认凭据和已保存开关的保留规则。

面向同学的简明步骤在 `docs/WINDOWS.md`，随 Windows 包作为 README 分发。正式签名、商店发布及项目公开许可证仍未完成。

## 代码签名与智能应用控制（2026-11-12 核查）

用户实测报告：`安装.exe` 被 Windows 智能应用控制拦截，提示无法验证发布者。本机读取最终 ZIP 内安装、卸载程序及构建出的助手 PE 证书表，三者的 Authenticode 证书表均为空。尚未在真实 Windows 环境复现或验证放行；这是与未签名分发相符的反馈，不能宣称已修复系统信任问题。

| 路径 | 费用 | 用时与难度 | 当前限制 |
| --- | --- | --- | --- |
| SignPath Foundation | 合格开源项目免费 | 需准备公开源码、构建来源证明和签名流程，并等待审核；无确定获批时间 | 项目尚未选择公开许可证或公开仓库；公开发布及许可需要项目所有者决定，不能直接上传替其决定 |
| Microsoft Artifact Signing | Basic 约 9.99 美元/月，最多 5,000 次签名 | 需 Azure 付费订阅、实名验证和签名流程；完成身份审核后才能签名 | Public Trust 个人申请目前仅限美国、加拿大；若以中国大陆个人身份申请，当前不适用；Private Trust 不能代替公众信任签名 |
| Microsoft Store 的 MSIX 路线 | Store 代签 MSIX 本身免费 | 需改造分发与安装方式、开发者注册和商店审核，工作量更大 | 当前 EXE 不能直接当作 MSIX 上传；通过 Store 分发 EXE 也仍要求发布者先签名 |
| 传统 CA 代码签名 | 按证书、硬件或云签名服务报价 | 需要身份审核及安全密钥保管，通常有持续费用 | 未取得适合本项目、符合预算的报价，不作为当前主方案 |

资料：[SignPath 免费签名条件](https://signpath.org/terms)、[SignPath 项目信誉与审核说明](https://signpath.org/terms.html)、[微软价格](https://azure.microsoft.com/en-us/products/artifact-signing/)、[微软身份与地区条件](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)、[微软签名路线比较](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)。地区、价格和服务条件可能更新，申请前再次核对。

当前不创建自签名证书、不要求使用者导入不明根证书，也不把文件版本或 CompanyName 属性当作可信签名。若获得真实签名身份，构建顺序必须为：发布助手 → 签名并验证助手 → 生成文件指纹和内嵌包 → 编译安装器 → 签名并验证安装器 → 复制为安装／卸载入口 → 更新最终校验值。不能在生成内嵌文件指纹之后再修改助手。还需核查自包含运行时解包后的可执行组件是否满足应用控制，再从最终包实测安装、运行和卸载。仅签外层安装器不足以证明助手可以运行。

用户本轮明确要求在无法立即提供可信签名时补充关闭方法，因此 `docs/WINDOWS.md` 新增了系统设置入口、整机影响、恢复条件，以及重新开启后未签名助手仍可能被拦截的说明。没有在产品中加入关闭安全设置的代码。微软当前 FAQ 已说明近期更新支持重新开启；不能继续笼统写成“关闭后一定只能重装系统恢复”。

## 官方资料

- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)
- [Windows 当前用户 DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
- [.NET 单文件发布](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)
- [.NET 自包含裁剪](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trim-self-contained)
- [Native AOT 跨系统编译限制](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/cross-compile)
