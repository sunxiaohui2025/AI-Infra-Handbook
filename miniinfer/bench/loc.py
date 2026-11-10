"""每个版本有多少行代码（不算空行和 run.py），每个文件各多少行。"""
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for v in ["v0", "v1", "v2", "v3", "v4", "v5"]:
    files = sorted(f for f in os.listdir(os.path.join(ROOT, v)) if f.endswith(".py") and f != "run.py")
    n = {f: sum(1 for l in open(os.path.join(ROOT, v, f), encoding="utf-8") if l.strip()) for f in files}
    print(f"{v}：{sum(n.values()):3d} 行  " + "  ".join(f"{f} {k}" for f, k in n.items()))
