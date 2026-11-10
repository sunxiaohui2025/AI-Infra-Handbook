import sys, time
from engine import LLM

llm = LLM("../models/Qwen3-0.6B")
prompt = "The capital of France is"
for n in [8, 32]:
    t = time.perf_counter()
    ids = llm.generate(prompt, max_new_tokens=n)
    dt = time.perf_counter() - t
    print(f"生成 {n} 个 token：{dt:.2f} s，平均每个 {dt / n * 1000:.0f} ms")
print(repr(llm.tok.decode(ids)))
