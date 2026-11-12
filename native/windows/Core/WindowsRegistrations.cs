using Microsoft.Win32;
using System.Runtime.Versioning;

namespace Tsinghua;

[SupportedOSPlatform("windows")]
public sealed class WindowsRegistrations(string expectedManifest) : IRegistrations
{
    static readonly (RegistryView View, string Key)[] Locations =
        (from view in new[] { RegistryView.Registry32, RegistryView.Registry64 }
         from browser in new[] { @"Software\Microsoft\Edge", @"Software\Google\Chrome" }
         select (view, browser + @"\NativeMessagingHosts\" + BuildInfo.Host)).ToArray();
    static Registration ReadOne(RegistryHive hive, RegistryView view, string path)
    {
        using var root = RegistryKey.OpenBaseKey(hive, view);
        using var key = root.OpenSubKey(path, false);
        if (key == null) return new Registration(false, null);
        if (key.SubKeyCount == 0 && key.ValueCount == 0) return new Registration(true, null);
        if (key.SubKeyCount != 0 || key.ValueCount != 1 || !key.GetValueNames().Contains("") || key.GetValueKind("") != RegistryValueKind.String)
            throw new IOException("发现不属于本项目的同名浏览器配置，已停止操作。");
        return new Registration(true, key.GetValue("", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string);
    }
    public Registration[] Read() => Locations.Select(p => ReadOne(RegistryHive.CurrentUser, p.View, p.Key)).ToArray();
    public void CheckMachineConflicts(string expected)
    {
        foreach (var location in Locations)
        {
            var value = ReadOne(RegistryHive.LocalMachine, location.View, location.Key);
            // Never modify machine-wide settings, even if a previous installer used them.
            if (value.Exists) throw new IOException("发现电脑级同名连接配置。本安装程序只管理当前用户，请先由原安装程序处理该配置。");
        }
    }
    public void Set(int index, Registration value)
    {
        var (view, path) = Locations[index];
        var existing = ReadOne(RegistryHive.CurrentUser, view, path);
        if (existing.Exists && !string.Equals(existing.Value, expectedManifest, StringComparison.OrdinalIgnoreCase) &&
            !(existing.Value == null && !value.Exists))
            throw new IOException("浏览器连接配置已被其他程序更改。");
        if (value.Exists && !string.Equals(value.Value, expectedManifest, StringComparison.OrdinalIgnoreCase))
            throw new IOException("拒绝写入非本项目的连接配置。");
        using var root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, view);
        if (!value.Exists) { root.DeleteSubKey(path, false); return; }
        using var key = root.CreateSubKey(path, true);
        key.SetValue("", value.Value!, RegistryValueKind.String); key.Flush();
    }
}
