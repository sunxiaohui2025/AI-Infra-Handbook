"""第 116 讲：把投机解码移植进 nano-vllm，每个文件改了多少行。只比较源码文本，不运行 nano-vllm。"""
import difflib, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = os.path.join(ROOT, "third_party", "nano-vllm", "nanovllm")
B = os.path.join(ROOT, "nano_spec", "nanovllm")
files = sorted(os.path.relpath(os.path.join(d, f), B) for d, _, fs in os.walk(B) for f in fs if f.endswith(".py"))
ta = tr = 0
for f in files:
    a = open(os.path.join(A, f)).read().splitlines() if os.path.exists(os.path.join(A, f)) else []
    b = open(os.path.join(B, f)).read().splitlines()
    d = list(difflib.unified_diff(a, b, lineterm="", n=0))
    add = sum(1 for l in d if l.startswith("+") and not l.startswith("+++"))
    rm = sum(1 for l in d if l.startswith("-") and not l.startswith("---"))
    ta, tr = ta + add, tr + rm
    print(f"{'+' + str(add):>5} {'-' + str(rm):>4}  {f}{'（新文件）' if not a else ''}")
print(f"{'+' + str(ta):>5} {'-' + str(tr):>4}  合计 {len(files)} 个文件")
