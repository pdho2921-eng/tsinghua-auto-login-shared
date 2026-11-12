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
    internal static bool SafeName(string name) => name.Length is > 0 and < 240 && !name.Contains('\\') &&
        name.Split('/').All(p => p.Length > 0 && p is not "." and not ".." && !p.EndsWith('.') && !p.EndsWith(' ') &&
            !p.Any(c => c < 32 || ":*?\"<>|".Contains(c)) &&
            !new[] { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" }.Contains(p.Split('.')[0], StringComparer.OrdinalIgnoreCase));
}

// The entry point supplies only fixed application paths. Injectable storage/registrations
// allow rollback tests without touching the developer's browser or real credentials.
public sealed class Installation(string destination, IRegistrations registrations, Action<string>? checkpoint = null,
    Action<string, string>? moveDirectory = null)
{
    public string Destination { get; } = Path.GetFullPath(destination);
    public string Phase { get; private set; } = "检查已有安装";
    string Transaction => Destination + ".transaction";
    string Next => Path.Combine(Transaction, "next");
    string Previous => Path.Combine(Transaction, "previous");
    string Journal => Path.Combine(Transaction, "journal.json");
    public string Manifest => Path.Combine(Destination, BuildInfo.Host + ".json");
    sealed record FileChange(string Path, bool Existed);
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
    void WriteJournal(Registration[] snapshot, bool oldExists, bool committed,
        List<FileChange>? files = null, string[]? obsolete = null)
    {
        var bytes = Protocol.Json(w =>
        {
            w.WriteStartObject(); w.WriteString("host", BuildInfo.Host); w.WriteString("destination", Destination);
            w.WriteBoolean("oldExists", oldExists); w.WriteBoolean("committed", committed); w.WriteStartArray("registrations");
            foreach (var item in snapshot)
            { w.WriteStartObject(); w.WriteBoolean("exists", item.Exists); w.WriteString("value", item.Value); w.WriteEndObject(); }
            w.WriteEndArray();
            if (files != null)
            {
                w.WriteBoolean("inPlace", true); w.WriteStartArray("files");
                foreach (var file in files)
                { w.WriteStartObject(); w.WriteString("path", file.Path); w.WriteBoolean("existed", file.Existed); w.WriteEndObject(); }
                w.WriteEndArray(); w.WriteStartArray("obsolete");
                foreach (var name in obsolete ?? []) w.WriteStringValue(name);
                w.WriteEndArray();
            }
            w.WriteEndObject();
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
        bool inPlace = root.TryGetProperty("inPlace", out var mode) && mode.GetBoolean();
        var files = inPlace ? root.GetProperty("files").EnumerateArray()
            .Select(v => new FileChange(v.GetProperty("path").GetString()!, v.GetProperty("existed").GetBoolean())).ToArray() : [];
        var obsolete = inPlace ? root.GetProperty("obsolete").EnumerateArray().Select(v => v.GetString()!).ToArray() : [];
        if (inPlace && (!root.GetProperty("oldExists").GetBoolean() ||
            files.Select(v => v.Path).Concat(obsolete).Any(n => n == null || !Package.SafeName(n)) ||
            files.Select(v => v.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != files.Length ||
            files.Select(v => v.Path).Intersect(obsolete, StringComparer.OrdinalIgnoreCase).Any()))
            throw new IOException("逐文件更新的恢复信息无效，已停止操作。");
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
            if (inPlace)
            {
                CheckOwned(Destination);
                foreach (var file in files.Reverse())
                {
                    var target = Path.Combine(Destination, file.Path);
                    if (file.Existed)
                    {
                        var backup = Path.Combine(Previous, file.Path);
                        if (!File.Exists(backup)) throw new IOException("更新备份缺失，请保留并反馈：" + Transaction);
                        // A failed replacement may have left the original untouched.
                        // Do not try to replace that same, possibly locked, file again.
                        if (SameFile(backup, target)) continue;
                        var restore = Path.Combine(Transaction, "restore-" + Guid.NewGuid().ToString("N"));
                        File.Copy(backup, restore);
                        File.Move(restore, target, true);
                    }
                    else if (File.Exists(target)) File.Delete(target);
                }
            }
            else if (Directory.Exists(Previous))
            {
                CheckOwned(Previous); CheckOwned(Destination);
                if (Directory.Exists(Destination)) Directory.Delete(Destination, true);
                RetryMove(Previous, Destination);
            }
            else if (!root.GetProperty("oldExists").GetBoolean() && Directory.Exists(Destination))
            { CheckOwned(Destination); Directory.Delete(Destination, true); }
            for (int i = 0; i < snapshot.Length; i++) registrations.Set(i, snapshot[i]);
        }
        else if (inPlace)
        {
            CheckOwned(Destination);
            // Obsolete resources are no longer referenced by the new manifest.
            // A still-running old helper may keep its file open until it exits.
            foreach (var name in obsolete)
                try { File.Delete(Path.Combine(Destination, name)); }
                catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
        Directory.Delete(Transaction, true);
    }
    static bool SameFile(string first, string second)
    {
        if (!File.Exists(first) || !File.Exists(second) || new FileInfo(first).Length != new FileInfo(second).Length) return false;
        using var a = File.OpenRead(first); using var b = File.OpenRead(second);
        return SHA256.HashData(a).SequenceEqual(SHA256.HashData(b));
    }
    static bool CanUpdateInPlace(Exception error) => error.HResult is unchecked((int)0x80070005)
        or unchecked((int)0x80070020) or unchecked((int)0x80070021);
    (List<FileChange> Files, string[] Obsolete) UpdateFiles(Registration[] snapshot)
    {
        CheckOwned(Destination);
        var names = Directory.GetFiles(Next, "*", SearchOption.AllDirectories)
            .Select(p => Path.GetRelativePath(Next, p).Replace('\\', '/')).Order(StringComparer.Ordinal).ToArray();
        var obsolete = Directory.GetFiles(Destination, "*", SearchOption.AllDirectories)
            .Select(p => Path.GetRelativePath(Destination, p).Replace('\\', '/'))
            .Except(names, StringComparer.OrdinalIgnoreCase).ToArray();
        if (obsolete.Any(n => !Package.SafeName(n))) throw new IOException("旧安装中存在无法安全处理的额外文件，已停止更新。");
        var files = new List<FileChange>();
        // Record the mode before creating a partial backup; legacy recovery expects
        // `previous` to be a whole directory, whereas this mode restores each file.
        WriteJournal(snapshot, true, false, files, obsolete);
        Step("in-place-started");
        foreach (var name in names)
        {
            Phase = "更新文件：" + name;
            var source = Path.Combine(Next, name); var target = Path.Combine(Destination, name);
            if (SameFile(source, target)) continue;
            bool existed = File.Exists(target);
            if (existed)
            {
                var backup = Path.Combine(Previous, name);
                Directory.CreateDirectory(Path.GetDirectoryName(backup)!);
                File.Copy(target, backup);
            }
            files.Add(new FileChange(name, existed));
            WriteJournal(snapshot, true, false, files, obsolete);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Move(source, target, true);
            Step("in-place-file:" + name);
        }
        return (files, obsolete);
    }
    void RetryMove(string source, string target)
    {
        for (int attempt = 0; ; attempt++)
        {
            try { (moveDirectory ?? Directory.Move)(source, target); return; }
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
        catch (Exception recovery) { throw new SetupFailure(Phase,
            "旧文件与恢复信息已保留，请勿删除：" + Transaction + "\n恢复诊断代码：" + SetupErrors.Code(recovery), original); }
        throw new SetupFailure(Phase, "已恢复原来的安装和连接配置。原有账号密码未改动。", original);
    }
    public void Install(byte[] payload, string hash)
    {
        Phase = "恢复上次未完成的操作"; Recover();
        Phase = "检查已有安装和连接配置"; var snapshot = Preflight(); bool oldExists = Directory.Exists(Destination);
        Phase = "创建安装暂存目录";
        Begin(snapshot, oldExists);
        List<FileChange>? files = null; string[]? obsolete = null;
        try
        {
            Phase = "校验并解压新安装包"; Package.Extract(payload, hash, Next); Step("staged");
            File.WriteAllBytes(Path.Combine(Next, "installation.json"), Protocol.Json(w =>
            { w.WriteStartObject(); w.WriteString("host", BuildInfo.Host); w.WriteString("extensionId", BuildInfo.ExtensionId); w.WriteEndObject(); }));
            File.WriteAllBytes(Path.Combine(Next, BuildInfo.Host + ".json"), Protocol.Json(w =>
            {
                w.WriteStartObject(); w.WriteString("name", BuildInfo.Host); w.WriteString("description", "Tsinghua shared login helper");
                w.WriteString("path", Path.Combine(Destination, "host", "TsinghuaLoginHost.exe")); w.WriteString("type", "stdio");
                w.WriteStartArray("allowed_origins"); w.WriteStringValue(BuildInfo.Origin); w.WriteEndArray(); w.WriteEndObject();
            }));
            Phase = "替换旧版本文件";
            if (oldExists)
            {
                try { RetryMove(Destination, Previous); }
                catch (Exception error) when (CanUpdateInPlace(error) && Directory.Exists(Destination) && !Directory.Exists(Previous))
                { (files, obsolete) = UpdateFiles(snapshot); }
            }
            if (files == null)
            {
                Step("old-moved"); Phase = "放置新版本文件"; RetryMove(Next, Destination); Step("new-moved");
            }
            Phase = "更新浏览器连接配置";
            for (int i = 0; i < snapshot.Length; i++) { registrations.Set(i, new Registration(true, Manifest)); Step("registration-" + i); }
            Phase = "确认安装完成";
            WriteJournal(snapshot, oldExists, true, files, obsolete);
        }
        catch (Exception error) { Rollback(error); }
        // A locked old file may prevent cleanup. The committed journal makes the next run safe.
        try { Recover(); } catch { /* Installation is committed; retain only the obsolete backup. */ }
    }
    public void Uninstall()
    {
        Phase = "恢复上次未完成的操作"; Recover();
        Phase = "检查已有安装和连接配置"; var snapshot = Preflight(); bool oldExists = Directory.Exists(Destination);
        Phase = "创建卸载暂存目录";
        Begin(snapshot, oldExists);
        try
        {
            Phase = "移除旧版本文件"; if (oldExists) RetryMove(Destination, Previous);
            Step("old-moved");
            Phase = "移除浏览器连接配置";
            for (int i = 0; i < snapshot.Length; i++) { registrations.Set(i, new Registration(false, null)); Step("registration-" + i); }
            WriteJournal(snapshot, oldExists, true);
        }
        catch (Exception error) { Rollback(error); }
        try { Recover(); } catch (Exception error) { throw new SetupFailure("清理卸载文件",
            "连接配置已移除，部分文件尚未清理。解决上述原因后，再次运行卸载程序。", error); }
    }
}
