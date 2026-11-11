"""Run after scripts/build.py. Only temporary homes and in-memory credentials are used."""
from pathlib import Path
import json
import struct
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
HOST = ROOT / 'build/host'
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
            with zipfile.ZipFile(ROOT / 'dist/tsinghua-auto-login-shared-macos.zip') as z:
                z.extractall(temp / '解压 文件夹')
            package = temp / '解压 文件夹/清华网站自动重登-共享试用版'
            home = temp / '测试 用户'
            personal = home / 'Library/Application Support/TsinghuaLearnLogin/do-not-touch.txt'
            personal.parent.mkdir(parents=True); personal.write_text('personal fixture')
            install = home / 'Library/Application Support/TsinghuaAutoLoginShared'
            for _ in range(2):
                subprocess.run([HOST, '--test-install', home, package], check=True, capture_output=True)
                self.assertEqual((install / 'host').read_bytes(), HOST.read_bytes())
                for browser in ['Google/Chrome', 'Microsoft Edge']:
                    path = home / f'Library/Application Support/{browser}/NativeMessagingHosts/{CONFIG["host"]}.json'
                    registration = json.loads(path.read_text())
                    self.assertEqual(registration['path'], str(install / 'host'))
                    self.assertEqual(registration['allowed_origins'], [f'chrome-extension://{CONFIG["extensionId"]}/'])
            subprocess.run([HOST, '--test-uninstall', home], check=True, capture_output=True)
            self.assertFalse(install.exists())
            self.assertEqual(personal.read_text(), 'personal fixture')
            self.assertEqual(list(home.rglob(f'{CONFIG["host"]}.json')), [])

    def test_mismatched_package_does_not_install(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'package/extension').mkdir(parents=True)
            (root / 'package/extension/manifest.json').write_text('{"key":"wrong","version":"0.1.0"}')
            r = subprocess.run([HOST, '--test-install', root / 'home', root / 'package'], capture_output=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertFalse((root / 'home').exists())

if __name__ == '__main__':
    unittest.main()
