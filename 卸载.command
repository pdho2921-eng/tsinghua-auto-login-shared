#!/bin/zsh
set -eu
PACKAGE_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
print '此操作移除共享版的本机助手和浏览器连接配置。'
print '如需同时删除密码，请先在扩展设置页点击“删除已保存密码”。'
read -r 'ANSWER?继续卸载？输入 y 并按回车：'
if [[ "$ANSWER" != y ]]; then exit 0; fi
"$PACKAGE_DIR/native/host" --uninstall
read -r '?按回车关闭。'
