#!/usr/bin/env python3
"""Build a Windows x64 candidate on macOS or Windows; no recipient toolchain needed.

The 'test' archive name denotes a trial distribution with limited real-device coverage.
Run with --dotnet /path/to/dotnet if the .NET 10 SDK is not on PATH.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

from package_shared import ROOT, extension_manifest, prepare_extension, privacy, start_page, update_checksums


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dotnet', default=shutil.which('dotnet'))
    args = parser.parse_args()
    if not args.dotnet:
        parser.error('Install the .NET 10 SDK on the development machine, or pass --dotnet.')
    dotnet = str(Path(args.dotnet).resolve())
    build = ROOT / 'build/windows'
    build.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, DOTNET_CLI_TELEMETRY_OPTOUT='1', DOTNET_GENERATE_ASPNET_CERTIFICATE='false',
               DOTNET_CLI_HOME=str(build / 'dotnet-home'), NUGET_PACKAGES=str(build / 'nuget'),
               DOTNET_CLI_USE_MSBUILD_SERVER='0')

    def run(*command):
        subprocess.run(command, cwd=ROOT, env=env, check=True)

    config = json.loads((ROOT / 'native/config.json').read_text())
    windows = json.loads((ROOT / 'native/windows/config.json').read_text())
    manifest = extension_manifest('windows')
    identity = ''.join(chr(97 + int(c, 16)) for c in hashlib.sha256(base64.b64decode(manifest['key'], validate=True)).hexdigest()[:32])
    if identity != config['extensionId']:
        raise ValueError('Extension public key and host allowlist do not match')
    values = dict(Host=config['host'], ExtensionId=identity, Origin=f'chrome-extension://{identity}/',
                  Version=windows['version'], ExtensionVersion=manifest['version'], PublicKey=manifest['key'])
    (build / 'BuildInfo.cs').write_text('namespace Tsinghua;\npublic static class BuildInfo {\n' + ''.join(
        f'public const string {key} = {json.dumps(value)};\n' for key, value in values.items()) +
        f'public const int Protocol = {config["protocol"]};\n}}\n')
    run(dotnet, 'run', '--project', 'native/windows/Tests/Tests.csproj', '-c', 'Release')

    def publish(project, output):
        run(dotnet, 'publish', f'native/windows/{project}/{project}.csproj', '-c', 'Release', '-r', 'win-x64',
            '--self-contained', 'true', '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true',
            '-p:PublishTrimmed=true', '-p:EnableCompressionInSingleFile=true', '-o', str(output), '--nologo')

    publish('Host', build / 'host')
    with tempfile.TemporaryDirectory(prefix='candidate-', dir=build) as temp:
        temp = Path(temp)
        payload = temp / 'payload'
        prepare_extension(payload / 'extension', 'windows')
        shutil.copytree(build / 'host', payload / 'host')
        if sorted(p.name for p in (payload / 'host').iterdir()) != ['TsinghuaLoginHost.exe']:
            raise ValueError('Unexpected host output: refuse an incomplete single-file package')
        (payload / '开始使用.html').write_text(start_page('windows'))
        (payload / 'PRIVACY.md').write_text(privacy('windows'))
        files = {p.relative_to(payload).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in sorted(payload.rglob('*')) if p.is_file()}
        metadata = dict(host=config['host'], extensionId=identity, protocol=config['protocol'], helperVersion=windows['version'],
                        extensionVersion=manifest['version'], platform='windows-x64', files=files)
        (payload / 'package.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
        with zipfile.ZipFile(build / 'payload.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
            for p in sorted(payload.rglob('*')):
                if p.is_file(): archive.write(p, p.relative_to(payload).as_posix())
        digest = hashlib.sha256((build / 'payload.zip').read_bytes()).hexdigest()
        (build / 'PayloadInfo.cs').write_text(f'namespace Tsinghua;\npublic static class PayloadInfo {{ public const string Hash = "{digest}"; }}\n')
        run(dotnet, 'run', '--project', 'native/windows/Tests/Tests.csproj', '-c', 'Release', '--', '--payload', str(build / 'payload.zip'))
        publish('Setup', build / 'setup')
        package = temp / '清华网站自动重登-Windows试用版'
        package.mkdir()
        for name in ['安装.exe', '卸载.exe']:
            shutil.copy2(build / 'setup/TsinghuaLoginSetup.exe', package / name)
        shutil.copy2(ROOT / 'docs/WINDOWS.md', package / 'README.md')
        (package / 'PRIVACY.md').write_text(privacy('windows'))
        (package / '开始使用.html').write_text(start_page('windows'))
        (package / 'SHA256SUMS.txt').write_text(''.join(
            f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in sorted(package.iterdir())))
        candidate = temp / 'tsinghua-auto-login-shared-windows-x64-test.zip'
        with zipfile.ZipFile(candidate, 'w', zipfile.ZIP_DEFLATED) as archive:
            for p in sorted(package.iterdir()): archive.write(p, f'{package.name}/{p.name}')
        # Verify the exact outer archive, not only the staging folder.
        with zipfile.ZipFile(candidate) as archive:
            if archive.testzip() is not None: raise ValueError('ZIP CRC failure')
            names = {Path(n).name for n in archive.namelist()}
            if names != {'安装.exe', '卸载.exe', 'README.md', 'PRIVACY.md', '开始使用.html', 'SHA256SUMS.txt'}:
                raise ValueError('Wrong platform or extra files in Windows delivery')
            for p in package.iterdir():
                if archive.read(f'{package.name}/{p.name}') != p.read_bytes(): raise ValueError('ZIP content mismatch')
        dist = ROOT / 'dist'; dist.mkdir(exist_ok=True)
        os.replace(candidate, dist / candidate.name)
        update_checksums(dist)
    print('Built Windows trial package. Build checks passed; real-device coverage is recorded separately in docs/VALIDATION.md.')


if __name__ == '__main__':
    main()
