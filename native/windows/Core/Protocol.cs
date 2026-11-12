using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Tsinghua;

public sealed record Credential(string Username, string Password);
public interface IVault
{
    Credential? Read(string role);
    void Save(string role, Credential value);
    void Delete(string role);
}
public sealed class HostFailure(string code) : Exception(code)
{
    public string Code { get; } = code;
}

public static class Protocol
{
    public const int MaxRequestBytes = 65_536;
    public static readonly string[] Roles = ["identity", "mail"];
    public static readonly UTF8Encoding StrictUtf8 = new(false, true);
    public static bool ValidArguments(string[] args) =>
        args.Length is 1 or 2 && args[0] == BuildInfo.Origin &&
        (args.Length == 1 || (args[1].StartsWith("--parent-window=", StringComparison.Ordinal) &&
          args[1][16..] is { Length: > 0 and <= 20 } handle &&
          handle.All(c => c is >= '0' and <= '9') && ulong.TryParse(handle, out _)));

    public static byte[] Json(Action<Utf8JsonWriter> write)
    {
        using var memory = new MemoryStream();
        using (var writer = new Utf8JsonWriter(memory)) write(writer);
        return memory.ToArray();
    }
    public static byte[] Error(string code) => Reply(w => w.WriteString("error", code), false);
    static byte[] Reply(Action<Utf8JsonWriter>? body = null, bool ok = true) => Json(w =>
    {
        w.WriteStartObject(); w.WriteNumber("protocol", BuildInfo.Protocol);
        w.WriteBoolean("ok", ok); body?.Invoke(w); w.WriteEndObject();
    });

    public static string ValidateUsername(string username)
    {
        username = username.Trim();
        if (username.Length == 0 || StringInfo.ParseCombiningCharacters(username).Length > 160 ||
            username.EnumerateRunes().Any(r => Rune.GetUnicodeCategory(r) is UnicodeCategory.Control or UnicodeCategory.Format))
            throw new HostFailure("invalid-request");
        return username;
    }
    public static void ValidatePassword(string password)
    {
        if (password.Length == 0 || StringInfo.ParseCombiningCharacters(password).Length > 4096)
            throw new HostFailure("invalid-request");
    }
    public static byte[] Handle(ReadOnlyMemory<byte> bytes, IVault vault)
    {
        try
        {
            if (bytes.Length is 0 or > MaxRequestBytes) return Error("invalid-request");
            _ = StrictUtf8.GetCharCount(bytes.Span);
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return Error("invalid-request");
            var keys = root.EnumerateObject().Select(p => p.Name).ToArray();
            if (keys.Distinct(StringComparer.Ordinal).Count() != keys.Length) return Error("invalid-request");
            if (!root.TryGetProperty("protocol", out var version) || version.ValueKind != JsonValueKind.Number ||
                !version.TryGetInt32(out int number) || number != BuildInfo.Protocol) return Error("protocol-mismatch");
            string Text(string key) => root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()! : throw new HostFailure("invalid-request");
            var op = Text("op");
            string[] expected = op switch
            {
                "status" => ["protocol", "op"],
                "save" => ["protocol", "op", "role", "username", "password"],
                "get" or "delete" => ["protocol", "op", "role"],
                _ => throw new HostFailure("invalid-request")
            };
            if (!keys.ToHashSet(StringComparer.Ordinal).SetEquals(expected)) return Error("invalid-request");
            if (op == "status")
            {
                var accounts = Roles.Select(role => (role, value: vault.Read(role))).ToArray();
                return Reply(w =>
                {
                    w.WriteString("version", BuildInfo.Version); w.WriteStartObject("accounts");
                    foreach (var (role, value) in accounts)
                    {
                        w.WriteStartObject(role); w.WriteBoolean("configured", value != null);
                        w.WriteString("username", value?.Username ?? ""); w.WriteEndObject();
                    }
                    w.WriteEndObject();
                });
            }
            var selectedRole = Text("role");
            if (!Roles.Contains(selectedRole, StringComparer.Ordinal)) return Error("invalid-request");
            switch (op)
            {
                case "save":
                    var username = ValidateUsername(Text("username")); var password = Text("password");
                    ValidatePassword(password); vault.Save(selectedRole, new Credential(username, password)); return Reply();
                case "delete": vault.Delete(selectedRole); return Reply();
                default:
                    var credential = vault.Read(selectedRole);
                    return credential == null ? Error("not-found") : Reply(w =>
                    { w.WriteString("username", credential.Username); w.WriteString("password", credential.Password); });
            }
        }
        catch (HostFailure error) { return Error(error.Code); }
        catch (Exception error) when (error is JsonException or ArgumentException or InvalidOperationException)
        { return Error("invalid-request"); }
        catch { return Error("storage-error"); }
    }

    public static void Serve(Stream input, Stream output, IVault vault)
    {
        byte[] reply;
        try
        {
            Span<byte> header = stackalloc byte[4];
            int first = input.ReadByte(); if (first < 0) return;
            header[0] = (byte)first; input.ReadExactly(header[1..]);
            uint size = BinaryPrimitives.ReadUInt32LittleEndian(header);
            if (size is 0 or > MaxRequestBytes) reply = Error("invalid-request");
            else
            {
                byte[] body = new byte[size];
                try { input.ReadExactly(body); reply = Handle(body, vault); }
                finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(body); }
            }
        }
        catch (Exception error) when (error is EndOfStreamException or IOException) { reply = Error("invalid-request"); }
        Span<byte> prefix = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(prefix, (uint)reply.Length);
        try { output.Write(prefix); output.Write(reply); output.Flush(); }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(reply); }
    }
}
