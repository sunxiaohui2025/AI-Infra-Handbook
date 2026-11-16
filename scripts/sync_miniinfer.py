"""把文章里引用到的 miniinfer、minigpt 文件同步到 site/miniinfer/、site/minigpt/（CI 只克隆 site 所在的仓库，构建时读的是镜像）。
扫描所有讲里 CodeWalk / RunOutput 的 file、CodeDiff 的 a / b，缺的或和 ../miniinfer/、../minigpt/ 不一致的就复制过来。
以 minigpt/ 开头的路径对应第 7 篇的 minigpt 仓库，其余对应 miniinfer。
用法（在 site/ 目录下）：python3 scripts/sync_miniinfer.py"""
import filecmp, glob, os, re, shutil

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, DST = os.path.join(SITE, "..", "miniinfer"), os.path.join(SITE, "miniinfer")
refs = set()
for p in glob.glob(os.path.join(SITE, "src", "content", "lectures", "*.mdx")):
    s = open(p, encoding="utf-8").read()
    refs |= set(re.findall(r'<(?:CodeWalk|RunOutput|StepTrace|DecodeView|LayerDrift)[^>]*?\bfile="([^"]+)"', s, re.S))
    refs |= set(re.findall(r"\bfile:\s*'(minigpt/[^']+)'", s))          # TrainCurve 的 runs
    for a, b in re.findall(r'<CodeDiff\s+a=(?:"([^"]+)"|\{null\})\s+b="([^"]+)"', s):
        refs |= {x for x in (a, b) if x}
for p in glob.glob(os.path.join(SITE, "src", "components", "*.astro")):   # 组件里写死的文件
    refs |= set(re.findall(r"readMini\('([^']+)'\)", open(p, encoding="utf-8").read()))
copied, missing = [], []
for r in sorted(refs):
    if r.startswith("minigpt/"):
        src, dst = os.path.join(SITE, "..", r), os.path.join(SITE, r)
    else:
        src, dst = os.path.join(SRC, r), os.path.join(DST, r)
    if not os.path.exists(src):
        missing.append(r); continue
    if not os.path.exists(dst) or not filecmp.cmp(src, dst, shallow=False):
        os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst); copied.append(r)
print(f"文章引用了 {len(refs)} 个文件，同步了 {len(copied)} 个" + "".join(f"\n  {c}" for c in copied))
if missing:
    print("源目录里找不到：" + "".join(f"\n  {m}" for m in missing))
