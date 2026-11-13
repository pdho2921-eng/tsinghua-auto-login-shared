"""Build platform-specific distribution copies from one maintained extension source."""
from pathlib import Path
import hashlib
import json
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]


def extension_manifest(platform: str):
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
    if platform == 'windows':
        config = json.loads((ROOT / 'native/windows/config.json').read_text())
        manifest['version'] = config.get('extensionVersion', manifest['version'])
    return manifest


def prepare_extension(destination: Path, platform: str):
    if platform not in ('macos', 'windows'):
        raise ValueError(platform)
    if any(p.is_symlink() for p in (ROOT / 'extension').rglob('*')):
        raise ValueError('Extension source must not contain symbolic links')
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(ROOT / 'extension', destination, ignore=shutil.ignore_patterns('.DS_Store'))
    script = destination / 'platform.js'
    content = script.read_text()
    # Installed packages have a fixed platform; loading a package on a different OS
    # must not silently claim its helper is compatible there.
    content = re.sub(r'  const isWindows = .*?;\n', f'  const isWindows = {str(platform == "windows").lower()};\n', content, count=1)
    script.write_text(content)
    if platform == 'windows':
        manifest = extension_manifest(platform)
        (destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        replacements = {
            '解压完整试用包，双击“安装.command”，等待显示安装完成。': '解压完整试用包，双击“安装.exe”，等待显示安装完成。',
            '如提示钥匙串锁定，请在 Mac 的“钥匙串访问”中解锁登录钥匙串；如刚更新助手，请重新保存密码。': '如提示无法访问已保存凭据，请确认正在使用原 Windows 账号；必要时重新保存密码。',
            '已在 Mac 本机和虚拟机的 Chrome 上做过简单测试，Intel 芯片、旧版 macOS 和 Mac Edge 仍待实测反馈。': '已在 Windows 11＋Edge 上做过简单测试，Windows 10 及以下版本、Windows Chrome 仍待实测反馈。',
            '右键图标选择“选项”': '右键图标选择“扩展选项”',
            '密码保存在这台 Mac 的登录钥匙串，登录 Mac 后可自动使用': '密码由 Windows 加密保存在这台电脑，登录当前 Windows 账号后可自动使用',
            '卸载.command': '卸载.exe'
        }
        options = destination / 'options.html'
        text = options.read_text()
        source_version = extension_manifest('macos')['version']
        text = text.replace('扩展版本 ' + source_version, '扩展版本 ' + manifest['version'])
        for old, new in replacements.items():
            if old not in text:
                raise ValueError('Platform copy needs review: ' + old)
            text = text.replace(old, new)
        options.write_text(text)
    return {str(p.relative_to(destination)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(destination.rglob('*')) if p.is_file()}


def start_page(platform: str):
    content = (ROOT / '开始使用.html').read_text()
    if platform == 'windows':
        for old, new in {
            '在 Chrome 地址栏输入': '在 Edge 地址栏输入',
            'chrome://extensions/': 'edge://extensions/',
            '在右上角选择开启“开发者模式”': '在扩展管理页开启“开发人员模式”',
            '加载未打包的扩展程序': '加载解压缩的扩展',
            '右键图标选择“选项”': '右键图标选择“扩展选项”',
            '若找不到，在选择窗口按 Command＋Shift＋G，粘贴：': '若找不到，在选择窗口的地址栏粘贴：',
            '~/Library/Application Support/TsinghuaAutoLoginShared/extension': r'%LOCALAPPDATA%\TsinghuaAutoLoginShared\extension'
        }.items():
            if old not in content:
                raise ValueError('Start-page copy needs review: ' + old)
            content = content.replace(old, new)
    return content


def privacy(platform: str):
    names = {'macos': 'PRIVACY_MACOS.md', 'windows': 'PRIVACY_WINDOWS.md'}
    return (ROOT / 'docs' / names[platform]).read_text(encoding='utf-8')


def dotnet_runtime():
    directory = ROOT / 'licenses/dotnet-runtime'
    metadata = json.loads((directory / 'metadata.json').read_text(encoding='utf-8'))
    if metadata['package'] != 'Microsoft.NETCore.App.Runtime.win-x64' or not re.fullmatch(r'10\.0\.\d+', metadata['version']):
        raise ValueError('Review the Windows runtime version and notices before building')
    if set(metadata['files']) != {'LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT'}:
        raise ValueError('Incomplete .NET runtime notices')
    for name, digest in metadata['files'].items():
        if hashlib.sha256((directory / name).read_bytes()).hexdigest() != digest:
            raise ValueError('Changed .NET runtime notice: ' + name)
    return metadata


def verify_dotnet_runtime(build: Path, project: str):
    metadata = dotnet_runtime()
    source = build / 'nuget' / metadata['package'].lower() / metadata['version']
    for name in metadata['files']:
        if (source / name).read_bytes() != (ROOT / 'licenses/dotnet-runtime' / name).read_bytes():
            raise ValueError('Runtime package and checked-in notices disagree: ' + name)
    # Check the published dependency manifest, not just the requested build version.
    deps = ROOT / f'native/windows/{project}/obj/Release/net10.0/win-x64/TsinghuaLogin{project}.deps.json'
    libraries = json.loads(deps.read_text(encoding='utf-8'))['libraries']
    expected = f'runtimepack.{metadata["package"]}/{metadata["version"]}'
    runtime_libraries = [name for name in libraries if name.startswith('runtimepack.Microsoft.NETCore.App.Runtime.')]
    if runtime_libraries != [expected]:
        raise ValueError('Published runtime does not match the distributed notices')


def package_notices(platform: str):
    if platform not in ('macos', 'windows'):
        raise ValueError(platform)
    content = ('# 许可证与第三方材料\n\n'
               '除另有说明的第三方材料外，本项目源代码采用 [MIT 许可证](LICENSE)。\n\n'
               '网站图标来源见 [SITE-ICON-SOURCES.md](SITE-ICON-SOURCES.md)。'
               '学校网站图标权益归原权利方，本项目的 MIT 许可证不包含对这些图标的额外授权。'
               'Chromium 默认图标的完整许可见 [CHROMIUM-LICENSE.txt](CHROMIUM-LICENSE.txt)。\n')
    files = {
        'LICENSE': (ROOT / 'LICENSE').read_bytes(),
        'SITE-ICON-SOURCES.md': (ROOT / 'extension/icons/sites/SOURCES.md').read_bytes(),
        'CHROMIUM-LICENSE.txt': (ROOT / 'extension/icons/sites/CHROMIUM-LICENSE.txt').read_bytes(),
    }
    if platform == 'windows':
        metadata = dotnet_runtime()
        content += (f'\nWindows 助手和安装程序自带 .NET {metadata["version"]} x64 运行时组件，无需另行安装。'
                    '完整许可及第三方声明见 [DOTNET-LICENSE.txt](DOTNET-LICENSE.txt) 和 '
                    '[DOTNET-THIRD-PARTY-NOTICES.txt](DOTNET-THIRD-PARTY-NOTICES.txt)。\n')
        files['DOTNET-LICENSE.txt'] = (ROOT / 'licenses/dotnet-runtime/LICENSE.TXT').read_bytes()
        files['DOTNET-THIRD-PARTY-NOTICES.txt'] = (ROOT / 'licenses/dotnet-runtime/THIRD-PARTY-NOTICES.TXT').read_bytes()
    files['THIRD_PARTY_NOTICES.md'] = content.encode('utf-8')
    return files


def copy_notices(destination: Path, platform: str):
    for name, contents in package_notices(platform).items():
        (destination / name).write_bytes(contents)


def update_checksums(dist: Path):
    archives = sorted(dist.glob('tsinghua-auto-login-shared-*.zip'))
    (dist / 'SHA256SUMS.txt').write_text(''.join(
        f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in archives))
