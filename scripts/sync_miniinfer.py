"""把文章里引用到的 miniinfer 文件同步到 site/miniinfer/（CI 只克隆 site 所在的仓库，构建时读的是这个镜像）。
扫描所有讲里 CodeWalk / RunOutput 的 file、CodeDiff 的 a / b，缺的或和 ../miniinfer/ 不一致的就复制过来。
用法（在 site/ 目录下）：python3 scripts/sync_miniinfer.py"""
import filecmp, glob, os, re, shutil

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, DST = os.path.join(SITE, "..", "miniinfer"), os.path.join(SITE, "miniinfer")
refs = set()
for p in glob.glob(os.path.join(SITE, "src", "content", "lectures", "*.mdx")):
    s = open(p, encoding="utf-8").read()
    refs |= set(re.findall(r'<(?:CodeWalk|RunOutput)[^>]*?\bfile="([^"]+)"', s, re.S))
    for a, b in re.findall(r'<CodeDiff\s+a=(?:"([^"]+)"|\{null\})\s+b="([^"]+)"', s):
        refs |= {x for x in (a, b) if x}
copied, missing = [], []
for r in sorted(refs):
    src, dst = os.path.join(SRC, r), os.path.join(DST, r)
    if not os.path.exists(src):
        missing.append(r); continue
    if not os.path.exists(dst) or not filecmp.cmp(src, dst, shallow=False):
        os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst); copied.append(r)
print(f"文章引用了 {len(refs)} 个文件，同步了 {len(copied)} 个" + "".join(f"\n  {c}" for c in copied))
if missing:
    print("在 ../miniinfer/ 里找不到：" + "".join(f"\n  {m}" for m in missing))
