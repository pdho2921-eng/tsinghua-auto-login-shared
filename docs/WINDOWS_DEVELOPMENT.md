# Windows 版开发与验收

## 已确定范围

用户已确认 Windows 11、Intel x64、Edge；由同学在 Windows 电脑测试，用户转交安装包。采用当前用户 DPAPI，不缩小协议密码长度。保留现有设置页布局，仅替换必需的平台说明。Mac 与 Windows 分别分发，安装包仅含相应系统的文件。

Windows 助手版本独立记录在 `native/windows/config.json`。`native/config.json` 仍记录共享主机名、扩展 ID、协议，以及 Mac 助手版本。共享扩展版本为 0.1.6，Windows 助手为 0.1.0，Mac 助手为 0.1.3，通信协议仍为 1。

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

生产助手只能在 Windows 上验证。Mac 上通过的协议测试、模拟注册表测试、PE 文件检查、Chromium 页面测试都不能替代以下验收：

1. 最终 ZIP 在新的 Windows 用户目录解压；记录系统提示、安装操作次数和时间。
2. 真正的 DPAPI 保存、更新、读取、删除，以及目录权限和异常处理。
3. 真正的 32/64 位注册表连接、外部注册冲突、权限拒绝、运行中助手被占用、安装失败后的恢复。
4. Edge 加载扩展；确认扩展 ID 与固定来源一致；检查真实浏览器到实际助手的通信。
5. Windows 的隔离虚拟学校页面回归，以及用户同意下的三个学校网站实测。
6. 从同一个最终包覆盖安装、卸载、重复卸载、重装，确认凭据和已保存开关的保留规则。

面向同学的简明步骤在 `docs/WINDOWS.md`，随 Windows 包作为 README 分发。正式签名、商店发布及项目公开许可证仍未完成。

## 官方资料

- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)
- [Windows 当前用户 DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
- [.NET 单文件发布](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)
- [.NET 自包含裁剪](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trim-self-contained)
- [Native AOT 跨系统编译限制](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/cross-compile)
