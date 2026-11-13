#!/usr/bin/env python3
"""Developer-only build. Recipients use the bundled binary, never this script."""
from pathlib import Path
import hashlib
import base64
import os
import sys
import json
import shutil
import subprocess
import tempfile
import zipfile
from package_shared import prepare_extension, privacy, update_checksums, copy_notices, package_notices

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build'
DIST = ROOT / 'dist'
config = json.loads((ROOT / 'native/config.json').read_text())
manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
BUILD.mkdir(exist_ok=True)
extension_source = BUILD / 'macos-extension'
extension_hashes = prepare_extension(extension_source, 'macos')
for item in sorted(extension_source.rglob('*')):
    if item.is_symlink():
        raise ValueError('Extension package must not contain symbolic links')
    if item.is_file() and item.name != '.DS_Store':
        extension_hashes[str(item.relative_to(extension_source))] = hashlib.sha256(item.read_bytes()).hexdigest()
identity_hash = hashlib.sha256(base64.b64decode(manifest['key'], validate=True)).hexdigest()[:32]
identity = ''.join(chr(97 + int(digit, 16)) for digit in identity_hash)
if identity != config['extensionId']:
    raise ValueError('Extension public key and allowed native origin disagree')
BUILD.mkdir(exist_ok=True)
DIST.mkdir(exist_ok=True)

def run(*args):
    subprocess.run(args, check=True, cwd=ROOT)

constants = BUILD / 'BuildInfo.swift'
constants.write_text('enum BuildInfo {\n' + '\n'.join(
    f'    static let {name} = {json.dumps(value)}' for name, value in {
        'host': config['host'], 'extensionID': config['extensionId'],
        'protocolVersion': config['protocol'], 'version': config['version'],
        'extensionVersion': manifest['version'],
        'publicKey': manifest['key']}.items()) + '\n    static let extensionHashes: [String: String] = [\n' + ',\n'.join(
        f'        {json.dumps(name)}: {json.dumps(digest)}' for name, digest in extension_hashes.items()) + '\n    ]\n}\n')
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
    shutil.copytree(extension_source, package / 'extension', ignore=shutil.ignore_patterns('.DS_Store'))
    (package / 'native').mkdir()
    shutil.copy2(BUILD / 'host', package / 'native/host')
    for name in ['安装.command', '卸载.command', '开始使用.html']:
        shutil.copy2(ROOT / name, package / name)
    shutil.copy2(ROOT / 'docs/MACOS.md', package / 'README.md')
    (package / 'PRIVACY.md').write_text(privacy('macos'))
    copy_notices(package, 'macos')
    archive = Path(temp) / 'tsinghua-auto-login-shared-macos.zip'
    # Explicit UTF-8 filenames and POSIX mode bits, without Finder resource forks.
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        for item in sorted(package.rglob('*')):
            if item.is_file():
                output.write(item, str(item.relative_to(package.parent)))
    with zipfile.ZipFile(archive) as check:
        if check.testzip() is not None or any(n.endswith(('.exe', '.cs', '.ps1')) or 'HANDOFF_WINDOWS' in n for n in check.namelist()):
            raise ValueError('Invalid or mixed-platform Mac package')
        for name, contents in package_notices('macos').items():
            if check.read(f'{package.name}/{name}') != contents:
                raise ValueError('Missing or changed Mac notice: ' + name)
    # Test the bytes recipients receive, including uninstall and reinstall, before publishing.
    environment = dict(os.environ, THU_TEST_HOST=str(BUILD / 'host'), THU_TEST_ARCHIVE=str(archive))
    subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'native_test.py', '-v'],
                   check=True, cwd=ROOT, env=environment)
    final_archive = DIST / archive.name
    os.replace(archive, final_archive)
archive = final_archive
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
update_checksums(DIST)
print(f'Built {archive} ({archive.stat().st_size:,} bytes)')
