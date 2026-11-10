"""复盘：v5 的时间花在哪里。8 个请求一起 decode，把一步拆成：线性层与其他张量运算、注意力、Python 侧的调度与拼 batch。"""
import sys, os, time
import torch
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "v5"))
from engine import LLM

llm = LLM(os.path.join(ROOT, "models", "Qwen3-0.6B"), num_draft=0, max_num_seqs=8)
llm.cfg.eos_token_id = -1
prompts = [f"Write a short note about topic number {i}." for i in range(8)]
acc = {"forward": 0.0, "attend": 0.0}
fwd, att = llm.model.forward, llm.model.attend
def t_fwd(*a, **k):
    t = time.perf_counter(); r = fwd(*a, **k); acc["forward"] += time.perf_counter() - t; return r
def t_att(*a, **k):
    t = time.perf_counter(); r = att(*a, **k); acc["attend"] += time.perf_counter() - t; return r
llm.model.forward, llm.model.attend = t_fwd, t_att
llm.generate(prompts, 4)
acc = dict.fromkeys(acc, 0.0); llm.log.clear()
t = time.perf_counter()
llm.generate(prompts, 64)
total = time.perf_counter() - t
other = total - acc["forward"]
lin = acc["forward"] - acc["attend"]
print(f"8 个请求各生成 64 个 token：共 {total:.1f} s，{len(llm.log)} 步")
print(f"  注意力（每个请求单独算，含读写 KV）：{acc['attend']:.1f} s（{acc['attend']/total:.0%}）")
print(f"  线性层、归一化等其余张量运算：{lin:.1f} s（{lin/total:.0%}）")
print(f"  Python 侧：调度、拼 batch、采样：{other*1e3:.0f} ms（{other/total:.1%}）")

# 对照：HuggingFace transformers 自带的 generate，同一台机器、同样 FP32、单请求 64 个 token
from transformers import AutoModelForCausalLM, AutoTokenizer
tok = AutoTokenizer.from_pretrained(os.path.join(ROOT, "models", "Qwen3-0.6B"))
hf = AutoModelForCausalLM.from_pretrained(os.path.join(ROOT, "models", "Qwen3-0.6B"), dtype=torch.float32).eval()
ids = tok(prompts[0], return_tensors="pt").input_ids
hf.generate(ids, max_new_tokens=4, do_sample=False)
t = time.perf_counter(); hf.generate(ids, max_new_tokens=64, min_new_tokens=64, do_sample=False); dt_hf = time.perf_counter() - t
llm2 = LLM(os.path.join(ROOT, "models", "Qwen3-0.6B"), num_draft=0, max_num_seqs=1); llm2.cfg.eos_token_id = -1
llm2.generate(prompts[:1], 4)
t = time.perf_counter(); llm2.generate(prompts[:1], 64); dt_me = time.perf_counter() - t
print(f"单请求 64 个 token：HuggingFace {dt_hf:.2f} s，miniinfer v5 {dt_me:.2f} s")
