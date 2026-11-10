"""v4：INT8 权重量化省了多少内存，打分变了多少，速度怎么样。"""
import sys, os, time, json
import torch
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "v4"))
from engine import LLM
from block_manager import KVPool, SeqKV

MODEL = os.path.join(ROOT, "models", "Qwen3-0.6B")
fp, q8 = LLM(MODEL, quant=False), LLM(MODEL, quant=True)
before, after = q8.weight_bytes
print(f"线性层权重：FP32 {before/2**20:.0f} MiB → INT8 {after/2**20:.0f} MiB（{before/after:.2f} 倍）")

# 逐步比较打分：两个模型喂同一串 token（FP32 模型自己生成的 128 个），看每一步的最高分 token 是否相同
text = "An inference engine turns a trained model into a service. It schedules requests, manages the KV cache,"
ids = fp.tok.encode(text).ids
ref = fp.generate([text], 128)[0]
seq = ids + ref
def step_logits(llm):
    pool = KVPool(llm.cfg, 64, 16)
    kv = SeqKV(pool, list(range(64)))
    out = []
    for p in range(len(ids) - 1, len(seq) - 1):
        toks = seq[:p + 1] if p == len(ids) - 1 else [seq[p]]
        start = 0 if p == len(ids) - 1 else p
        pos = torch.arange(start, p + 1)
        out.append(llm.model.forward(torch.tensor(toks), pos, [(0, len(toks), kv)])[0])
    return torch.stack(out)
a, b = step_logits(fp), step_logits(q8)
agree = (a.argmax(-1) == b.argmax(-1)).float().mean()
kl = torch.nn.functional.kl_div(b.log_softmax(-1), a.log_softmax(-1), log_target=True, reduction="none").sum(-1).mean()
print(f"128 步里最高分 token 相同的比例 {agree:.1%}，平均 KL 散度 {kl:.4f}")

# 速度：单个请求 decode 64 个 token
for name, llm in [("FP32", fp), ("INT8", q8)]:
    llm.cfg.eos_token_id = -1
    llm.generate([text], 4)
    t = time.perf_counter(); llm.generate([text], 64); dt = time.perf_counter() - t
    print(f"{name}：单请求生成 64 个 token 用时 {dt:.2f} s")
