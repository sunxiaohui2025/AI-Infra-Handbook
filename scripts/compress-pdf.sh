#!/usr/bin/env bash
# 用 Ghostscript 重编码 PDF：合并重复的字体子集并压缩。
#
# 为什么需要它：export-pdf.mjs 是「每讲单独 page.pdf() 再合并」，
# 每次生成都带一套字体子集，合并后不去重，导致全书 PDF 动辄一两百 MB。
# 这条命令重编码后通常能降到原来的约 1/6，且文字、页码、封面/目录都不变。
#
# 用法：
#   scripts/compress-pdf.sh <输入.pdf> [输出.pdf]
#   npm run pdf:compress                       # 压缩 exports 下的《全书》
#
# 依赖：brew install ghostscript
set -euo pipefail

if ! command -v gs >/dev/null 2>&1; then
  echo "缺少 Ghostscript，请先运行：brew install ghostscript" >&2
  exit 1
fi

if [ "$#" -lt 1 ]; then
  echo "用法: scripts/compress-pdf.sh <输入.pdf> [输出.pdf]" >&2
  exit 1
fi

IN="$1"
if [ ! -f "$IN" ]; then
  echo "找不到输入文件：$IN" >&2
  exit 1
fi

if [ "$#" -ge 2 ]; then
  OUT="$2"
else
  OUT="${IN%.pdf}-small.pdf"
fi

gs \
  -sDEVICE=pdfwrite \
  -dCompatibilityLevel=1.5 \
  -dPDFSETTINGS=/ebook \
  -dNOPAUSE -dBATCH -dQUIET \
  -sOutputFile="$OUT" \
  "$IN"

SIZE=$(du -h "$OUT" | cut -f1)
echo "✅ 已压缩：${IN} -> ${OUT}（${SIZE}）"
