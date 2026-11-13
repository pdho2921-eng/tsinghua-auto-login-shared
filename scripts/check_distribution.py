#!/usr/bin/env python3
"""Inspect the final ZIPs without installing into the current user's account."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import re
import struct
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist'
COMMON = {'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHROMIUM-LICENSE.txt', 'SITE-ICON-SOURCES.md'}
DOTNET = {'DOTNET-LICENSE.txt', 'DOTNET-THIRD-PARTY-NOTICES.txt'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_archive(path, prefix=''):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        require(archive.testzip() is None, f'Corrupt ZIP: {path.name}')
        require(len(names) == len(set(names)), f'Duplicate ZIP entries: {path.name}')
        require(all(name.startswith(prefix) for name in names), f'Wrong archive root: {path.name}')
        files = {}
        for name in names:
            relative = name[len(prefix):]
            require(relative and not relative.startswith('/') and '\\' not in relative
                    and '..' not in PurePosixPath(relative).parts, f'Unsafe archive entry: {name}')
            require(not name.endswith('/'), f'Unexpected directory entry: {name}')
            files[relative] = archive.read(name)
        return files


def verify_checksums(text, files):
    expected = {}
    for line in text.splitlines():
        digest, name = line.split('  ', 1)
        require(re.fullmatch(r'[0-9a-f]{64}', digest), 'Invalid SHA-256 entry')
        require(name not in expected, 'Duplicate checksum entry')
        expected[name] = digest
    actual = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    require(expected == actual, 'Checksum list and actual files disagree')


def verify_markdown_links(files):
    for name, contents in files.items():
        if not name.endswith('.md'):
            continue
        for target in re.findall(r'\]\(([^)]+)\)', contents.decode('utf-8')):
            if re.match(r'[a-zA-Z][a-zA-Z0-9+.-]*:', target) or target.startswith('#'):
                continue
            target = target.split('#', 1)[0]
            relative = str(PurePosixPath(name).parent / target)
            require(relative in files, f'Broken package link: {name} -> {target}')


def verify_notices(files, platform):
    expected = {
        'LICENSE': ROOT / 'LICENSE',
        'CHROMIUM-LICENSE.txt': ROOT / 'extension/icons/sites/CHROMIUM-LICENSE.txt',
        'SITE-ICON-SOURCES.md': ROOT / 'extension/icons/sites/SOURCES.md',
        'PRIVACY.md': ROOT / 'docs' / f'PRIVACY_{platform.upper()}.md',
    }
    if platform == 'windows':
        expected.update({
            'DOTNET-LICENSE.txt': ROOT / 'licenses/dotnet-runtime/LICENSE.TXT',
            'DOTNET-THIRD-PARTY-NOTICES.txt': ROOT / 'licenses/dotnet-runtime/THIRD-PARTY-NOTICES.TXT',
        })
        require('钥匙串' not in files['PRIVACY.md'].decode('utf-8'), 'Mac text in Windows privacy notice')
    else:
        require(not DOTNET.intersection(files), '.NET notices in Mac delivery')
        require('Windows' not in files['PRIVACY.md'].decode('utf-8'), 'Windows text in Mac privacy notice')
        require('.NET' not in files['THIRD_PARTY_NOTICES.md'].decode('utf-8'), '.NET text in Mac notices')
    for name, source in expected.items():
        require(files.get(name) == source.read_bytes(), f'Missing or changed {platform} document: {name}')
    verify_markdown_links(files)


def verify_windows_executable(data):
    require(data[:2] == b'MZ', 'Not a Windows executable')
    offset = struct.unpack_from('<I', data, 0x3c)[0]
    require(data[offset:offset + 4] == b'PE\0\0', 'Invalid PE header')
    require(struct.unpack_from('<H', data, offset + 4)[0] == 0x8664, 'Expected Windows x64')
    require(struct.unpack_from('<H', data, offset + 24 + 68)[0] == 2, 'Expected Windows GUI subsystem')


def main():
    mac_name = 'tsinghua-auto-login-shared-macos.zip'
    win_name = 'tsinghua-auto-login-shared-windows-x64-test.zip'
    require({p.name for p in DIST.glob('*.zip')} == {mac_name, win_name}, 'Unexpected or missing distribution ZIP')
    mac = read_archive(DIST / mac_name, '清华网站自动重登-共享试用版/')
    windows = read_archive(DIST / win_name, '清华网站自动重登-Windows试用版/')
    payload = read_archive(ROOT / 'build/windows/payload.zip')
    verify_notices(mac, 'macos')
    verify_notices(windows, 'windows')
    verify_notices(payload, 'windows')
    require(windows['README.md'] == (ROOT / 'docs/WINDOWS.md').read_bytes(), 'Outdated Windows README')
    require(mac['README.md'] == (ROOT / 'docs/MACOS.md').read_bytes(), 'Outdated Mac README')
    require(not any(name.endswith(('.exe', '.cs', '.ps1')) or 'DOTNET' in name for name in mac), 'Mixed Mac package')
    require(not any(name.endswith(('.command', '.swift')) or name == 'native/host' for name in payload), 'Mixed Windows payload')
    allowed = {'安装.exe', '卸载.exe', 'README.md', 'PRIVACY.md', '开始使用.html', 'SHA256SUMS.txt'} | COMMON | DOTNET
    require(set(windows) == allowed, 'Unexpected Windows outer files')
    verify_checksums(windows['SHA256SUMS.txt'].decode('utf-8'),
                     {name: data for name, data in windows.items() if name != 'SHA256SUMS.txt'})
    metadata = json.loads(payload['package.json'])
    require(metadata['files'] == {name: hashlib.sha256(data).hexdigest() for name, data in payload.items()
                                  if name != 'package.json'}, 'Windows payload hash mismatch')
    for name in COMMON | DOTNET | {'PRIVACY.md'}:
        require(windows[name] == payload[name], 'Outer and installed notices disagree: ' + name)
    require(windows['安装.exe'] == windows['卸载.exe'] == (ROOT / 'build/windows/setup/TsinghuaLoginSetup.exe').read_bytes(),
            'Windows setup output and ZIP disagree')
    require(payload['host/TsinghuaLoginHost.exe'] == (ROOT / 'build/windows/host/TsinghuaLoginHost.exe').read_bytes(),
            'Windows host output and payload disagree')
    verify_windows_executable(windows['安装.exe'])
    verify_windows_executable(payload['host/TsinghuaLoginHost.exe'])
    runtime = json.loads((ROOT / 'licenses/dotnet-runtime/metadata.json').read_text())
    for name, digest in runtime['files'].items():
        checked_in = (ROOT / 'licenses/dotnet-runtime' / name).read_bytes()
        upstream = ROOT / 'build/windows/nuget' / runtime['package'].lower() / runtime['version'] / name
        require(checked_in == upstream.read_bytes(), 'Changed upstream runtime notice: ' + name)
        require(hashlib.sha256(checked_in).hexdigest() == digest, 'Runtime notice hash mismatch')
    verify_checksums((DIST / 'SHA256SUMS.txt').read_text(),
                     {name: (DIST / name).read_bytes() for name in (mac_name, win_name)})
    print('PASS: both ZIPs, platform separation, notice bytes, privacy, relative links, Windows x64 and all checksum lists')
    print(f'Files: Mac {len(mac)}, Windows outer {len(windows)}, Windows installed payload {len(payload)}')


if __name__ == '__main__':
    main()
