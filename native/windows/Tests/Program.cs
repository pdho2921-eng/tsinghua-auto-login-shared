using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Tsinghua;

internal static class Program
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint sharing, nint security, uint disposition, uint flags, nint template);
    static int passed;
    static void Check(bool condition, string message = "assertion failed") { if (!condition) throw new Exception(message); }
    static void Test(string name, Action run) { run(); passed++; Console.WriteLine("PASS " + name); }
    static void Fails(Action run) { bool failed = false; try { run(); } catch { failed = true; } Check(failed); }
    sealed class Memory : IVault
    {
        public readonly Dictionary<string, Credential> Values = [];
        public Credential? Read(string role) => Values.GetValueOrDefault(role);
        public void Save(string role, Credential value) => Values[role] = value;
        public void Delete(string role) => Values.Remove(role);
    }
    sealed class Broken : IVault
    {
        public Credential? Read(string role) => throw new IOException("private exception text");
        public void Save(string role, Credential value) => throw new IOException("private exception text");
        public void Delete(string role) => throw new IOException("private exception text");
    }
    sealed class Registrations : IRegistrations
    {
        public Registration[] Values = Enumerable.Repeat(new Registration(false, null), 4).ToArray();
        public bool MachineConflict;
        public int FailIndex = -1;
        public bool LeaveEmptyKey;
        public Registration[] Read() => Values.ToArray();
        public void CheckMachineConflicts(string expected) { if (MachineConflict) throw new IOException("conflict"); }
        public void Set(int index, Registration value)
        {
            if (FailIndex == index)
            {
                FailIndex = -1;
                if (LeaveEmptyKey) Values[index] = new Registration(true, null);
                throw new UnauthorizedAccessException();
            }
            Values[index] = value;
        }
    }
    sealed class Fragments(byte[] data) : MemoryStream(data)
    {
        public override int Read(Span<byte> buffer) => base.Read(buffer[..Math.Min(1, buffer.Length)]);
    }
    static JsonElement Request(string json, IVault? vault = null) => JsonDocument.Parse(Protocol.Handle(Encoding.UTF8.GetBytes(json), vault ?? new Memory())).RootElement;
    static string Save(string role, string name, string password) => Encoding.UTF8.GetString(Protocol.Json(w =>
    { w.WriteStartObject(); w.WriteNumber("protocol", 1); w.WriteString("op", "save"); w.WriteString("role", role); w.WriteString("username", name); w.WriteString("password", password); w.WriteEndObject(); }));
    static void Error(string json, string code = "invalid-request") => Check(Request(json).GetProperty("error").GetString() == code);
    static byte[] Frame(byte[] content)
    {
        byte[] result = new byte[content.Length + 4]; BinaryPrimitives.WriteUInt32LittleEndian(result, (uint)content.Length); content.CopyTo(result, 4); return result;
    }
    static JsonElement Serve(byte[] bytes, bool fragments = false)
    {
        using var input = fragments ? new Fragments(bytes) : new MemoryStream(bytes);
        using var output = new MemoryStream(); Protocol.Serve(input, output, new Memory()); var result = output.ToArray();
        Check(result.Length >= 4); Check(BinaryPrimitives.ReadUInt32LittleEndian(result) == result.Length - 4);
        return JsonDocument.Parse(result.AsMemory(4)).RootElement;
    }
    static byte[] Fixture(bool wrongVersion = false, bool wrongKey = false, bool corruptHash = false)
    {
        var files = new Dictionary<string, byte[]> {
            ["host/TsinghuaLoginHost.exe"] = "MZ-fixture-not-executable"u8.ToArray(),
            ["extension/manifest.json"] = Protocol.Json(w => { w.WriteStartObject(); w.WriteString("version", wrongVersion ? "99.0" : BuildInfo.ExtensionVersion); w.WriteString("key", wrongKey ? "wrong" : BuildInfo.PublicKey); w.WriteEndObject(); }),
            ["extension/policy.js"] = "fixture"u8.ToArray()
        };
        files["package.json"] = Protocol.Json(w =>
        {
            w.WriteStartObject(); w.WriteString("host", BuildInfo.Host); w.WriteString("extensionId", BuildInfo.ExtensionId);
            w.WriteNumber("protocol", BuildInfo.Protocol); w.WriteString("helperVersion", BuildInfo.Version); w.WriteString("extensionVersion", BuildInfo.ExtensionVersion);
            w.WriteStartObject("files"); foreach (var (name, data) in files) w.WriteString(name, corruptHash ? new string('0', 64) : Hash(data)); w.WriteEndObject(); w.WriteEndObject();
        });
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true))
            foreach (var (name, data) in files) { using var stream = zip.CreateEntry(name).Open(); stream.Write(data); }
        return memory.ToArray();
    }
    static string Hash(byte[] data) => Convert.ToHexString(SHA256.HashData(data));
    static void InDirectory(Action<string> run)
    {
        var path = Path.Combine(Path.GetTempPath(), "thu-windows-check-中文 空格-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        try { run(path); } finally { Directory.Delete(path, true); }
    }
    static void ProtocolTests()
    {
        Test("origin and Windows parent argument allowlist", () =>
        {
            Check(Protocol.ValidArguments([BuildInfo.Origin])); Check(Protocol.ValidArguments([BuildInfo.Origin, "--parent-window=0"]));
            Check(Protocol.ValidArguments([BuildInfo.Origin, "--parent-window=18446744073709551615"]));
            foreach (var arguments in new[] { Array.Empty<string>(), new[] { BuildInfo.Origin.TrimEnd('/') }, new[] { BuildInfo.Origin, "--parent-window=-1" }, new[] { BuildInfo.Origin, "--parent-window=1x" }, new[] { BuildInfo.Origin, "--parent-window=" }, new[] { BuildInfo.Origin, "--parent-window=18446744073709551616" }, new[] { BuildInfo.Origin, "--path=x" }, new[] { BuildInfo.Origin, "--parent-window=0", "extra" } }) Check(!Protocol.ValidArguments(arguments));
        });
        Test("role save update read delete isolation; status excludes passwords", () =>
        {
            var vault = new Memory();
            foreach (var role in Protocol.Roles)
            {
                Check(Request(Save(role, "  测试 e\u0301  ", "虚拟🔑密码"), vault).GetProperty("ok").GetBoolean());
                Check(Request($$"""{"protocol":1,"op":"get","role":"{{role}}"}""", vault).GetProperty("username").GetString() == "测试 e\u0301");
                Check(Request(Save(role, "updated", "new\npass\0"), vault).GetProperty("ok").GetBoolean());
            }
            var status = Request("""{"protocol":1,"op":"status"}""", vault).GetRawText(); Check(!status.Contains("password") && !status.Contains("new\\npass"));
            Check(vault.Values.Count == 2);
            foreach (var role in Protocol.Roles)
            {
                Check(Request($$"""{"protocol":1,"op":"delete","role":"{{role}}"}""", vault).GetProperty("ok").GetBoolean());
                Check(Request($$"""{"protocol":1,"op":"delete","role":"{{role}}"}""", vault).GetProperty("ok").GetBoolean());
                Check(Request($$"""{"protocol":1,"op":"get","role":"{{role}}"}""", vault).GetProperty("error").GetString() == "not-found");
            }
        });
        Test("strict operation schema and protocol type", () =>
        {
            foreach (var json in new[] { "[]", "{}", "{", "null", """{"protocol":1,"op":"execute"}""", """{"protocol":1,"op":"status","path":"x"}""", """{"protocol":1,"op":"get","role":"other"}""", """{"protocol":1,"op":"get","role":"identity","command":"x"}""", """{"protocol":1,"op":"status","op":"status"}""", """{"protocol":1,"op":"save","role":"identity","username":"x"}""" })
                Error(json, json == "{}" ? "protocol-mismatch" : "invalid-request");
            foreach (var value in new[] { "true", "\"1\"", "1.0", "2", "null", "-1" }) Error("{\"protocol\":" + value + ",\"op\":\"status\"}", "protocol-mismatch");
        });
        Test("grapheme limits and Unicode controls", () =>
        {
            Check(Request(Save("identity", string.Concat(Enumerable.Repeat("e\u0301", 160)), string.Concat(Enumerable.Repeat("🔑", 4096)))).GetProperty("ok").GetBoolean());
            Error(Save("identity", new string('a', 161), "x")); Error(Save("identity", "x", new string('a', 4097)));
            foreach (var name in new[] { "  ", "a\0b", "a\nb", "a\u200Db" }) Error(Save("identity", name, "p"));
            Error(Save("identity", "x", ""));
        });
        Test("byte limit and malformed UTF8", () =>
        {
            Check(JsonDocument.Parse(Protocol.Handle(new byte[] { 0xff, 0xfe }, new Memory())).RootElement.GetProperty("error").GetString() == "invalid-request");
            Error(new string(' ', 65_537));
            var json = "{\"protocol\":1,\"op\":\"status\"}";
            Check(Request(json.PadRight(65_536)).GetProperty("ok").GetBoolean());
        });
        Test("fragmented binary frame; one request per process", () =>
        {
            var message = Frame(Encoding.UTF8.GetBytes("""{"protocol":1,"op":"status"}"""));
            Check(Serve(message, true).GetProperty("ok").GetBoolean());
            Check(Serve(message.Concat(message).ToArray()).GetProperty("ok").GetBoolean());
            foreach (var input in new[] { new byte[] { 1 }, new byte[] { 0, 0, 0, 0 }, new byte[] { 1, 0, 1, 0 }, new byte[] { 8, 0, 0, 0, 123 } })
                Check(Serve(input).GetProperty("error").GetString() == "invalid-request");
            using var output = new MemoryStream(); Protocol.Serve(new MemoryStream(), output, new Memory()); Check(output.Length == 0);
        });
        Test("storage failures disclose only error code", () =>
        {
            var json = Request("""{"protocol":1,"op":"status"}""", new Broken()).GetRawText(); Check(json.Contains("storage-error") && !json.Contains("private"));
        });
    }
    static void InstallTests()
    {
        Test("upgrade succeeds when the old installation directory cannot be renamed", () => InDirectory(root =>
        {
            var regs = new Registrations(); var destination = Path.Combine(root, "app"); var payload = Fixture();
            new Installation(destination, regs).Install(payload, Hash(payload));
            File.WriteAllText(Path.Combine(destination, "extension", "policy.js"), "old-script");
            File.WriteAllText(Path.Combine(destination, "extension", "obsolete.js"), "old-file");
            var installer = new Installation(destination, regs, moveDirectory: (source, target) =>
            {
                if (source == destination) throw new IOException("Directory held by browser", unchecked((int)0x80070005));
                Directory.Move(source, target);
            });
            installer.Install(payload, Hash(payload));
            Check(File.ReadAllText(Path.Combine(destination, "extension", "policy.js")) == "fixture");
            Check(!File.Exists(Path.Combine(destination, "extension", "obsolete.js")));
            Check(regs.Values.All(v => v.Value == installer.Manifest));
            Check(!Directory.Exists(destination + ".transaction"));
        }));
        Test("upgrade failure reports the original lock code after restoring old files", () => InDirectory(root =>
        {
            var regs = new Registrations(); var installer = new Installation(Path.Combine(root, "app"), regs); var payload = Fixture();
            installer.Install(payload, Hash(payload)); File.WriteAllText(Path.Combine(installer.Destination, "old-version"), "keep");
            var locked = new Installation(installer.Destination, regs, step =>
            { if (step == "staged") throw new IOException("fixture lock", unchecked((int)0x80070020)); });
            string message = "";
            try { locked.Install(payload, Hash(payload)); } catch (IOException error) { message = error.Message; }
            Check(message.Contains("已恢复原来的安装和连接配置"), message);
            Check(message.Contains("80070020") && message.Contains("文件被占用"), message);
            Check(File.ReadAllText(Path.Combine(installer.Destination, "old-version")) == "keep");
            installer.Install(payload, Hash(payload)); Check(!File.Exists(Path.Combine(installer.Destination, "old-version")));
        }));
        foreach (var failureAt in new[] { "in-place-started", "in-place-file:extension/manifest.json", "in-place-file:extension/policy.js", "in-place-file:host/TsinghuaLoginHost.exe", "registration-1" })
            Test("in-place rollback restores overwritten and newly created files at " + failureAt, () => InDirectory(root =>
            {
                var regs = new Registrations(); var destination = Path.Combine(root, "app"); var payload = Fixture();
                new Installation(destination, regs).Install(payload, Hash(payload));
                File.WriteAllText(Path.Combine(destination, "extension", "manifest.json"), "{\"version\":\"0.1.6\"}");
                File.Delete(Path.Combine(destination, "extension", "policy.js"));
                File.WriteAllText(Path.Combine(destination, "host", "TsinghuaLoginHost.exe"), "old-host");
                var before = Directory.GetFiles(destination, "*", SearchOption.AllDirectories).ToDictionary(p => p, p => Hash(File.ReadAllBytes(p)));
                var values = regs.Read();
                var installer = new Installation(destination, regs, step => { if (step == failureAt) throw new IOException("injected"); },
                    (source, target) => { if (source == destination) throw new IOException("directory in use", unchecked((int)0x80070005)); Directory.Move(source, target); });
                Fails(() => installer.Install(payload, Hash(payload)));
                Check(Directory.GetFiles(destination, "*", SearchOption.AllDirectories).ToHashSet().SetEquals(before.Keys));
                Check(before.All(p => Hash(File.ReadAllBytes(p.Key)) == p.Value));
                Check(values.SequenceEqual(regs.Values)); Check(!Directory.Exists(destination + ".transaction"));
            }));
        Test("upgrade replaces an older extension without changing external credentials or settings", () => InDirectory(root =>
        {
            var regs = new Registrations(); var installer = new Installation(Path.Combine(root, "app"), regs); var payload = Fixture();
            installer.Install(payload, Hash(payload));
            File.WriteAllText(Path.Combine(installer.Destination, "extension", "manifest.json"), "{\"version\":\"0.1.6\"}");
            File.WriteAllText(Path.Combine(installer.Destination, "extension", "obsolete.js"), "old");
            var credentials = Path.Combine(root, "TsinghuaAutoLoginShared.Credentials.v1"); Directory.CreateDirectory(credentials);
            File.WriteAllText(Path.Combine(credentials, "identity.dpapi"), "encrypted-fixture");
            var settings = Path.Combine(root, "Edge-profile-settings"); File.WriteAllText(settings, "automatic=false");
            installer.Install(payload, Hash(payload));
            using var manifest = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(installer.Destination, "extension", "manifest.json")));
            Check(manifest.RootElement.GetProperty("version").GetString() == BuildInfo.ExtensionVersion);
            Check(!File.Exists(Path.Combine(installer.Destination, "extension", "obsolete.js")));
            Check(File.ReadAllText(Path.Combine(credentials, "identity.dpapi")) == "encrypted-fixture");
            Check(File.ReadAllText(settings) == "automatic=false");
        }));
        Test("next invocation recovers a persisted in-place update interrupted after a file replacement", () => InDirectory(root =>
        {
            var regs = new Registrations(); var destination = Path.Combine(root, "app"); var payload = Fixture();
            new Installation(destination, regs).Install(payload, Hash(payload));
            var script = Path.Combine(destination, "extension", "policy.js"); File.WriteAllText(script, "old-script");
            Dictionary<string, byte[]>? persisted = null;
            var transaction = destination + ".transaction";
            var installer = new Installation(destination, regs, step =>
            {
                if (step != "in-place-file:extension/policy.js") return;
                persisted = Directory.GetFiles(transaction, "*", SearchOption.AllDirectories)
                    .ToDictionary(p => Path.GetRelativePath(transaction, p), File.ReadAllBytes);
                throw new IOException("capture simulated interruption");
            }, (source, target) => { if (source == destination) throw new IOException("directory in use", unchecked((int)0x80070005)); Directory.Move(source, target); });
            Fails(() => installer.Install(payload, Hash(payload))); Check(persisted != null);
            // Replay the exact journal/backups captured before rollback, with the
            // changed file still installed, as after abrupt process termination.
            File.WriteAllText(script, "fixture");
            foreach (var file in persisted!)
            {
                var target = Path.Combine(transaction, file.Key); Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.WriteAllBytes(target, file.Value);
            }
            new Installation(destination, regs).Recover();
            Check(File.ReadAllText(script) == "old-script"); Check(!Directory.Exists(transaction));
            Check(regs.Values.All(v => v.Exists));
        }));
        Test("install upgrade uninstall twice reinstall; credentials untouched", () => InDirectory(root =>
        {
            var destination = Path.Combine(root, "安装 文件夹"); var regs = new Registrations(); var installer = new Installation(destination, regs);
            var payload = Fixture(); File.WriteAllText(Path.Combine(root, "credentials.dpapi"), "sentinel");
            installer.Install(payload, Hash(payload)); installer.Install(payload, Hash(payload));
            Check(regs.Values.All(v => v.Value == installer.Manifest));
            using var manifest = JsonDocument.Parse(File.ReadAllBytes(installer.Manifest));
            Check(manifest.RootElement.GetProperty("allowed_origins")[0].GetString() == BuildInfo.Origin);
            installer.Uninstall(); installer.Uninstall(); Check(regs.Values.All(v => !v.Exists)); Check(!Directory.Exists(destination));
            installer.Install(payload, Hash(payload)); Check(File.ReadAllText(Path.Combine(root, "credentials.dpapi")) == "sentinel");
        }));
        foreach (bool existing in new[] { false, true })
        foreach (string step in new[] { "staged", "old-moved", "new-moved", "registration-0", "registration-1", "registration-2", "registration-3" })
            Test($"rollback {(existing ? "upgrade" : "fresh")} at {step}", () => InDirectory(root =>
            {
                var destination = Path.Combine(root, "app"); var regs = new Registrations(); var payload = Fixture();
                var installer = new Installation(destination, regs);
                if (existing) { installer.Install(payload, Hash(payload)); File.WriteAllText(Path.Combine(destination, "sentinel"), "old-version"); }
                var before = regs.Read();
                var faulty = new Installation(destination, regs, at => { if (at == step) throw new IOException("injected"); });
                Fails(() => faulty.Install(payload, Hash(payload)));
                Check(before.SequenceEqual(regs.Values)); Check(Directory.Exists(destination) == existing);
                if (existing) Check(File.ReadAllText(Path.Combine(destination, "sentinel")) == "old-version");
                Check(!Directory.Exists(destination + ".transaction"));
            }));
        Test("registration write denied restores whole installation", () => InDirectory(root =>
        {
            var regs = new Registrations(); var installer = new Installation(Path.Combine(root, "app"), regs); var payload = Fixture();
            installer.Install(payload, Hash(payload)); regs.FailIndex = 2;
            Fails(() => installer.Uninstall()); Check(Directory.Exists(installer.Destination)); Check(regs.Values.All(v => v.Exists));
        }));
        Test("permission failures preserve their phase and are not reported as a confirmed browser lock", () => InDirectory(root =>
        {
            var regs = new Registrations(); var installer = new Installation(Path.Combine(root, "app"), regs); var payload = Fixture();
            installer.Install(payload, Hash(payload)); regs.FailIndex = 1;
            string message = "";
            try { installer.Install(payload, Hash(payload)); } catch (IOException error) { message = error.Message; }
            Check(message.Contains("更新浏览器连接配置") && message.Contains("UnauthorizedAccessException/80070005"), message);
            Check(!message.Contains("文件被占用，暂时不能替换"), message);
            Check(Directory.Exists(installer.Destination) && regs.Values.All(v => v.Exists));
            Check(SetupErrors.Describe(new InvalidOperationException("private diagnostic"), "校验安装包").Contains("诊断代码"));
        }));
        Test("partially created empty registration is rolled back", () => InDirectory(root =>
        {
            var regs = new Registrations { FailIndex = 1, LeaveEmptyKey = true };
            var installer = new Installation(Path.Combine(root, "app"), regs); var payload = Fixture();
            Fails(() => installer.Install(payload, Hash(payload)));
            Check(!Directory.Exists(installer.Destination) && regs.Values.All(v => !v.Exists));
            regs.Values[1] = new Registration(true, null); // A pre-existing empty foreign key is not ours.
            Fails(() => installer.Install(payload, Hash(payload))); Check(regs.Values[1].Exists);
        }));
        Test("interrupted upgrade recovers on the next invocation", () => InDirectory(root =>
        {
            var regs = new Registrations(); var installer = new Installation(Path.Combine(root, "app"), regs); var payload = Fixture();
            installer.Install(payload, Hash(payload));
            var transaction = installer.Destination + ".transaction"; Directory.CreateDirectory(transaction);
            File.WriteAllBytes(Path.Combine(transaction, "journal.json"), Protocol.Json(w =>
            {
                w.WriteStartObject(); w.WriteString("host", BuildInfo.Host); w.WriteString("destination", installer.Destination);
                w.WriteBoolean("oldExists", true); w.WriteBoolean("committed", false); w.WriteStartArray("registrations");
                foreach (var item in regs.Values) { w.WriteStartObject(); w.WriteBoolean("exists", item.Exists); w.WriteString("value", item.Value); w.WriteEndObject(); }
                w.WriteEndArray(); w.WriteEndObject();
            }));
            Directory.Move(installer.Destination, Path.Combine(transaction, "previous"));
            regs.Values[0] = new Registration(false, null); installer.Recover();
            Check(Directory.Exists(installer.Destination) && regs.Values.All(v => v.Exists)); Check(!Directory.Exists(transaction));
        }));
        Test("external registrations and unrelated directory are preserved", () => InDirectory(root =>
        {
            var regs = new Registrations(); var installer = new Installation(Path.Combine(root, "app"), regs); var payload = Fixture();
            regs.Values[0] = new Registration(true, "other-application.json"); Fails(() => installer.Install(payload, Hash(payload))); Check(!Directory.Exists(installer.Destination));
            Check(regs.Values[0].Value == "other-application.json"); Fails(installer.Uninstall);
            regs.Values[0] = new Registration(false, null); regs.MachineConflict = true; Fails(() => installer.Install(payload, Hash(payload)));
            regs.MachineConflict = false; Directory.CreateDirectory(installer.Destination); File.WriteAllText(Path.Combine(installer.Destination, "mine"), "unrelated");
            Fails(() => installer.Install(payload, Hash(payload))); Check(File.ReadAllText(Path.Combine(installer.Destination, "mine")) == "unrelated");
        }));
        Test("mixed versions keys corrupt payload and extra paths fail before install", () => InDirectory(root =>
        {
            var regs = new Registrations(); var installer = new Installation(Path.Combine(root, "app"), regs);
            foreach (var payload in new[] { Fixture(true), Fixture(false, true), Fixture(false, false, true) })
            { Fails(() => installer.Install(payload, Hash(payload))); Check(!Directory.Exists(installer.Destination)); }
            Fails(() => installer.Install(Fixture(), new string('0', 64)));
            using var memory = new MemoryStream(); using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true)) { using var entry = zip.CreateEntry("../escape").Open(); entry.WriteByte(1); }
            Fails(() => installer.Install(memory.ToArray(), Hash(memory.ToArray()))); Check(!File.Exists(Path.Combine(root, "escape")));
        }));
    }
    static int Main(string[] args)
    {
        try
        {
            if (args.SequenceEqual(new[] { "--protocol" })) { Protocol.Serve(Console.OpenStandardInput(), Console.OpenStandardOutput(), new Memory()); return 0; }
            ProtocolTests(); InstallTests();
            if (OperatingSystem.IsWindows())
            {
                Test("Windows directory handle without delete sharing permits an in-place upgrade", () => InDirectory(root =>
                {
                    var regs = new Registrations(); var destination = Path.Combine(root, "app"); var installer = new Installation(destination, regs); var payload = Fixture();
                    installer.Install(payload, Hash(payload)); File.WriteAllText(Path.Combine(destination, "extension", "policy.js"), "old-script");
                    using var held = CreateFileW(destination, 0, 3, 0, 3, 0x02000000, 0);
                    Check(!held.IsInvalid, "Could not create the Windows directory-lock fixture");
                    installer.Install(payload, Hash(payload));
                    Check(File.ReadAllText(Path.Combine(destination, "extension", "policy.js")) == "fixture");
                }));
                Test("Windows locked old helper rolls back and upgrades after the handle is released", () => InDirectory(root =>
                {
                    var regs = new Registrations(); var installer = new Installation(Path.Combine(root, "app"), regs); var payload = Fixture();
                    installer.Install(payload, Hash(payload));
                    File.WriteAllText(Path.Combine(installer.Destination, "host", "TsinghuaLoginHost.exe"), "older-helper");
                    using (var locked = new FileStream(Path.Combine(installer.Destination, "host", "TsinghuaLoginHost.exe"), FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        string message = "";
                        try { installer.Install(payload, Hash(payload)); } catch (IOException error) { message = error.Message; }
                        Check(message.Contains("已恢复原来的安装和连接配置") && message.Contains("诊断代码"), message);
                        Check(regs.Values.All(v => v.Exists));
                    }
                    installer.Install(payload, Hash(payload)); Check(!Directory.Exists(installer.Destination + ".transaction"));
                }));
                Test("real current-user DPAPI long Unicode secrets; corruption fails closed", () => InDirectory(root =>
                {
                    if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
                    IVault vault = new DpapiVault(Path.Combine(root, "test-vault"));
                    var secret = string.Concat(Enumerable.Repeat("虚拟🔑", 1500));
                    foreach (var role in Protocol.Roles)
                    {
                        vault.Save(role, new Credential("fixture", secret)); Check(vault.Read(role)?.Password == secret);
                        Check(!Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(root, "test-vault", role + ".dpapi"))).Contains("fixture"));
                        vault.Save(role, new Credential("updated", "replacement")); Check(vault.Read(role)?.Username == "updated");
                    }
                    File.WriteAllBytes(Path.Combine(root, "test-vault", "identity.dpapi"), "corrupt"u8.ToArray()); Fails(() => vault.Read("identity"));
                    foreach (var role in Protocol.Roles) { vault.Delete(role); vault.Delete(role); Check(vault.Read(role) == null); }
                }));
            }
            else Console.WriteLine("NOT RUN: Windows DPAPI / registry / executable / Edge integration (requires Windows 11 x64).");
            if (args.Length == 2 && args[0] == "--payload")
                Test("actual packaged payload extracted and verified", () => InDirectory(root =>
                { var bytes = File.ReadAllBytes(args[1]); Package.Extract(bytes, Hash(bytes), Path.Combine(root, "payload")); }));
            Console.WriteLine($"{passed} checks passed."); return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("FAIL " + error); return 1; }
    }
}
