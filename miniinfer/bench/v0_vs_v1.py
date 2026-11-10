"""比较 v0（每步重算）和 v1（KV Cache）：同一个 200 token 左右的提示，生成 64 个 token，记录每一步的耗时。"""
import sys, time, importlib, os
import torch
torch.manual_seed(0)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPT = "An inference engine turns a trained model into a service. " * 18


def load(ver):
    for m in ["engine", "model", "kv_cache", "config", "weights"]:
        sys.modules.pop(m, None)
    sys.path.insert(0, os.path.join(ROOT, ver))
    mod = importlib.import_module("engine")
    sys.path.pop(0)
    return mod.LLM(os.path.join(ROOT, "models", "Qwen3-0.6B"))


def step_times(llm, n):
    # 把 generate 拆开计时：给模型包一层，记录每次 forward 的耗时
    times, fwd = [], llm.model.forward
    def timed(*a):
        t = time.perf_counter(); out = fwd(*a); times.append(time.perf_counter() - t); return out
    llm.model.forward = timed
    llm.generate(PROMPT, n)
    llm.model.forward = fwd
    return times


for ver in ["v0", "v1"]:
    llm = load(ver)
    print(f"{ver}：提示 {len(llm.tok.encode(PROMPT).ids)} 个 token")
    step_times(llm, 2)                                  # 预热
    t = step_times(llm, 64)
    print(f"  第 1 步 {t[0]*1e3:6.0f} ms，第 2 步 {t[1]*1e3:6.0f} ms，第 64 步 {t[63]*1e3:6.0f} ms，64 步共 {sum(t):5.2f} s")
