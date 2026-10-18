#!/usr/bin/env bash
#
# 法飞飞 AI 管理台 · 生成/复用专用受限 SSH 隧道密钥。
#
# 只在本机生成密钥并打印后续配置，不连接服务器、不上传任何文件。
# 私钥路径：~/.ssh/id_ed25519_fafee_admin
#
# 用法：
#   bash scripts/ops/setup-admin-tunnel-key.sh
#   bash scripts/ops/setup-admin-tunnel-key.sh --write-ssh-config
#
# --write-ssh-config：若 ~/.ssh/config 已存在且没有 Host flylegal-admin，
# 追加示例 Host 块（HostName 仍是 <服务器IP> 占位符，需要手动替换）。
# 不传该参数时只打印，不修改 ~/.ssh/config。

set -euo pipefail

KEY_PATH="$HOME/.ssh/id_ed25519_fafee_admin"
PUB_PATH="${KEY_PATH}.pub"
CONFIG_PATH="$HOME/.ssh/config"
HOST_ALIAS="flylegal-admin"
REMOTE_PORT="${ADMIN_REMOTE_PORT:-8791}"
WRITE_SSH_CONFIG=0

usage() {
  cat <<'EOF'
用法：bash scripts/ops/setup-admin-tunnel-key.sh [--write-ssh-config]

  --write-ssh-config  在 ~/.ssh/config 已存在且不含 Host flylegal-admin 时追加示例块
  -h, --help          显示帮助
EOF
}

for arg in "$@"; do
  case "$arg" in
    --write-ssh-config)
      WRITE_SSH_CONFIG=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "[错误] 未知参数：$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$REMOTE_PORT" =~ ^[0-9]+$ ]]; then
  echo "[错误] ADMIN_REMOTE_PORT 必须是 1-65535 的整数（当前值：${REMOTE_PORT}）。" >&2
  exit 2
fi
REMOTE_PORT=$((10#$REMOTE_PORT))
if ((REMOTE_PORT < 1 || REMOTE_PORT > 65535)); then
  echo "[错误] ADMIN_REMOTE_PORT 必须是 1-65535 的整数（当前值：${REMOTE_PORT}）。" >&2
  exit 2
fi

if ! command -v ssh-keygen >/dev/null 2>&1; then
  echo "[错误] 未找到 ssh-keygen，请先安装 OpenSSH 客户端。" >&2
  exit 1
fi

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

HOST_SHORT="$(hostname -s 2>/dev/null || uname -n)"
if [[ -z "$HOST_SHORT" ]]; then
  HOST_SHORT="$(uname -n)"
fi

if [[ -f "$KEY_PATH" ]]; then
  echo "已存在专用密钥，直接复用：$KEY_PATH"
else
  echo "正在生成专用 SSH 密钥（无口令）：$KEY_PATH"
  ssh-keygen -t ed25519 -N '' -f "$KEY_PATH" -C "fafee-admin-tunnel@${HOST_SHORT}"
fi

chmod 600 "$KEY_PATH"

if [[ ! -s "$PUB_PATH" ]]; then
  echo "公钥文件缺失，正在从私钥导出：$PUB_PATH"
  ssh-keygen -y -f "$KEY_PATH" >"$PUB_PATH"
  chmod 644 "$PUB_PATH"
fi

PUB_KEY="$(cat "$PUB_PATH")"
if [[ -z "$PUB_KEY" ]]; then
  echo "[错误] 公钥文件为空：$PUB_PATH" >&2
  exit 1
fi

printf -v AUTHORIZED_LINE 'restrict,port-forwarding,permitopen="127.0.0.1:%s" %s' "$REMOTE_PORT" "$PUB_KEY"

cat <<EOF

============================================================
法飞飞 AI 管理台 · SSH 隧道密钥
============================================================

[1/3] 本机公钥
$PUB_KEY

[2/3] 在服务器 ~/.ssh/authorized_keys 追加下面这一行（保持单行）
$AUTHORIZED_LINE

  建议同时确认服务器上的权限：
    chmod 700 ~/.ssh
    chmod 600 ~/.ssh/authorized_keys

[3/3] 本机 ~/.ssh/config 示例（把 <服务器IP> 替换为真实地址）
Host $HOST_ALIAS
  HostName <服务器IP>
  User root
  IdentityFile ~/.ssh/id_ed25519_fafee_admin
  BatchMode yes
  ExitOnForwardFailure yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
EOF

if ((WRITE_SSH_CONFIG)); then
  if [[ ! -f "$CONFIG_PATH" ]]; then
    echo
    echo "未找到 ${CONFIG_PATH}，未自动写入；请按上面的示例手动创建并替换 <服务器IP>。"
  elif grep -Eq '^[[:space:]]*Host[[:space:]]+([^#]*[[:space:]])?flylegal-admin([[:space:]]|$)' "$CONFIG_PATH"; then
    echo
    echo "${CONFIG_PATH} 中已存在 Host flylegal-admin，跳过写入（未改动现有配置）。"
  else
    if [[ -s "$CONFIG_PATH" && -n "$(tail -c 1 "$CONFIG_PATH")" ]]; then
      printf '\n' >>"$CONFIG_PATH"
    fi
    cat >>"$CONFIG_PATH" <<EOF

# fafee-admin tunnel (added by scripts/ops/setup-admin-tunnel-key.sh)
Host $HOST_ALIAS
  HostName <服务器IP>
  User root
  IdentityFile ~/.ssh/id_ed25519_fafee_admin
  BatchMode yes
  ExitOnForwardFailure yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
EOF
    chmod 600 "$CONFIG_PATH"
    echo
    echo "已追加 Host $HOST_ALIAS 到 ${CONFIG_PATH}。"
    echo "请先把 HostName 的 <服务器IP> 替换为真实地址，再运行 npm run admin:open。"
  fi
else
  echo
  echo "如需自动追加上述 Host 块，可重新运行并加上 --write-ssh-config。"
fi

cat <<'EOF'

下一步：
  1. 把 [2/3] 的整行追加到服务器 ~/.ssh/authorized_keys；
  2. 在 ~/.ssh/config 配好 Host flylegal-admin（替换 <服务器IP>）；
  3. 双击 scripts/ops/admin-open.command，或运行 npm run admin:open。

私钥只留在本机，不要发给他人、不要提交到仓库，也不要写入服务器。
EOF
