#!/usr/bin/env bash
# 一键把「静态站 + 运营后台」部署到 Cloudflare Workers + D1。
#
# 前提：
#   - 已安装 node / npm，并 `npx wrangler login` 过（或已配置 CLOUDFLARE_API_TOKEN）
#   - 在 site/ 目录下运行本脚本
#
# 用法：
#   sh admin/deploy/deploy-cloudflare.sh
# 可用环境变量：
#   D1_NAME=ai-infra-handbook-db        数据库名（默认如上）
#   ADMIN_PASSWORD=xxxx                 后台口令（不设则交互输入）
#   WRANGLER='npx wrangler'             wrangler 调用方式
set -euo pipefail

cd "$(dirname "$0")"
SITE_DIR="$(cd ../.. && pwd)"
cd "$SITE_DIR"

D1_NAME="${D1_NAME:-ai-infra-handbook-db}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
WRANGLER="${WRANGLER:-npx wrangler}"

echo "==> 1/6 构建前端静态站"
npx astro build

echo "==> 2/6 把运营后台 SPA 拷进 dist/admin"
mkdir -p dist/admin
cp -R admin/public/. dist/admin/
echo "    dist/admin/:" && ls dist/admin

echo "==> 3/6 检查 Cloudflare 登录"
if ! $WRANGLER whoami >/dev/null 2>&1; then
  echo "❌ 未登录。请先运行：npx wrangler login" >&2
  exit 1
fi

echo "==> 4/6 准备 D1 数据库（$D1_NAME）"
_get_id() { python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(d, list):
    d = next((x for x in d if str(x.get('name',''))=='$D1_NAME'), None)
if not d: sys.exit(0)
print(d.get('uuid') or d.get('database_id') or d.get('id') or '')
"; }
D1_ID="$($WRANGLER d1 list --json 2>/dev/null | _get_id || true)"
if [ -z "$D1_ID" ]; then
  echo "    → 创建新 D1：$D1_NAME"
  D1_ID="$($WRANGLER d1 create "$D1_NAME" --json 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(d.get('uuid') or d.get('database_id') or d.get('id') or '')
" || true)"
fi
if [ -z "$D1_ID" ]; then
  echo "❌ 无法获取 D1 数据库 id，请手动运行：$WRANGLER d1 create $D1_NAME 并把 id 填进 wrangler.jsonc" >&2
  exit 1
fi
echo "    D1 id = $D1_ID"
python3 - "$D1_ID" <<'PY'
import sys, re, pathlib
p = pathlib.Path('wrangler.jsonc')
t = p.read_text(encoding='utf-8')
t = re.sub(r'"database_id"\s*:\s*"[^"]*"', '"database_id": "%s"' % sys.argv[1], t)
p.write_text(t, encoding='utf-8')
PY
echo "    ✓ 已写入 wrangler.jsonc"

echo "==> 5/6 应用 D1 表结构 + 设置后台口令"
$WRANGLER d1 execute "$D1_NAME" --remote --file="$SITE_DIR/admin/schema.sql"
if [ -z "$ADMIN_PASSWORD" ]; then
  if [ -t 0 ]; then
    read -rsp "    设置后台登录口令: " ADMIN_PASSWORD; echo
  else
    echo "❌ 未提供 ADMIN_PASSWORD（非交互环境）" >&2; exit 1
  fi
fi
[ -z "$ADMIN_PASSWORD" ] && { echo "❌ 口令不能为空" >&2; exit 1; }
printf '%s' "$ADMIN_PASSWORD" | $WRANGLER secret put ADMIN_PASSWORD

echo "==> 6/6 部署 Worker + 静态资源"
$WRANGLER deploy

echo ""
echo "✅ 部署完成！"
echo "   前端站点:  https://ai-infra-handbook.sunxiaohui2022.workers.dev"
echo "   运营后台:  https://ai-infra-handbook.sunxiaohui2022.workers.dev/admin"
echo "   登录口令:  （你刚设置的 ADMIN_PASSWORD）"
