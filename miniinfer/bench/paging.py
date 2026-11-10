"""v3：同样只有 320 个位置的 KV 空间，比较 v2（按最大长度整份预留）和 v3（按块按需分配）。"""
import sys, os, time, random, importlib
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, "models", "Qwen3-0.6B")


def load(ver, **kw):
    for m in ["engine", "model", "kv_cache", "config", "weights", "sequence", "scheduler", "block_manager"]:
        sys.modules.pop(m, None)
    sys.path.insert(0, os.path.join(ROOT, ver))
    llm = importlib.import_module("engine").LLM(MODEL, **kw)
    sys.path.pop(0)
    llm.cfg.eos_token_id = -1
    return llm


random.seed(0)
TOPICS = ["GPU memory", "KV cache", "batching", "attention", "quantization", "scheduling", "tokenizers", "sampling"]
prompts = [f"Write a short note about {TOPICS[i % 8]} for request {i}." for i in range(16)]
lens = [random.choice([8, 16, 32, 64, 96]) for _ in range(16)]
SLOTS = 320

for name, ver, kw in [("v2 整份预留", "v2", dict(max_num_seqs=8, kv_budget=SLOTS)),
                      ("v3 按块分配", "v3", dict(max_num_seqs=8, num_blocks=SLOTS // 16, block_size=16))]:
    llm = load(ver, **kw)
    t = time.perf_counter()
    llm.generate(prompts, lens)
    dt = time.perf_counter() - t
    avg = sum(p + d for p, d in llm.log) / len(llm.log)
    extra = f"，抢占 {llm.scheduler.num_preempted} 次" if ver == "v3" else ""
    print(f"{name}：{dt:5.1f} s，{sum(lens)/dt:5.1f} token/s，{len(llm.log)} 步，平均每步 {avg:.1f} 个请求{extra}")
