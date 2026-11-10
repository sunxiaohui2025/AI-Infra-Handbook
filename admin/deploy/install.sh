#!/usr/bin/env bash
set -euo pipefail

# AI Infra 学习网站运营后台 —— Linux VPS / systemd 一键部署
#
# 用法：
#   sudo bash install.sh                                  # 默认端口 8787，口令首次运行自动生成
#   sudo ADMIN_PASSWORD=你的口令 PORT=9000 bash install.sh # 指定口令与端口
#   sudo bash install.sh --uninstall                      # 卸载（会删数据）
#
# 行为：安装到 /opt/ai-infra-admin，以系统用户 ai-infra-admin 运行，systemd 开机自启。
# 需要：Node.js >= 22.5（自带 node:sqlite），bash，rsync（没有则退回 cp）。

APP_DIR=/opt/ai-infra-admin
SERVICE=ai-infra-admin
SVC_USER=ai-infra-admin
PORT="${PORT:-8787}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # 本脚本位于 admin/deploy/，其上级即 admin/

if [[ "${1:-}" == "--uninstall" ]]; then
  echo ">> 停止并删除服务 ${SERVICE} ..."
  systemctl stop "${SERVICE}" 2>/dev/null || true
  systemctl disable "${SERVICE}" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE}.service"
  systemctl daemon-reload
  echo ">> 删除 ${APP_DIR} 与用户 ${SVC_USER}（数据一并删除）"
  rm -rf "${APP_DIR}"
  userdel "${SVC_USER}" 2>/dev/null || true
  echo "卸载完成。"
  exit 0
fi

[[ $EUID -eq 0 ]] || { echo "请用 root 或 sudo 运行本脚本"; exit 1; }

# 1) 检查 Node 版本
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "未找到 node。请先安装 Node.js 22.5+（本程序用内置 node:sqlite，无需其它依赖）。"
  exit 1
fi
echo ">> 使用 Node $("$NODE" -v)  ($NODE)"

# 2) 系统用户（无登录，跑服务）
id -u "$SVC_USER" &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"

# 3) 部署目录
mkdir -p "$APP_DIR"
echo ">> 复制程序到 ${APP_DIR} ..."
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude 'data/' --exclude 'config.json' "$SRC_DIR/" "$APP_DIR/"
else
  rm -rf "${APP_DIR}/"* 2>/dev/null || true
  cp -a "$SRC_DIR/." "$APP_DIR/"
  rm -rf "$APP_DIR/data" "$APP_DIR/config.json"
fi

# 4) 口令：可被环境变量指定，否则留给首次运行随机生成
if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
  cat > "$APP_DIR/config.json" <<EOF
{
  "adminPassword": "$ADMIN_PASSWORD",
  "port": $PORT,
  "allowedOrigins": ["*"]
}
EOF
  echo ">> 已用 ADMIN_PASSWORD 写入口令（在 ${APP_DIR}/config.json）"
fi

chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"

# 5) systemd 单元
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=AI Infra course operations backend (anonymous visits + feedback)
After=network.target

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE $APP_DIR/server.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

echo
echo "部署完成。"
echo "  服务    ${SERVICE}"
echo "  目录    ${APP_DIR}"
echo "  端口    ${PORT}   →  http://<服务器IP>:${PORT}/admin"
echo "  口令    见 ${APP_DIR}/config.json 的 adminPassword（没设环境变量则首次运行已随机生成）"
echo "  日志    journalctl -u ${SERVICE} -f"
echo
echo "还没配 HTTPS 反代的话，参考 ${APP_DIR}/deploy/nginx.conf.example 或 deploy/Caddyfile.example。"
echo
echo "给前端用的后端地址（跨域时把它写成 PUBLIC_BACKEND_BASE）："
echo "  http://<服务器IP>:${PORT}"
