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
    # 先建数据库：讲号（左列，x0<110）-> (页, 该页内该 span 的 y 中心)，用于消歧
    num_positions = {}  # text -> list of (page_idx, y_center)
    for idx, spans in enumerate(pages_spans):
        for text, rect in spans:
            t = text.strip()
            if t.isdigit() and rect.x0 < 110:
                num_positions.setdefault(t, []).append((lo + idx, (rect.y0 + rect.y1) / 2))

    for p in parts:
        for lec in p.get("lectures", []):
            title = str(lec["title"]).strip()
            numtext = f"{int(lec['id']):02d}"
            # 该讲在目录里对应的讲号 span（y 中心）
            ref_y = None
            for t, pos in num_positions.items():
                if t == numtext and pos:
                    ref_y = pos[0][1]
                    break
            # 用 search_for 找讲名 bbox，若有多个（子串碰撞）按 y 中心最近取
            best = None
            for idx in range(len(pages_spans)):
                pno = lo + idx
                hits = doc[pno].search_for(title)
                for r in hits:
                    if best is None:
                        best = (pno, r)
                    elif ref_y is not None:
                        if abs((r.y0 + r.y1) / 2 - ref_y) < abs((best[1].y0 + best[1].y1) / 2 - ref_y):
                            best = (pno, r)
            if best:
                add_link(best[0], best[1], lec["page"], f"lecture {lec['id']}")

    doc.save(outp, garbage=3, deflate=True)
    print(f"已加导航：书签 {len(toc)} 条，目录可点击 {n_links} 处")


if __name__ == "__main__":
    main()
