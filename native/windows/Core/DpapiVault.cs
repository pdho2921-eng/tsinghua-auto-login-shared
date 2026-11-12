using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

namespace Tsinghua;

[SupportedOSPlatform("windows")]
public static class PrivateFiles
{
    public static string LocalRoot => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    public static void RejectLinks(string path)
    {
        // A dangling link also has attributes. Check each existing ancestor before mutations.
        for (var cursor = new DirectoryInfo(Path.GetFullPath(path)); cursor != null; cursor = cursor.Parent)
        {
            try
            {
                if ((File.GetAttributes(cursor.FullName) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Reparse points are not supported.");
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }
    public static void CreateDirectory(string path)
    {
        RejectLinks(path);
        using var user = WindowsIdentity.GetCurrent();
        var sid = user.User ?? throw new IOException("No current user.");
        var acl = new DirectorySecurity();
        acl.SetOwner(sid); acl.SetAccessRuleProtection(true, false);
        foreach (var identity in new[] { sid, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
            acl.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        var directory = new DirectoryInfo(path);
        if (!directory.Exists) directory.Create(acl);
        else directory.SetAccessControl(acl);
    }
    public static void RestrictFile(string path)
    {
        RejectLinks(path);
        using var user = WindowsIdentity.GetCurrent();
        var sid = user.User ?? throw new IOException("No current user.");
        var acl = new FileSecurity(); acl.SetOwner(sid); acl.SetAccessRuleProtection(true, false);
        foreach (var identity in new[] { sid, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
            acl.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, AccessControlType.Allow));
        new FileInfo(path).SetAccessControl(acl);
    }
}

[SupportedOSPlatform("windows")]
public sealed class DpapiVault : IVault
{
    // Outside the replaceable installation directory: upgrades/uninstalls preserve credentials.
    readonly string directory;
    public DpapiVault() : this(Path.Combine(PrivateFiles.LocalRoot, "TsinghuaAutoLoginShared.Credentials.v1")) { }
    // Test code uses a fresh temporary directory, never a real user's saved credentials.
    public DpapiVault(string isolatedDirectory) { directory = Path.GetFullPath(isolatedDirectory); }
    string PathFor(string role)
    {
        if (!Protocol.Roles.Contains(role, StringComparer.Ordinal)) throw new HostFailure("invalid-request");
        return Path.Combine(directory, role + ".dpapi");
    }
    T Locked<T>(Func<T> action)
    {
        try
        {
            var name = "Local\\TsinghuaLoginVault-" + Convert.ToHexString(SHA256.HashData(Protocol.StrictUtf8.GetBytes(directory)));
            using var mutex = new Mutex(false, name); bool held = false;
            try
            {
                try { held = mutex.WaitOne(TimeSpan.FromSeconds(3)); } catch (AbandonedMutexException) { held = true; }
                if (!held) throw new IOException("Vault busy.");
                PrivateFiles.CreateDirectory(directory);
                return action();
            }
            finally { if (held) mutex.ReleaseMutex(); }
        }
        catch (HostFailure) { throw; }
        catch { throw new HostFailure("storage-error"); }
    }
    public Credential? Read(string role) => Locked<Credential?>(() =>
    {
        var path = PathFor(role); PrivateFiles.RejectLinks(path);
        if (!File.Exists(path)) return null;
        PrivateFiles.RestrictFile(path);
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (file.Length is <= 0 or > 262_144) throw new IOException("Invalid vault size.");
        byte[] encrypted = new byte[file.Length]; file.ReadExactly(encrypted);
        byte[] plain = Transform(encrypted, false);
        try
        {
            using var json = JsonDocument.Parse(plain);
            var root = json.RootElement;
            if (root.GetProperty("role").GetString() != role || root.GetProperty("format").GetInt32() != 1)
                throw new IOException("Invalid vault role.");
            var username = root.GetProperty("username").GetString()!;
            var password = root.GetProperty("password").GetString()!;
            if (Protocol.ValidateUsername(username) != username) throw new IOException("Invalid username.");
            Protocol.ValidatePassword(password);
            return new Credential(username, password);
        }
        finally { CryptographicOperations.ZeroMemory(plain); }
    });
    public void Save(string role, Credential value) => Locked(() =>
    {
        var path = PathFor(role); PrivateFiles.RejectLinks(path);
        var username = Protocol.ValidateUsername(value.Username); Protocol.ValidatePassword(value.Password);
        var plain = Protocol.Json(w =>
        {
            w.WriteStartObject(); w.WriteNumber("format", 1); w.WriteString("role", role);
            w.WriteString("username", username); w.WriteString("password", value.Password); w.WriteEndObject();
        });
        byte[] encrypted;
        try { encrypted = Transform(plain, true); } finally { CryptographicOperations.ZeroMemory(plain); }
        var temporary = Path.Combine(directory, ".write-" + Guid.NewGuid().ToString("N"));
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { file.Write(encrypted); file.Flush(true); }
            PrivateFiles.RestrictFile(temporary);
            // Same-volume atomic replacement. No plaintext is ever written to disk.
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        return true;
    });
    public void Delete(string role) => Locked(() =>
    {
        var path = PathFor(role); PrivateFiles.RejectLinks(path); File.Delete(path); return true;
    });

    [StructLayout(LayoutKind.Sequential)] struct Blob { public int Size; public nint Data; }
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CryptProtectData(ref Blob input, string? description, nint entropy, nint reserved, nint prompt, uint flags, out Blob output);
    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CryptUnprotectData(ref Blob input, nint description, nint entropy, nint reserved, nint prompt, uint flags, out Blob output);
    [DllImport("kernel32.dll")] static extern nint LocalFree(nint memory);

    static byte[] Transform(byte[] bytes, bool encrypt)
    {
        var pin = GCHandle.Alloc(bytes, GCHandleType.Pinned); Blob output = default;
        try
        {
            var input = new Blob { Size = bytes.Length, Data = pin.AddrOfPinnedObject() };
            // CRYPTPROTECT_UI_FORBIDDEN only. Never CRYPTPROTECT_LOCAL_MACHINE.
            bool ok = encrypt ? CryptProtectData(ref input, null, 0, 0, 0, 1, out output)
                : CryptUnprotectData(ref input, 0, 0, 0, 0, 1, out output);
            if (!ok || output.Size is <= 0 or > 262_144) throw new CryptographicException("Windows data protection failed.");
            byte[] result = new byte[output.Size]; Marshal.Copy(output.Data, result, 0, output.Size); return result;
        }
        finally
        {
            if (output.Data != 0)
            {
                // Clear native plaintext on decrypt before freeing Windows' allocation.
                if (!encrypt && output.Size is > 0 and <= 262_144)
                    Marshal.Copy(new byte[output.Size], 0, output.Data, output.Size);
                LocalFree(output.Data);
            }
            pin.Free();
        }
    }
}
