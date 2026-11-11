#!/usr/bin/env bash
# 部署「静态站 + 运营后台」到 Cloudflare Workers(静态资源) + D1。
#
# 两种用法：
#   1) 作为 **Cloudflare Pages 的 Deploy command**（推荐）
#      - Pages 的 Build command 设成 `npm run build`（它会顺带拷 admin 进 dist）
#      - Pages 的 Deploy command 设成   `bash admin/deploy/deploy-cloudflare.sh`
#      - 在 Pages 项目设置里加一个 **Secret** 环境变量 `ADMIN_PASSWORD`（后台口令）
#      - 构建环境会自动认证（CF_PAGES=1），脚本自动建 D1/建表/设口令/部署
#   2) 在你自己有 wrangler 登录的终端里跑 `sh admin/deploy/deploy-cloudflare.sh`
set -euo pipefail

cd "$(dirname "$0")"
SITE_DIR="$(cd ../.. && pwd)"
cd "$SITE_DIR"

D1_NAME="${D1_NAME:-ai-infra-handbook-db}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
WRANGLER="${WRANGLER:-npx wrangler}"
IS_PAGES="${CF_PAGES:-0}"   # Cloudflare Pages 构建环境会设 CF_PAGES=1

echo "==> 1/${IS_PAGES:+n}? 构建前端静态站"
if [ "$IS_PAGES" = "1" ]; then
  echo "    检测到 Cloudflare Pages 构建环境，跳过重复构建（Build command 已产出 dist/）"
else
  npx astro build
  echo "    已构建（本机模式）"
fi

echo "==> 拷后台 SPA 进 dist/admin（确保 /admin 能被发布）"
mkdir -p dist/admin
cp -R admin/public/. dist/admin/
echo "    dist/admin: $(ls dist/admin | tr '\n' ' ')"

if [ "$IS_PAGES" != "1" ]; then
  echo "==> 检查 Cloudflare 登录"
  if ! $WRANGLER whoami >/dev/null 2>&1; then
    echo "❌ 未登录。请先运行：npx wrangler login" >&2
    exit 1
  fi
fi

echo "==> 确保 D1 数据库存在（$D1_NAME）"
read_d1_id() {
  $WRANGLER d1 list --json 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let out="";
  try{const a=JSON.parse(s);const x=a.find(v=>String(v.name)===process.argv[1]);if(x)out=x.uuid||x.database_id||x.id||"";}catch(e){}
  process.stdout.write(out);
});' "$D1_NAME" || true
}
create_d1_id() {
  $WRANGLER d1 create "$D1_NAME" --json 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let out="";
  try{const x=JSON.parse(s);out=x.uuid||x.database_id||x.id||"";}catch(e){}
  process.stdout.write(out);
});' || true
}
D1_ID="$(read_d1_id)"
if [ -z "$D1_ID" ]; then
  echo "    → 创建新 D1：$D1_NAME"
  D1_ID="$(create_d1_id)"
fi
if [ -z "$D1_ID" ]; then
  echo "❌ 无法创建/读取 D1。请手动在控制台创建库后，把 database_id 填进 wrangler.jsonc" >&2
  exit 1
fi
echo "    D1 id = $D1_ID"

echo "==> 把 database_id 写进 wrangler.jsonc"
node -e '
const fs=require("fs");const p="wrangler.jsonc";
let t=fs.readFileSync(p,"utf8");
t=t.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${process.argv[1]}"`);
fs.writeFileSync(p,t);
' "$D1_ID"
echo "    ✓ 已写入 wrangler.jsonc"

echo "==> 应用 D1 表结构"
$WRANGLER d1 execute "$D1_NAME" --remote --file="$SITE_DIR/admin/schema.sql"

echo "==> 设置后台口令（ADMIN_PASSWORD）"
if [ -z "$ADMIN_PASSWORD" ]; then
  if [ "$IS_PAGES" = "1" ] || [ ! -t 0 ]; then
    echo "    ⚠️ 未提供 ADMIN_PASSWORD（非交互）。请在 Pages 项目设置里加 Secret 环境变量 ADMIN_PASSWORD 后重试；" >&2
    echo "       或先手动执行：printf '%s' '你的口令' | $WRANGLER secret put ADMIN_PASSWORD" >&2
    exit 1
  fi
  read -rsp "    设置后台登录口令: " ADMIN_PASSWORD; echo
fi
printf '%s' "$ADMIN_PASSWORD" | $WRANGLER secret put ADMIN_PASSWORD

echo "==> 部署 Worker + 静态资源"
$WRANGLER deploy

echo ""
echo "✅ 部署完成！"
echo "   前端站点:  https://ai-infra-handbook.sunxiaohui2022.workers.dev"
echo "   运营后台:  https://ai-infra-handbook.sunxiaohui2022.workers.dev/admin"
echo "   登录口令:  （你设置的 ADMIN_PASSWORD）"
