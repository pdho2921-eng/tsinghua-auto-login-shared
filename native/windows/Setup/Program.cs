using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using Tsinghua;

internal static class Program
{
    const string Title = "清华网站自动重登 · Windows 试用版";
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int MessageBoxW(nint window, string text, string caption, uint type);
    static void Open(string path) => Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows()) return 2;
        bool quiet = args.Length == 2 && args[1] == "--quiet";
        if (!(args.Length == 0 || args.Length == 1 || quiet) ||
            (args.Length > 0 && args[0] is not "--install" and not "--uninstall")) return 2;
        bool uninstall = args.Length > 0 ? args[0] == "--uninstall" : Path.GetFileNameWithoutExtension(Environment.ProcessPath) == "卸载";
        Installation? installation = null;
        try
        {
            if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000) || RuntimeInformation.OSArchitecture != Architecture.X64)
                throw new IOException("本试用包面向 Windows 11 的 Intel／AMD 64 位电脑。");
            using var user = WindowsIdentity.GetCurrent();
            if (new WindowsPrincipal(user).IsInRole(WindowsBuiltInRole.Administrator))
                throw new IOException("请直接双击运行，不要选择“以管理员身份运行”。助手只安装到当前 Windows 账号。");
            var destination = Path.Combine(PrivateFiles.LocalRoot, "TsinghuaAutoLoginShared");
            PrivateFiles.RejectLinks(destination); PrivateFiles.RejectLinks(destination + ".transaction");
            if (Path.GetFullPath(Environment.ProcessPath!).StartsWith(destination + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new IOException("请运行原始安装包中的安装或卸载程序。");
            using var mutex = new Mutex(false, "Local\\TsinghuaLoginSetup-" + user.User!.Value);
            bool held = false;
            try
            {
                try { held = mutex.WaitOne(TimeSpan.FromSeconds(3)); } catch (AbandonedMutexException) { held = true; }
                if (!held) throw new IOException("另一个安装或卸载操作正在进行，请稍后重试。");
                var manifest = Path.Combine(destination, BuildInfo.Host + ".json");
                installation = new Installation(destination, new WindowsRegistrations(manifest));
                if (uninstall)
                {
                    if (!quiet && MessageBoxW(0,
                        "卸载助手会保留账号密码。\n\n如需删除密码，请先回到扩展设置页，点击对应账号的“删除已保存密码”。\n\n现在卸载助手吗？卸载后请在 Edge 中移除扩展。", Title, 0x24) != 6) return 0;
                    installation.Uninstall();
                    if (!quiet) MessageBoxW(0, "本机助手已卸载，已保存的账号密码保留。请在 Edge 扩展管理页移除共享版扩展。", Title, 0x40);
                }
                else
                {
                    bool upgrading = Directory.Exists(destination);
                    using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")!;
                    using var memory = new MemoryStream(); resource.CopyTo(memory);
                    installation.Install(memory.ToArray(), PayloadInfo.Hash);
                    if (!quiet)
                    {
                        string next = upgrading
                            ? "已覆盖更新原共享版，账号密码和浏览器开关保留。\n\n请在 Edge 扩展管理页重新加载本扩展；若刚才关闭了扩展开关，请重新开启。刷新原先打开的学校网站即可启用新版，无需重新保存密码。"
                            : "接下来请按“开始使用”说明，在 Edge 加载 extension 文件夹，再保存账号密码。";
                        MessageBoxW(0, "安装完成。\n\n" + next + "\n\n扩展版本 " + BuildInfo.ExtensionVersion + "，助手版本 " + BuildInfo.Version + "。", Title, 0x40);
                        try { Open(Path.Combine(destination, "开始使用.html")); Open(Path.Combine(destination, "extension")); }
                        catch { MessageBoxW(0, "使用说明和扩展位于：\n" + destination, Title, 0x40); }
                    }
                }
            }
            finally { if (held) mutex.ReleaseMutex(); }
            return 0;
        }
        catch (Exception error)
        {
            if (!quiet)
            {
                string detail = SetupErrors.Describe(error, installation?.Phase ?? "启动安装程序");
                MessageBoxW(0, "操作未完成。\n\n" + detail, Title, 0x10);
            }
            return 1;
        }
    }
}
