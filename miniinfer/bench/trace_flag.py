"""第 120 讲：顺着一个配置项找到用它的代码。只在源码文本里搜索，不运行 vLLM。
用法：python bench/trace_flag.py long_prefill_token_threshold"""
import os, re, sys
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "third_party", "vllm")
flag = sys.argv[1]
hits = {}
for d, _, fs in os.walk(os.path.join(ROOT, "vllm")):
    for f in fs:
        if not f.endswith(".py"):
            continue
        p = os.path.join(d, f)
        for i, line in enumerate(open(p, encoding="utf-8"), 1):
            if re.search(rf"\b{flag}\b", line):
                hits.setdefault(os.path.relpath(p, ROOT), []).append((i, line.strip()))
print(f"“{flag}”出现在 {len(hits)} 个文件里，共 {sum(map(len, hits.values()))} 处：")
for p in sorted(hits, key=lambda p: (not p.startswith("vllm/config"), p)):
    lines = hits[p]
    print(f"\n{p}（{len(lines)} 处）")
    for i, l in lines[:4]:
        print(f"  {i:5d}  {l[:88]}")
    if len(lines) > 4:
        print(f"         …还有 {len(lines) - 4} 处")
