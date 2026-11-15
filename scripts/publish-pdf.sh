#!/usr/bin/env bash
# 把《全书》PDF 压缩后发布到仓库的 release/ 目录（下载链接指向的单独管理版本）。
#
# 为什么单独放 release/：exports/ 是构建临时区（被 .gitignore 忽略，不入库），
# 而 release/ 里的这本便是 README 顶部「PDF 下载」链接指向的、随仓库版本走的成品。
#
# 用法：
#   npm run pdf:release                       # 用 exports 下的《全书》压缩并发布
#   bash scripts/publish-pdf.sh [输入.pdf]     # 指定输入（默认 exports/AI-Infra-HandBook-全书.pdf）
#
# 依赖：brew install ghostscript
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-exports/AI-Infra-HandBook-全书.pdf}"
DEST="release/AI-Infra-HandBook.pdf"

# 1) 压缩（复用 compress-pdf.sh；临时产物放同目录，避免动到 release/）
TMP="${SRC%.pdf}-small.pdf"
bash "$HERE/compress-pdf.sh" "$SRC" "$TMP"

# 2) 复制到发布目录，并用固定文件名
mkdir -p "$(dirname "$DEST")"
cp -f "$TMP" "$DEST"

SIZE=$(du -h "$DEST" | cut -f1)
echo "✅ 已发布下载版：${DEST}（${SIZE}）"
echo "   GitHub 下载链接：https://raw.githubusercontent.com/sunxiaohui2025/AI-Infra-Handbook/main/release/AI-Infra-HandBook.pdf"
