# 第三方材料说明

项目自身代码采用 [MIT 许可证](LICENSE)。下列材料保留原有版权及许可声明，不因项目采用 MIT 而改变其使用条件。

## 网站图标

设置页使用的网站图标及来源见 [SOURCES.md](extension/icons/sites/SOURCES.md)。学校网站图标保留原样，权益归原权利方，本项目的 MIT 许可证不包含对这些图标的额外授权。

网络学堂入口使用 Chromium 默认图标，完整许可见 [CHROMIUM-LICENSE.txt](extension/icons/sites/CHROMIUM-LICENSE.txt)。两平台安装包同时提供 `SITE-ICON-SOURCES.md` 和 `CHROMIUM-LICENSE.txt`，扩展资源目录也保留原有声明。

## Windows 自带的 .NET 运行时

Windows 助手和安装程序采用自包含发布，带有 `Microsoft.NETCore.App.Runtime.win-x64` **10.0.15** 的运行时组件。接收者无需另行安装 .NET。

- [运行时许可证原文](licenses/dotnet-runtime/LICENSE.TXT)
- [运行时第三方声明原文](licenses/dotnet-runtime/THIRD-PARTY-NOTICES.TXT)
- [所用版本和原文件校验值](licenses/dotnet-runtime/metadata.json)

以上两份原文从实际构建使用的 NuGet 运行时包复制，保留原始字节。上游项目为 [dotnet/runtime](https://github.com/dotnet/runtime)。Windows 安装包及安装后的文件中分别以 `DOTNET-LICENSE.txt` 和 `DOTNET-THIRD-PARTY-NOTICES.txt` 提供这些原文。Mac 安装包不包含 .NET 运行时及其声明。

构建脚本固定使用记录中的运行时版本，并核对实际依赖版本与许可文件。升级运行时时，应一并更新版本记录、两份原文及本说明，再重新构建和检查安装包。
