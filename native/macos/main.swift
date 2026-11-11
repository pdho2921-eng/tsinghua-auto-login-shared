import Foundation
import Security
import Darwin

enum HostError: Error { case code(String) }
struct Credential: Codable, Equatable {
    let username: String
    let password: String
}
protocol Vault {
    func read(_ role: String) throws -> Credential?
    func save(_ role: String, _ value: Credential) throws
    func delete(_ role: String) throws
}
final class MemoryVault: Vault {
    var values: [String: Credential] = [:]
    func read(_ role: String) throws -> Credential? { values[role] }
    func save(_ role: String, _ value: Credential) throws { values[role] = value }
    func delete(_ role: String) throws { values.removeValue(forKey: role) }
}

final class KeychainVault: Vault {
    let suppliedKeychain: SecKeychain?
    init(_ keychain: SecKeychain? = nil) { suppliedKeychain = keychain }
    func check(_ status: OSStatus) throws {
        if status == errSecSuccess { return }
        if [errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled].contains(status) {
            throw HostError.code("keychain-locked")
        }
        throw HostError.code("storage-error")
    }
    func keychain() throws -> SecKeychain {
        if let suppliedKeychain { return suppliedKeychain }
        let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Keychains/login.keychain-db").path
        var result: SecKeychain?
        try check(SecKeychainOpen(path, &result))
        guard let result else { throw HostError.code("storage-error") }
        return result
    }
    func query(_ role: String, _ keychain: SecKeychain) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "local.tsinghua-login-shared.credentials.v1",
         kSecAttrAccount as String: role,
         kSecMatchSearchList as String: [keychain]]
    }
    func read(_ role: String) throws -> Credential? {
        var interaction = DarwinBoolean(true)
        SecKeychainGetUserInteractionAllowed(&interaction)
        SecKeychainSetUserInteractionAllowed(false)
        defer { SecKeychainSetUserInteractionAllowed(interaction.boolValue) }
        var q = query(role, try keychain())
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let data = result as? Data, let item = try? JSONDecoder().decode(Credential.self, from: data) else {
            throw HostError.code("storage-error")
        }
        return item
    }
    func save(_ role: String, _ value: Credential) throws {
        let kc = try keychain()
        var trusted: SecTrustedApplication?
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
        try check(SecTrustedApplicationCreateFromPath(executable, &trusted))
        guard let trusted else { throw HostError.code("storage-error") }
        var access: SecAccess?
        try check(SecAccessCreate("清华网站自动重登 · 共享试用版" as CFString, [trusted] as CFArray, &access))
        guard let access else { throw HostError.code("storage-error") }
        let values: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value)]
        let q = query(role, kc)
        let status = SecItemUpdate(q as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var add = q.merging(values) { _, new in new }
            add.removeValue(forKey: kSecMatchSearchList as String)
            add[kSecUseKeychain as String] = kc
            add[kSecAttrAccess as String] = access
            add[kSecAttrLabel as String] = role == "mail" ? "清华共享助手 · 学生邮箱" : "清华共享助手 · 身份认证"
            try check(SecItemAdd(add as CFDictionary, nil))
        } else { try check(status) }
    }
    func delete(_ role: String) throws {
        let status = SecItemDelete(query(role, try keychain()) as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }
}

func response(_ request: [String: Any], vault: Vault) -> [String: Any] {
    func reply(_ body: [String: Any]) -> [String: Any] {
        body.merging(["protocol": BuildInfo.protocolVersion]) { _, new in new }
    }
    guard let version = request["protocol"] as? Int, version == BuildInfo.protocolVersion else {
        return reply(["ok": false, "error": "protocol-mismatch"])
    }
    guard let op = request["op"] as? String else { return reply(["ok": false, "error": "invalid-request"]) }
    do {
        if op == "status" {
            guard Set(request.keys).isSubset(of: ["protocol", "op"]) else { throw HostError.code("invalid-request") }
            var accounts: [String: Any] = [:]
            for role in ["identity", "mail"] {
                if let value = try vault.read(role) { accounts[role] = ["username": value.username, "configured": true] }
                else { accounts[role] = ["username": "", "configured": false] }
            }
            return reply(["ok": true, "version": BuildInfo.version, "accounts": accounts])
        }
        guard let role = request["role"] as? String, ["identity", "mail"].contains(role) else { throw HostError.code("invalid-request") }
        let allowed: Set<String> = op == "save" ? ["protocol", "op", "role", "username", "password"] : ["protocol", "op", "role"]
        guard Set(request.keys).isSubset(of: allowed) else { throw HostError.code("invalid-request") }
        switch op {
        case "get":
            guard let value = try vault.read(role) else { throw HostError.code("not-found") }
            return reply(["ok": true, "username": value.username, "password": value.password])
        case "save":
            guard let username = request["username"] as? String, let password = request["password"] as? String,
                  !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, username.count <= 160,
                  !password.isEmpty, password.count <= 4096,
                  !username.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
                throw HostError.code("invalid-request")
            }
            try vault.save(role, Credential(username: username.trimmingCharacters(in: .whitespacesAndNewlines), password: password))
            return reply(["ok": true])
        case "delete":
            try vault.delete(role)
            return reply(["ok": true])
        default: throw HostError.code("invalid-request")
        }
    } catch HostError.code(let code) { return reply(["ok": false, "error": code]) }
    catch { return reply(["ok": false, "error": "storage-error"]) }
}

// A bounded, exact-length reader handles split pipe writes and rejects partial messages.
func readExact(_ count: Int, from input: FileHandle) throws -> Data? {
    var data = Data()
    while data.count < count {
        guard let chunk = try input.read(upToCount: count - data.count), !chunk.isEmpty else {
            if data.isEmpty { return nil }
            throw HostError.code("invalid-request")
        }
        data.append(chunk)
    }
    return data
}
func serve(vault: Vault) throws {
    guard let header = try readExact(4, from: .standardInput) else { return }
    let bytes = [UInt8](header)
    let size = Int(bytes[0]) | Int(bytes[1]) << 8 | Int(bytes[2]) << 16 | Int(bytes[3]) << 24
    guard size > 0, size <= 65_536, let body = try readExact(size, from: .standardInput),
          let request = try JSONSerialization.jsonObject(with: body) as? [String: Any] else { throw HostError.code("invalid-request") }
    let result = response(request, vault: vault)
    let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    var length = UInt32(output.count).littleEndian
    try withUnsafeBytes(of: &length) { try FileHandle.standardOutput.write(contentsOf: Data($0)) }
    try FileHandle.standardOutput.write(contentsOf: output)
}

let fm = FileManager.default
let appFolder = "Library/Application Support/TsinghuaAutoLoginShared"
let browsers = ["Google/Chrome", "Microsoft Edge"]
func appDirectory(_ home: URL) -> URL { home.appendingPathComponent(appFolder) }
func manifestURL(_ home: URL, _ browser: String) -> URL {
    home.appendingPathComponent("Library/Application Support/\(browser)/NativeMessagingHosts/\(BuildInfo.host).json")
}
func writeJSON(_ object: Any, to path: URL) throws {
    try fm.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]).write(to: path, options: .atomic)
}
func replaceItem(_ source: URL, _ target: URL) throws {
    let staging = target.deletingLastPathComponent().appendingPathComponent(".staging-" + UUID().uuidString)
    let backup = target.deletingLastPathComponent().appendingPathComponent(".backup-" + UUID().uuidString)
    try fm.copyItem(at: source, to: staging)
    defer { try? fm.removeItem(at: staging); try? fm.removeItem(at: backup) }
    let exists = fm.fileExists(atPath: target.path)
    if exists { try fm.moveItem(at: target, to: backup) }
    do { try fm.moveItem(at: staging, to: target) }
    catch {
        if exists { try? fm.moveItem(at: backup, to: target) }
        throw error
    }
}
func install(package: URL, home: URL) throws {
    let sourceExtension = package.appendingPathComponent("extension")
    let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: sourceExtension.appendingPathComponent("manifest.json"))) as? [String: Any]
    guard manifest?["key"] as? String == BuildInfo.publicKey, manifest?["version"] as? String == BuildInfo.version else {
        throw HostError.code("安装包中的扩展与助手不匹配，请重新解压完整安装包。")
    }
    let destination = appDirectory(home)
    try fm.createDirectory(at: destination, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try replaceItem(package.appendingPathComponent("native/host"), destination.appendingPathComponent("host"))
    try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: destination.appendingPathComponent("host").path)
    try replaceItem(sourceExtension, destination.appendingPathComponent("extension"))
    let hostManifest: [String: Any] = ["name": BuildInfo.host, "description": "清华网站自动重登共享助手",
      "path": destination.appendingPathComponent("host").path, "type": "stdio",
      "allowed_origins": ["chrome-extension://\(BuildInfo.extensionID)/"]]
    for browser in browsers { try writeJSON(hostManifest, to: manifestURL(home, browser)) }
    print("安装完成。无需设置开机启动，浏览器会按需调用助手。")
    print("打开 chrome://extensions/，开启开发者模式，选择‘加载已解压的扩展程序’。")
    print("选择以下文件夹（选择窗口中可按 Command+Shift+G 后粘贴）：")
    print(destination.appendingPathComponent("extension").path)
    print("随后在扩展设置页检查连接并保存账号密码。")
}
func uninstall(home: URL) throws {
    let destination = appDirectory(home)
    for browser in browsers {
        let path = manifestURL(home, browser)
        if fm.fileExists(atPath: path.path) {
            let item = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any]
            // Never remove a registration belonging to another application.
            guard item?["path"] as? String == destination.appendingPathComponent("host").path else {
                throw HostError.code("连接配置已被其他程序更改，已停止卸载。")
            }
        }
    }
    for browser in browsers {
        let path = manifestURL(home, browser)
        if fm.fileExists(atPath: path.path) { try fm.removeItem(at: path) }
    }
    if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
    print("本机助手已卸载。请在浏览器扩展管理页移除共享版扩展。")
    print("密码默认保留在登录钥匙串；如需删除，请在卸载前使用扩展设置页的‘删除已保存密码’。")
}
func selfTest() throws {
    let vault = MemoryVault()
    func send(_ data: [String: Any]) -> [String: Any] { response(data.merging(["protocol": 1]) { old, _ in old }, vault: vault) }
    func require(_ ok: Bool) throws { if !ok { throw HostError.code("self-test-failed") } }
    try require(send(["op": "get", "role": "identity"])["error"] as? String == "not-found")
    try require(send(["op": "save", "role": "identity", "username": "fixture-user", "password": "虚拟-test-secret"])["ok"] as? Bool == true)
    try require(send(["op": "get", "role": "identity"])["password"] as? String == "虚拟-test-secret")
    let status = try JSONSerialization.data(withJSONObject: send(["op": "status"]))
    try require(!String(decoding: status, as: UTF8.self).contains("虚拟-test-secret"))
    try require(send(["op": "get", "role": "anything"])["ok"] as? Bool == false)
    try require(send(["op": "save", "role": "mail", "username": "fixture", "password": ""])["ok"] as? Bool == false)
    try require(send(["op": "get", "role": "identity", "path": "/tmp/x"])["ok"] as? Bool == false)
    try require(send(["op": "delete", "role": "identity"])["ok"] as? Bool == true)
    try require(send(["op": "get", "role": "identity"])["error"] as? String == "not-found")
    print("Native protocol self-test passed (memory-only).")
}

func keychainSelfTest() throws {
    SecKeychainSetUserInteractionAllowed(false)
    defer { SecKeychainSetUserInteractionAllowed(true) }
    func step(_ value: String) { FileHandle.standardError.write(Data(("Keychain test: " + value + "\n").utf8)) }
    let folder = fm.temporaryDirectory.appendingPathComponent("thu-shared-keychain-" + UUID().uuidString)
    try fm.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? fm.removeItem(at: folder) }
    let path = folder.appendingPathComponent("fixture.keychain-db").path
    let master = UUID().uuidString
    var kc: SecKeychain?
    let checker = KeychainVault()
    step("create temporary keychain")
    try master.withCString { password in
        try checker.check(SecKeychainCreate(path, UInt32(master.utf8.count), password, false, nil, &kc))
    }
    guard let kc else { throw HostError.code("keychain-test-create-failed") }
    defer { SecKeychainDelete(kc) }
    let vault = KeychainVault(kc)
    let original = Credential(username: "fixture-user", password: "synthetic-only-密码")
    step("save")
    try vault.save("identity", original)
    step("read")
    guard try vault.read("identity") == original else { throw HostError.code("keychain-test-read-failed") }
    let changed = Credential(username: "fixture-user-2", password: "synthetic-updated")
    step("update")
    try vault.save("identity", changed)
    guard try vault.read("identity") == changed else { throw HostError.code("keychain-test-update-failed") }
    try vault.save("mail", original)
    step("delete identity and preserve mail")
    try vault.delete("identity")
    guard try vault.read("identity") == nil, try vault.read("mail") == original else { throw HostError.code("keychain-test-separation-failed") }
    try checker.check(SecKeychainLock(kc))
    step("locked read")
    var blocked = false
    do { _ = try vault.read("mail") } catch HostError.code("keychain-locked") { blocked = true }
    guard blocked else { throw HostError.code("keychain-test-lock-failed") }
    try master.withCString { password in try checker.check(SecKeychainUnlock(kc, UInt32(master.utf8.count), password, true)) }
    try vault.delete("mail")
    guard try vault.read("mail") == nil else { throw HostError.code("keychain-test-delete-failed") }
    print("Keychain save/read/update/separation/lock/delete passed in a disposable keychain.")
}

// Native messages can never select a path, run a command or access another credential service.
let args = Array(CommandLine.arguments.dropFirst())
do {
    if args == ["--self-test"] { try selfTest() }
    else if args == ["--test-keychain"] { try keychainSelfTest() }
    else if args == ["--version"] { print(BuildInfo.version) }
    else if args.count == 2 && args[0] == "--install" {
        try install(package: URL(fileURLWithPath: args[1]), home: fm.homeDirectoryForCurrentUser)
    } else if args == ["--uninstall"] {
        try uninstall(home: fm.homeDirectoryForCurrentUser)
    } else if args.count == 3 && args[0] == "--test-install" {
        try install(package: URL(fileURLWithPath: args[2]), home: URL(fileURLWithPath: args[1]))
    } else if args.count == 2 && args[0] == "--test-uninstall" {
        try uninstall(home: URL(fileURLWithPath: args[1]))
    } else if args == ["--test-protocol"] { try serve(vault: MemoryVault()) }
    else if args == ["chrome-extension://\(BuildInfo.extensionID)/"] { try serve(vault: KeychainVault()) }
    else { throw HostError.code("untrusted-origin") }
} catch {
    // Neither native request data nor OS diagnostic objects are printed.
    if args.first?.hasPrefix("--") == true {
        let message: String
        if case HostError.code(let code) = error { message = code } else { message = "操作未完成，请检查安装文件及目录权限。" }
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
    exit(1)
}
