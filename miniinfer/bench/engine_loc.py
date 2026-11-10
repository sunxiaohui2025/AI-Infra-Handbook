"""第 16 篇：三个引擎关键文件的行数（不算空行）。只读源码文本，不运行这些引擎。
vLLM、SGLang 只取下了部分目录（git sparse-checkout），见 README。"""
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = os.path.join(ROOT, "third_party")


def loc(rel):
    p = os.path.join(T, rel)
    if os.path.isdir(p):
        return sum(loc(os.path.relpath(os.path.join(d, f), T)) for d, _, fs in os.walk(p) for f in fs if f.endswith(".py"))
    return sum(1 for l in open(p, encoding="utf-8") if l.strip())


ROWS = [
    ("调度器", "nano-vllm/nanovllm/engine/scheduler.py", "vllm/vllm/v1/core/sched/scheduler.py", "sglang/python/sglang/srt/managers/scheduler.py"),
    ("块 / 前缀缓存", "nano-vllm/nanovllm/engine/block_manager.py", "vllm/vllm/v1/core/block_pool.py", "sglang/python/sglang/srt/mem_cache/radix_cache.py"),
    ("请求状态", "nano-vllm/nanovllm/engine/sequence.py", "vllm/vllm/v1/request.py", "sglang/python/sglang/srt/managers/schedule_batch.py"),
    ("执行器", "nano-vllm/nanovllm/engine/model_runner.py", "vllm/vllm/v1/worker/gpu/model_runner.py", "sglang/python/sglang/srt/model_executor/model_runner.py"),
]
print(f"{'nano-vllm':>9}{'vLLM':>8}{'SGLang':>8}  文件")
for name, a, b, c in ROWS:
    print(f"{loc(a):>9}{loc(b):>8}{loc(c):>8}  {name}")
print()
print(f"vLLM vllm/v1/ 整个目录：{loc('vllm/vllm/v1')} 行")
print(f"SGLang srt/managers/ 整个目录：{loc('sglang/python/sglang/srt/managers')} 行")
print(f"nano-vllm 全部：{loc('nano-vllm/nanovllm')} 行")
