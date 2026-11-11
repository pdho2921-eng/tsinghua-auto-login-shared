#!/usr/bin/env python3
"""Developer-only build. Recipients use the bundled binary, never this script."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build'
DIST = ROOT / 'dist'
config = json.loads((ROOT / 'native/config.json').read_text())
manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
BUILD.mkdir(exist_ok=True)
DIST.mkdir(exist_ok=True)

def run(*args):
    subprocess.run(args, check=True, cwd=ROOT)

constants = BUILD / 'BuildInfo.swift'
constants.write_text('enum BuildInfo {\n' + '\n'.join(
    f'    static let {name} = {json.dumps(value)}' for name, value in {
        'host': config['host'], 'extensionID': config['extensionId'],
        'protocolVersion': config['protocol'], 'version': config['version'],
        'publicKey': manifest['key']}.items()) + '\n}\n')
for arch in ['arm64', 'x86_64']:
    run('/usr/bin/swiftc', '-O', '-target', f'{arch}-apple-macos11.0',
        '-module-cache-path', str(BUILD / 'module-cache'), '-framework', 'Security',
        str(constants), str(ROOT / 'native/macos/main.swift'), '-o', str(BUILD / f'host-{arch}'))
run('/usr/bin/lipo', '-create', str(BUILD / 'host-arm64'), str(BUILD / 'host-x86_64'), '-output', str(BUILD / 'host'))
run('/usr/bin/codesign', '--force', '--sign', '-', '--identifier', 'local.tsinghua-login-shared.host', str(BUILD / 'host'))
run('/usr/bin/codesign', '--verify', '--strict', str(BUILD / 'host'))
run(str(BUILD / 'host'), '--self-test')

with tempfile.TemporaryDirectory(prefix='package-', dir=BUILD) as temp:
    package = Path(temp) / '清华网站自动重登-共享试用版'
    package.mkdir()
    shutil.copytree(ROOT / 'extension', package / 'extension')
    (package / 'native').mkdir()
    shutil.copy2(BUILD / 'host', package / 'native/host')
    for name in ['安装.command', '卸载.command', '开始使用.html']:
        shutil.copy2(ROOT / name, package / name)
    for name in ['README.md', 'PRIVACY.md']:
        shutil.copy2(ROOT / name, package / name)
    (package / 'docs').mkdir()
    for name in ['DEVELOPMENT.md', 'VALIDATION.md', '界面检查清单.md']:
        shutil.copy2(ROOT / 'docs' / name, package / 'docs' / name)
    archive = DIST / 'tsinghua-auto-login-shared-macos.zip'
    # Explicit UTF-8 filenames and POSIX mode bits, without Finder resource forks.
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        for item in sorted(package.rglob('*')):
            if item.is_file():
                output.write(item, str(item.relative_to(package.parent)))
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(DIST / 'SHA256SUMS.txt').write_text(f'{digest}  {archive.name}\n')
print(f'Built {archive} ({archive.stat().st_size:,} bytes)')
