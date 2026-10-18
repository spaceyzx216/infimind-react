#!/bin/bash
# 法飞飞 AI 管理台 · macOS 双击入口
#
# 双击本文件即可建立 SSH 隧道并打开管理台；关闭本终端窗口（或 Ctrl+C）即断开隧道。
# 首次使用请先运行 scripts/ops/setup-admin-tunnel-key.sh，并配置 ~/.ssh/config。

set -e
cd "$(dirname "$0")/../.."
exec node scripts/ops/admin-open.mjs
