using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace Tsinghua;

public sealed record Registration(bool Exists, string? Value);
public interface IRegistrations
{
    Registration[] Read();
    void CheckMachineConflicts(string expectedManifest);
    void Set(int index, Registration value);
}

public static class Package
{
    public static void Extract(byte[] archive, string expectedHash, string destination)
    {
        if (!Convert.ToHexString(SHA256.HashData(archive)).Equals(expectedHash, StringComparison.OrdinalIgnoreCase))
            throw new IOException("安装文件损坏，请重新下载完整安装包。");
        using var zip = new ZipArchive(new MemoryStream(archive), ZipArchiveMode.Read);
        var names = zip.Entries.Select(e => e.FullName).ToArray();
        if (names.Distinct(StringComparer.OrdinalIgnoreCase).Count() != names.Length ||
            names.Any(n => !SafeName(n)) || zip.Entries.Sum(e => e.Length) > 300_000_000)
            throw new IOException("安装包文件清单无效。");
        var metadata = zip.GetEntry("package.json") ?? throw new IOException("安装包缺少配对信息。");
        if (metadata.Length > 100_000) throw new IOException("安装包清单过大。");
        using var document = JsonDocument.Parse(metadata.Open());
        var root = document.RootElement;
        if (root.GetProperty("host").GetString() != BuildInfo.Host ||
            root.GetProperty("extensionId").GetString() != BuildInfo.ExtensionId ||
            root.GetProperty("protocol").GetInt32() != BuildInfo.Protocol ||
            root.GetProperty("helperVersion").GetString() != BuildInfo.Version ||
            root.GetProperty("extensionVersion").GetString() != BuildInfo.ExtensionVersion)
            throw new IOException("安装包中的组件不属于同一次构建。");
        var hashes = root.GetProperty("files").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!, StringComparer.Ordinal);
        if (!hashes.Keys.Append("package.json").ToHashSet(StringComparer.Ordinal).SetEquals(names) ||
            !hashes.ContainsKey("host/TsinghuaLoginHost.exe") || !hashes.ContainsKey("extension/manifest.json"))
            throw new IOException("安装包有文件缺失或混入额外文件。");
        foreach (var entry in zip.Entries)
        {
            if (entry.FullName == "package.json") continue;
            using var contents = entry.Open();
            if (!Convert.ToHexString(SHA256.HashData(contents)).Equals(hashes[entry.FullName], StringComparison.OrdinalIgnoreCase))
                throw new IOException("安装包校验失败。");
        }
        using (var manifest = JsonDocument.Parse(zip.GetEntry("extension/manifest.json")!.Open()))
        {
            if (manifest.RootElement.GetProperty("key").GetString() != BuildInfo.PublicKey ||
                manifest.RootElement.GetProperty("version").GetString() != BuildInfo.ExtensionVersion)
                throw new IOException("扩展身份或版本不匹配。");
        }
        Directory.CreateDirectory(destination);
        foreach (var entry in zip.Entries)
        {
            var path = Path.Combine(destination, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            using var contents = entry.Open(); using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            contents.CopyTo(file); file.Flush(true);
        }
        foreach (var (name, hash) in hashes)
        {
            using var file = File.OpenRead(Path.Combine(destination, name));
            if (!Convert.ToHexString(SHA256.HashData(file)).Equals(hash, StringComparison.OrdinalIgnoreCase))
                throw new IOException("暂存文件校验失败。");
        }
    }
    static bool SafeName(string name) => name.Length is > 0 and < 240 && !name.Contains('\\') &&
        name.Split('/').All(p => p.Length > 0 && p is not "." and not ".." && !p.EndsWith('.') && !p.EndsWith(' ') &&
            !p.Any(c => c < 32 || ":*?\"<>|".Contains(c)) &&
            !new[] { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" }.Contains(p.Split('.')[0], StringComparer.OrdinalIgnoreCase));
}

// The entry point supplies only fixed application paths. Injectable storage/registrations
// allow rollback tests without touching the developer's browser or real credentials.
public sealed class Installation(string destination, IRegistrations registrations, Action<string>? checkpoint = null)
{
    public string Destination { get; } = Path.GetFullPath(destination);
    string Transaction => Destination + ".transaction";
    string Next => Path.Combine(Transaction, "next");
    string Previous => Path.Combine(Transaction, "previous");
    string Journal => Path.Combine(Transaction, "journal.json");
    public string Manifest => Path.Combine(Destination, BuildInfo.Host + ".json");
    void Step(string step) => checkpoint?.Invoke(step);

    static void CheckTree(string path)
    {
        if (!Directory.Exists(path))
        {
            if (File.Exists(path)) throw new IOException("安装位置被其他文件占用。");
            return;
        }
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("安装位置不能是链接。");
        foreach (var item in Directory.EnumerateFileSystemEntries(path))
        {
            var attributes = File.GetAttributes(item);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("安装文件包含链接，已停止操作。");
            if ((attributes & FileAttributes.Directory) != 0) CheckTree(item);
        }
    }
    void CheckOwned(string path)
    {
        if (!Directory.Exists(path)) { CheckTree(path); return; }
        CheckTree(path);
        var marker = Path.Combine(path, "installation.json");
        if (!File.Exists(marker)) throw new IOException("安装目录已被其他文件占用，已停止操作。");
        using var json = JsonDocument.Parse(File.ReadAllBytes(marker));
        if (json.RootElement.GetProperty("host").GetString() != BuildInfo.Host ||
            json.RootElement.GetProperty("extensionId").GetString() != BuildInfo.ExtensionId)
            throw new IOException("安装目录不属于本项目，已停止操作。");
    }
    Registration[] Preflight()
    {
        CheckOwned(Destination); registrations.CheckMachineConflicts(Manifest);
        var snapshot = registrations.Read();
        if (snapshot.Length != 4 || snapshot.Any(v => v.Exists && !string.Equals(v.Value, Manifest, StringComparison.OrdinalIgnoreCase)))
            throw new IOException("浏览器连接配置指向其他程序，已停止操作。");
        return snapshot;
    }
    void WriteJournal(Registration[] snapshot, bool oldExists, bool committed)
    {
        var bytes = Protocol.Json(w =>
        {
            w.WriteStartObject(); w.WriteString("host", BuildInfo.Host); w.WriteString("destination", Destination);
            w.WriteBoolean("oldExists", oldExists); w.WriteBoolean("committed", committed); w.WriteStartArray("registrations");
            foreach (var item in snapshot)
            { w.WriteStartObject(); w.WriteBoolean("exists", item.Exists); w.WriteString("value", item.Value); w.WriteEndObject(); }
            w.WriteEndArray(); w.WriteEndObject();
        });
        var temporary = Journal + ".new";
        using (var file = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        { file.Write(bytes); file.Flush(true); }
        File.Move(temporary, Journal, true);
    }
    public void Recover()
    {
        if (!Directory.Exists(Transaction)) return;
        CheckTree(Transaction);
        if (!File.Exists(Journal)) throw new IOException("存在未完成的安装目录，请保留并反馈：" + Transaction);
        using var json = JsonDocument.Parse(File.ReadAllBytes(Journal)); var root = json.RootElement;
        if (root.GetProperty("host").GetString() != BuildInfo.Host || root.GetProperty("destination").GetString() != Destination)
            throw new IOException("安装恢复信息无效，请保留并反馈：" + Transaction);
        if (!root.GetProperty("committed").GetBoolean())
        {
            var snapshot = root.GetProperty("registrations").EnumerateArray()
                .Select(v => new Registration(v.GetProperty("exists").GetBoolean(), v.GetProperty("value").GetString())).ToArray();
            if (snapshot.Length != 4 || snapshot.Any(v => v.Exists && !string.Equals(v.Value, Manifest, StringComparison.OrdinalIgnoreCase)))
                throw new IOException("安装恢复信息中的连接配置无效。");
            registrations.CheckMachineConflicts(Manifest);
            var current = registrations.Read();
            if (current.Length != snapshot.Length || current.Where((v, index) => v.Exists &&
                !string.Equals(v.Value, Manifest, StringComparison.OrdinalIgnoreCase) &&
                !(v.Value == null && !snapshot[index].Exists)).Any())
                throw new IOException("连接配置在安装中途被其他程序更改，请保留并反馈：" + Transaction);
            if (Directory.Exists(Previous))
            {
                CheckOwned(Previous); CheckOwned(Destination);
                if (Directory.Exists(Destination)) Directory.Delete(Destination, true);
                RetryMove(Previous, Destination);
            }
            else if (!root.GetProperty("oldExists").GetBoolean() && Directory.Exists(Destination))
            { CheckOwned(Destination); Directory.Delete(Destination, true); }
            for (int i = 0; i < snapshot.Length; i++) registrations.Set(i, snapshot[i]);
        }
        Directory.Delete(Transaction, true);
    }
    static void RetryMove(string source, string target)
    {
        for (int attempt = 0; ; attempt++)
        {
            try { Directory.Move(source, target); return; }
            catch (IOException) when (attempt < 8) { Thread.Sleep(250); }
        }
    }
    void Begin(Registration[] snapshot, bool oldExists)
    {
        Directory.CreateDirectory(Transaction);
        if (OperatingSystem.IsWindows()) PrivateFiles.CreateDirectory(Transaction);
        WriteJournal(snapshot, oldExists, false);
    }
    void Rollback(Exception original)
    {
        try { Recover(); }
        catch { throw new IOException("操作未完成，旧文件与恢复信息已保留。请关闭浏览器后重试；如仍失败，请反馈此路径：" + Transaction, original); }
        throw new IOException("操作未完成，已恢复原来的安装和连接配置。请关闭浏览器后重试。", original);
    }
    public void Install(byte[] payload, string hash)
    {
        Recover(); var snapshot = Preflight(); bool oldExists = Directory.Exists(Destination);
        Begin(snapshot, oldExists);
        try
        {
            Package.Extract(payload, hash, Next); Step("staged");
            File.WriteAllBytes(Path.Combine(Next, "installation.json"), Protocol.Json(w =>
            { w.WriteStartObject(); w.WriteString("host", BuildInfo.Host); w.WriteString("extensionId", BuildInfo.ExtensionId); w.WriteEndObject(); }));
            File.WriteAllBytes(Path.Combine(Next, BuildInfo.Host + ".json"), Protocol.Json(w =>
            {
                w.WriteStartObject(); w.WriteString("name", BuildInfo.Host); w.WriteString("description", "Tsinghua shared login helper");
                w.WriteString("path", Path.Combine(Destination, "host", "TsinghuaLoginHost.exe")); w.WriteString("type", "stdio");
                w.WriteStartArray("allowed_origins"); w.WriteStringValue(BuildInfo.Origin); w.WriteEndArray(); w.WriteEndObject();
            }));
            if (oldExists) RetryMove(Destination, Previous);
            Step("old-moved"); RetryMove(Next, Destination); Step("new-moved");
            for (int i = 0; i < snapshot.Length; i++) { registrations.Set(i, new Registration(true, Manifest)); Step("registration-" + i); }
            WriteJournal(snapshot, oldExists, true);
        }
        catch (Exception error) { Rollback(error); }
        // A locked old file may prevent cleanup. The committed journal makes the next run safe.
        try { Recover(); } catch { /* Installation is committed; retain only the obsolete backup. */ }
    }
    public void Uninstall()
    {
        Recover(); var snapshot = Preflight(); bool oldExists = Directory.Exists(Destination);
        Begin(snapshot, oldExists);
        try
        {
            if (oldExists) RetryMove(Destination, Previous);
            Step("old-moved");
            for (int i = 0; i < snapshot.Length; i++) { registrations.Set(i, new Registration(false, null)); Step("registration-" + i); }
            WriteJournal(snapshot, oldExists, true);
        }
        catch (Exception error) { Rollback(error); }
        try { Recover(); } catch { throw new IOException("连接配置已移除，但文件仍被占用。请关闭浏览器，再次运行卸载程序以完成清理。"); }
    }
}
