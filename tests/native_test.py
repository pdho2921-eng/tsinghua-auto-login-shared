"""Run after scripts/build.py. Only temporary homes and in-memory credentials are used."""
from pathlib import Path
import json
import struct
import hashlib
import os
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
HOST = Path(os.environ.get('THU_TEST_HOST', ROOT / 'build/host'))
ARCHIVE = Path(os.environ.get('THU_TEST_ARCHIVE', ROOT / 'dist/tsinghua-auto-login-shared-macos.zip'))
CONFIG = json.loads((ROOT / 'native/config.json').read_text())

def invoke(payload, origin='--test-protocol'):
    body = json.dumps(payload, ensure_ascii=False).encode()
    return subprocess.run([HOST, origin], input=struct.pack('<I', len(body)) + body, capture_output=True)

def decode(result):
    assert result.returncode == 0, result.stderr
    size, = struct.unpack('<I', result.stdout[:4])
    assert len(result.stdout) == size + 4
    return json.loads(result.stdout[4:])

class NativeTests(unittest.TestCase):
    def test_release_versions_and_executable_modes(self):
        with zipfile.ZipFile(ARCHIVE) as z:
            prefix = '清华网站自动重登-共享试用版/'
            manifest = json.loads(z.read(prefix + 'extension/manifest.json'))
            self.assertIn(('扩展版本 ' + manifest['version']).encode(), z.read(prefix + 'extension/options.html'))
            for name in ['native/host', '安装.command', '卸载.command']:
                self.assertTrue((z.getinfo(prefix + name).external_attr >> 16) & 0o100)
            self.assertEqual(z.read(prefix + 'native/host'), HOST.read_bytes())
        version = subprocess.check_output([HOST, '--version'], text=True).strip()
        self.assertEqual(version, CONFIG['version'])

    def test_memory_store_lifecycle(self):
        r = subprocess.run([HOST, '--self-test'], capture_output=True)
        self.assertEqual(r.returncode, 0)
        self.assertNotIn(b'test-secret', r.stdout + r.stderr)

    def test_valid_status_has_no_secrets(self):
        r = decode(invoke({'protocol': 1, 'op': 'status'}))
        self.assertTrue(r['ok'])
        self.assertEqual(set(r['accounts']), {'identity', 'mail'})
        self.assertNotIn('password', json.dumps(r))

    def test_disallowed_origin_exits_without_response(self):
        r = invoke({'protocol': 1, 'op': 'status'}, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/')
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(r.stdout, b'')
        self.assertEqual(r.stderr, b'')

    def test_version_unknown_operations_and_path_injection(self):
        for request in [{'protocol': 2, 'op': 'status'}, {'protocol': 1, 'op': 'exec'},
                        {'protocol': 1, 'op': 'get', 'role': 'identity', 'path': '/etc/passwd'},
                        {'protocol': 1, 'op': 'get', 'role': '../other'},
                        {'protocol': 1, 'op': 'save', 'role': 'identity', 'username': 'u', 'password': ''}]:
            with self.subTest(request=request):
                self.assertFalse(decode(invoke(request))['ok'])

    def test_oversized_truncated_and_invalid_frames(self):
        for data in [struct.pack('<I', 65537), b'\x01\x00', struct.pack('<I', 10)+b'{}',
                     struct.pack('<I', 1)+b'{', struct.pack('<I', 2)+b'[]', struct.pack('<I', 0)]:
            r = subprocess.run([HOST, '--test-protocol'], input=data, capture_output=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertEqual(r.stdout, b'')

    def test_split_pipe_writes(self):
        p = subprocess.Popen([HOST, '--test-protocol'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        body = json.dumps({'protocol': 1, 'op': 'status'}).encode()
        frame = struct.pack('<I', len(body)) + body
        for byte in frame:
            p.stdin.write(bytes([byte])); p.stdin.flush()
        p.stdin.close()
        output = p.stdout.read(); errors = p.stderr.read(); p.wait(timeout=5)
        p.stdout.close(); p.stderr.close()
        self.assertEqual(p.returncode, 0, errors)
        self.assertTrue(json.loads(output[4:])['ok'])

    def test_install_upgrade_uninstall_with_unicode_and_spaces(self):
        with tempfile.TemporaryDirectory(prefix='thu-shared-') as temp:
            temp = Path(temp)
            with zipfile.ZipFile(ARCHIVE) as z:
                z.extractall(temp / '解压 文件夹')
            package = temp / '解压 文件夹/清华网站自动重登-共享试用版'
            home = temp / '测试 用户'
            personal = home / 'Library/Application Support/TsinghuaLearnLogin/do-not-touch.txt'
            personal.parent.mkdir(parents=True); personal.write_text('personal fixture')
            install = home / 'Library/Application Support/TsinghuaAutoLoginShared'
            packaged_host = package / 'native/host'
            packaged_host.chmod(0o755)
            for _ in range(2):
                r = subprocess.run([packaged_host, '--test-install', home, package], capture_output=True)
                self.assertEqual(r.returncode, 0, r.stderr.decode())
                self.assertEqual((install / 'host').read_bytes(), HOST.read_bytes())
                for browser in ['Google/Chrome', 'Microsoft Edge']:
                    path = home / f'Library/Application Support/{browser}/NativeMessagingHosts/{CONFIG["host"]}.json'
                    registration = json.loads(path.read_text())
                    self.assertEqual(registration['path'], str(install / 'host'))
                    self.assertEqual(registration['allowed_origins'], [f'chrome-extension://{CONFIG["extensionId"]}/'])
            subprocess.run([HOST, '--test-uninstall', home], check=True, capture_output=True)
            self.assertFalse(install.exists())
            r = subprocess.run([packaged_host, '--test-install', home, package], capture_output=True)
            self.assertEqual(r.returncode, 0, r.stderr.decode())
            subprocess.run([packaged_host, '--test-uninstall', home], check=True, capture_output=True)
            subprocess.run([packaged_host, '--test-uninstall', home], check=True, capture_output=True)
            self.assertEqual(personal.read_text(), 'personal fixture')
            self.assertEqual(list(home.rglob(f'{CONFIG["host"]}.json')), [])

    def unpack(self, root):
        with zipfile.ZipFile(ARCHIVE) as z:
            z.extractall(root)
        package = root / '清华网站自动重登-共享试用版'
        (package / 'native/host').chmod(0o755)
        return package

    def test_upgrade_older_extension_while_old_host_and_file_are_open(self):
        with tempfile.TemporaryDirectory(prefix='thu-upgrade-') as temp:
            root = Path(temp); package = self.unpack(root / 'package'); home = root / 'home'
            subprocess.run([HOST, '--test-install', home, package], check=True, capture_output=True)
            install = home / 'Library/Application Support/TsinghuaAutoLoginShared'
            manifest = install / 'extension/manifest.json'
            old = json.loads(manifest.read_text()); old['version'] = '0.1.6'; manifest.write_text(json.dumps(old))
            (install / 'extension/obsolete.js').write_text('old file')
            settings = home / 'Library/Application Support/Google/Chrome/test-settings'
            settings.write_text('automatic=false')
            vault = home / 'Library/Keychains/fixture-keychain'; vault.parent.mkdir(parents=True)
            vault.write_bytes(b'untouched encrypted fixture')
            running = subprocess.Popen([install / 'host', '--test-protocol'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                with manifest.open('rb') as held:
                    result = subprocess.run([HOST, '--test-install', home, package], capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    self.assertEqual(json.load(held)['version'], '0.1.6')
                self.assertIsNone(running.poll())
                body = json.dumps({'protocol': 1, 'op': 'status'}).encode()
                response, errors = running.communicate(struct.pack('<I', len(body)) + body, timeout=5)
                self.assertEqual(running.returncode, 0, errors)
                self.assertTrue(json.loads(response[4:])['ok'])
                self.assertEqual(json.loads(manifest.read_text())['version'], json.loads((package / 'extension/manifest.json').read_text())['version'])
                self.assertFalse((install / 'extension/obsolete.js').exists())
                self.assertEqual(settings.read_text(), 'automatic=false')
                self.assertEqual(vault.read_bytes(), b'untouched encrypted fixture')
            finally:
                if running.poll() is None: running.kill(); running.communicate()

    def snapshot(self, home):
        return {str(p.relative_to(home)): hashlib.sha256(p.read_bytes()).hexdigest() for p in home.rglob('*') if p.is_file()}

    def test_incomplete_or_changed_package_preserves_installation(self):
        for change in ['missing-content', 'changed-script', 'wrong-host', 'symlink']:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); package = self.unpack(root / 'package'); home = root / 'home'
                subprocess.run([HOST, '--test-install', home, package], check=True, capture_output=True)
                before = self.snapshot(home)
                script = package / 'extension/content.js'
                if change == 'missing-content': script.unlink()
                elif change == 'changed-script': script.write_text('changed')
                elif change == 'wrong-host': (package / 'native/host').write_bytes(b'not the helper')
                else:
                    outside = root / 'outside.js'; outside.write_bytes(script.read_bytes())
                    script.unlink(); script.symlink_to(outside)
                result = subprocess.run([HOST, '--test-install', home, package], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.snapshot(home), before)

    def test_failed_registration_rolls_back_complete_update(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); package = self.unpack(root / 'package'); home = root / 'home'
            subprocess.run([HOST, '--test-install', home, package], check=True, capture_output=True)
            install = home / 'Library/Application Support/TsinghuaAutoLoginShared'
            (install / 'extension/old-marker').write_text('must survive failed update')
            edge = home / 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'
            before = self.snapshot(home)
            edge.chmod(0o500)
            try:
                result = subprocess.run([HOST, '--test-install', home, package], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.snapshot(home), before)
            finally: edge.chmod(0o700)
            self.assertEqual(list(install.parent.glob('.install-*')), [])

    def test_foreign_registration_is_not_overwritten_or_uninstalled(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); package = self.unpack(root / 'package'); home = root / 'home'
            foreign = home / f'Library/Application Support/Microsoft Edge/NativeMessagingHosts/{CONFIG["host"]}.json'
            foreign.parent.mkdir(parents=True); foreign.write_text('{"path":"/other/application"}')
            before = self.snapshot(home)
            for args in [['--test-install', home, package], ['--test-uninstall', home]]:
                result = subprocess.run([HOST, *args], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.snapshot(home), before)

    def test_mismatched_package_does_not_install(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'package/extension').mkdir(parents=True)
            (root / 'package/extension/manifest.json').write_text('{"key":"wrong","version":"0.1.0"}')
            r = subprocess.run([HOST, '--test-install', root / 'home', root / 'package'], capture_output=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertFalse((root / 'home').exists())

if __name__ == '__main__':
    unittest.main()
