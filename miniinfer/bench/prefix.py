"""v3 的前缀缓存：8 个请求共用一段很长的系统提示。先跑第 1 个，再一起跑后 7 个，比较缓存打开和关闭。"""
import sys, os, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "v3"))
from engine import LLM

SYSTEM = "You are a helpful assistant for an AI infrastructure course. " * 30
qs = ["What is a KV cache?", "Why batch requests?", "What is paging?", "What is quantization?",
      "What is speculative decoding?", "What is a scheduler?", "What is prefill?", "What is decode?"]
prompts = [SYSTEM + "Question: " + q for q in qs]
results = {}
for on in [False, True]:
    llm = LLM(os.path.join(ROOT, "models", "Qwen3-0.6B"), prefix_cache=on, max_num_seqs=8, num_blocks=512)
    first = llm.generate(prompts[:1], 8)               # 第 1 个请求跑完，它的提示块留在块池里
    llm.scheduler.num_cached = 0
    t = time.perf_counter()
    rest = llm.generate(prompts[1:], 8)
    dt = time.perf_counter() - t
    total = sum(len(llm.tok.encode(p).ids) for p in prompts[1:])
    results[on] = first + rest
    print(f"前缀缓存{'打开' if on else '关闭'}：后 7 个请求的提示共 {total} 个 token，"
          f"命中 {llm.scheduler.num_cached} 个，实际 prefill {total - llm.scheduler.num_cached} 个，用时 {dt:.1f} s")
print("两种情况的输出完全一致：", results[False] == results[True])
