"""v2：16 个请求同时到达，输出长度各不相同。比较一个一个跑、静态批处理、continuous batching。"""
import sys, os, time, random, json
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, sys.argv[1] if len(sys.argv) > 1 else "v2"))
from engine import LLM

random.seed(0)
TOPICS = ["GPU memory", "KV cache", "batching", "attention", "quantization", "scheduling", "tokenizers", "sampling"]
prompts = [f"Write a short note about {TOPICS[i % 8]} for request {i}." for i in range(16)]
lens = [random.choice([8, 16, 32, 64, 96]) for _ in range(16)]
print("输出长度：", lens, "共", sum(lens), "个 token")

traces = {}
for name, args in [("一个一个跑", dict(max_num_seqs=1)),
                   ("静态批处理（8 个一批）", dict(max_num_seqs=8, static=True)),
                   ("continuous batching（8 个槽）", dict(max_num_seqs=8))]:
    llm = LLM(os.path.join(ROOT, "models", "Qwen3-0.6B"), **args)
    llm.cfg.eos_token_id = -1                         # 压测时不让请求提前结束，保证每次生成同样多的 token
    llm.generate(prompts[:2], 2); llm.log.clear()     # 预热
    trace, sched = [], llm.scheduler.schedule
    def traced():                                      # 记下每一步 batch 里有哪些请求、各自是 prefill 还是 decode
        b = sched()
        trace.append([[s.id, int(s.num_computed == 0)] for s in b])
        return b
    llm.scheduler.schedule = traced
    t = time.perf_counter()
    llm.generate(prompts, lens)
    dt = time.perf_counter() - t
    steps = len(llm.log)
    avg = sum(p + d for p, d in llm.log) / steps
    base = min(i for step in trace for i, _ in step)   # 请求编号换成 0–15
    traces[name] = [[[i - base, p] for i, p in step] for step in trace]
    print(f"{name}：{dt:5.1f} s，{sum(lens)/dt:5.1f} token/s，{steps} 步，平均每步 {avg:.1f} 个请求")
json.dump({"lens": lens, "runs": traces}, open(os.path.join(ROOT, "outputs", "batching_steps.json"), "w"), ensure_ascii=False)
