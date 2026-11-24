#!/usr/bin/env bash
# 线上 Cloudflare D1 访问数据备份（导出为 SQL 文件）。
#
# 前置：本机已登录 wrangler（npx wrangler login），且能访问该 CF 账号的 D1。
# 用法：在 site/ 目录下执行
#   bash admin/backup-d1.sh
#
# 行为：
# - 从 wrangler.jsonc 读取 d1_databases[0].database_name 与 database_id；
# - 用 `wrangler d1 export` 导出全部表数据到 admin/backups/d1-<库名>-<时间戳>.sql；
# - 校验导出文件非空；只保留最近 14 份 SQL 备份。
set -euo pipefail

cd "$(dirname "$0")/.."   # 切到 site/
BACKUP_DIR="admin/backups"
mkdir -p "$BACKUP_DIR"

# 从 wrangler.jsonc 解析 database_name / database_id（去掉 // 注释后取首个）
read_db_field() {
  local field="$1"
  node -e '
    const fs=require("fs");
    let t=fs.readFileSync("wrangler.jsonc","utf8").replace(/^\s*\/\/.*$/gm,"");
    const cfg=JSON.parse(t);
    const d=(cfg.d1_databases||[])[0]||{};
    process.stdout.write(String(d[process.argv[1]]||""));
  ' "$field"
}

DB_NAME="$(read_db_field database_name)"
DB_ID="$(read_db_field database_id)"
if [ -z "$DB_NAME" ] || [ -z "$DB_ID" ]; then
  echo "✗ 无法从 wrangler.jsonc 读取 D1 配置（database_name / database_id）" >&2
  exit 1
fi

WRANGLER="${WRANGLER:-npx wrangler}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/d1-${DB_NAME}-${TS}.sql"

echo "==> 导出 D1 库 $DB_NAME ($DB_ID)"
if ! $WRANGLER d1 export "$DB_NAME" --remote --output "$OUT"; then
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "✗ 导出失败。请先登录：npx wrangler login（或设置 CLOUDFLARE_API_TOKEN）" >&2
  fi
  exit 1
fi

if [ ! -s "$OUT" ]; then
  echo "✗ 导出文件为空，备份失败" >&2
  rm -f "$OUT"
  exit 1
fi

SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "✓ 备份完成: $OUT ($SIZE 字节)"

# 只保留最近 14 份 d1-*.sql
KEEP="${BACKUP_KEEP:-14}"
COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -name 'd1-*.sql' | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -name 'd1-*.sql' -printf '%T@ %p\n' \
    | sort -n | head -n $((COUNT - KEEP)) | cut -d' ' -f2- | while read -r old; do
      rm -f "$old" && echo "  清理旧备份: $old"
    done
fi
