#!/usr/bin/env python3
# 给导出的 PDF 加「导航目录」：
#   1) 侧边栏书签（PDF outline）：篇 -> 讲，点击直接跳到对应页
#   2) 目录页里每一行可点击，跳到具体章节/讲
#
# 由 export-pdf.mjs 在合并 PDF 后调用。
# 用法：python3 add-pdf-nav.py <输入.pdf> <输出.pdf> <manifest.json>
#
# manifest.json 结构：
#   {
#     "title": "《AI Infra-HandBook》",
#     "tocPages": 8,                 // 总目录占几页（0 基的目录页为 1..tocPages）
#     "parts": [
#       {"part":1,"name":"数学基础","page":9,       // page 是 1 基页号
#        "lectures":[{"id":1,"title":"向量","page":10}, ...]},
#       ...
#     ]
#   }
#
# 依赖：python3 + PyMuPDF（pip install pymupdf）
import sys
import json
import fitz


def collect(page):
    """收集一页的：spans=[(text, rect), ...]，按左列讲号 x0 阈值筛选用。"""
    spans = []
    lines = []
    d = page.get_text("dict")
    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue
        for ln in block.get("lines", []):
            sp = [(s.get("text", ""), fitz.Rect(s["bbox"]))
                  for s in ln.get("spans", []) if s.get("text", "").strip()]
            if not sp:
                continue
            lines.append(("".join(t for t, _ in sp), fitz.Rect(ln["bbox"])))
            spans.extend(sp)
    return spans, lines


def main():
    if len(sys.argv) != 4:
        sys.exit(f"用法: {sys.argv[0]} <输入.pdf> <输出.pdf> <manifest.json>")
    inp, outp, manp = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(manp, encoding="utf-8") as f:
        man = json.load(f)

    doc = fitz.open(inp)
    toc_pages = int(man.get("tocPages", 1))
    parts = man.get("parts", [])

    # 目录页的 0 基范围：封面=0；目录从 1 开始，共 toc_pages 页
    lo, hi = 1, min(1 + toc_pages, doc.page_count)

    # ---- 0) 缓存目录页的 span / 行 ----
    pages_spans = []   # 每页 spans
    pages_lines = []   # 每页 lines
    for pno in range(lo, hi):
        sp, ln = collect(doc[pno])
        pages_spans.append(sp)
        pages_lines.append(ln)

    # ---- 1) 侧边栏书签 ----
    toc = [[1, "封面", 1], [1, "目录", 2]]
    for p in parts:
        toc.append([1, f"第 {p['part']} 篇 · {p['name']}", int(p["page"])])
        for lec in p.get("lectures", []):
            toc.append([2, f"{int(lec['id']):02d} {lec['title']}", int(lec["page"])])
    doc.set_toc(toc)

    n_links = 0

    def add_link(pno, rect, target, desc):
        """在 pno(0基) 页的 rect 上加跳转到 target(1基) 页的内部链接。"""
        nonlocal n_links
        if pno is None or rect is None:
            return
        try:
            doc[pno].insert_link({"kind": fitz.LINK_GOTO, "page": int(target) - 1,
                                  "from": rect, "to": fitz.Point(0, 0)})
            n_links += 1
        except Exception:
            pass

    # ---- 2) 篇标题行 -> 篇扉页（找同时含「篇」和篇名的行）----
    for p in parts:
        name = p["name"].strip()
        hit = None
        for idx, lines in enumerate(pages_lines):
            for text, rect in lines:
                if "篇" in text and name in text:
                    hit = (lo + idx, rect)
                    break
            if hit:
                break
        if hit:
            add_link(hit[0], hit[1], p["page"], "part")

    # ---- 3) 每讲 -> 讲首页 ----
    # 目录页每行是「讲号 + 讲名」，据此一次遍历定位全部讲，避免对每讲做全页 search_for。
    # 建索引：讲号（左列 span，x0<110 的 2 位数字）-> [(页idx, 行rect, 行文本), ...]
    lec_rows = {}  # numtext -> list of (page_idx, line_rect, line_text)
    for idx, lines in enumerate(pages_lines):
        pno = lo + idx
        for text, rect in lines:
            # 取本行最左侧的讲号 span
            num = None
            for stext, srect in pages_spans[idx]:
                if srect.x0 < 110 and srect.y0 >= rect.y0 - 1 and srect.y1 <= rect.y1 + 1:
                    t = stext.strip()
                    if t.isdigit() and len(t) == 2:
                        num = t
                        break
            if num is not None:
                lec_rows.setdefault(num, []).append((pno, rect, text))

    for p in parts:
        for lec in p.get("lectures", []):
            title = str(lec["title"]).strip()
            numtext = f"{int(lec['id']):02d}"
            best = None
            for pno, rect, ltext in lec_rows.get(numtext, []):
                # 行内包含讲名即可视为命中（讲号已唯一限定该行）
                if title in ltext:
                    best = (pno, rect)
                    break
            if best:
                add_link(best[0], best[1], lec["page"], f"lecture {lec['id']}")

    doc.save(outp, garbage=3, deflate=True)
    print(f"已加导航：书签 {len(toc)} 条，目录可点击 {n_links} 处")


if __name__ == "__main__":
    main()
