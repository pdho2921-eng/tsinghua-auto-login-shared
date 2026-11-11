#!/bin/zsh
set -eu
PACKAGE_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
print '正在安装清华网站自动重登共享助手…'
if ! "$PACKAGE_DIR/native/host" --install "$PACKAGE_DIR"; then
  print '安装未完成。请确认已完整解压试用包，并查看上方提示。'
  read -r '?按回车关闭。'
  exit 1
fi
/usr/bin/open "$PACKAGE_DIR/开始使用.html" || true
/usr/bin/open -R "$HOME/Library/Application Support/TsinghuaAutoLoginShared/extension" || true
print '使用说明和扩展文件夹已打开。完成浏览器设置后，可关闭此窗口。'
read -r '?按回车关闭。'
