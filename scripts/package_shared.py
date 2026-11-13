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
    content = (ROOT / 'PRIVACY.md').read_text()
    if platform == 'windows':
        content = content.replace('账号密码存入 macOS 登录钥匙串中的独立条目。',
            '账号密码由 Windows 当前用户范围的 DPAPI 加密，分别保存到 `%LOCALAPPDATA%\\TsinghuaAutoLoginShared.Credentials.v1` 中的固定文件。目录仅授予当前用户与系统账户访问。重装系统、更换 Windows 账号或迁移电脑后，可能需要重新保存密码。')
        content = content.replace('其他钥匙串服务名称', '其他凭据名称')
        content = content.replace('默认登录 Mac 后可自动使用凭据。锁定钥匙串会导致自动读取停止；不要求每次读取均进行 Touch ID 验证。',
            '登录当前 Windows 账号后可自动使用凭据，不要求每次读取均进行 Windows Hello 验证。系统加密不隔离已经取得当前 Windows 用户权限的其他程序。')
    return content


def update_checksums(dist: Path):
    archives = sorted(dist.glob('tsinghua-auto-login-shared-*.zip'))
    (dist / 'SHA256SUMS.txt').write_text(''.join(
        f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in archives))
