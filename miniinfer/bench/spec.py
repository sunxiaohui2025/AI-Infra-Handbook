"""v5：n-gram 投机解码。两类请求：要照抄大段输入的（改写代码），和自由生成的（写一段说明）。"""
import sys, os, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "v5"))
from engine import LLM

CODE = '''def moving_average(values, window):
    result = []
    total = 0.0
    for i, v in enumerate(values):
        total += v
        if i >= window:
            total -= values[i - window]
        if i >= window - 1:
            result.append(total / window)
    return result
'''
cases = {"改写代码（大量照抄）": "Add type hints to this function and keep everything else the same:\n\n" + CODE + "\nAnswer:\n\n",
         "自由生成": "Explain in a few sentences why large language models need a KV cache."}
MODEL = os.path.join(ROOT, "models", "Qwen3-0.6B")
for name, prompt in cases.items():
    res = {}
    for k in [0, 4]:
        llm = LLM(MODEL, num_draft=k, max_num_seqs=1)
        llm.cfg.eos_token_id = -1
        llm.generate([prompt], 4); llm.log.clear(); llm.num_accepted = 0
        t = time.perf_counter()
        out = llm.generate([prompt], 128)[0]
        dt = time.perf_counter() - t
        res[k] = out
        steps = len(llm.log) - 1                    # 去掉 prefill 那一步
        print(f"{name}，草稿 {k} 个：128 个 token 用了 {steps} 步 decode，接受草稿 {llm.num_accepted} 个，"
              f"平均每次前向 {128 / (steps + 1):.2f} 个 token，用时 {dt:.1f} s")
    print(f"  两种方式的输出完全一致：{res[0] == res[4]}")
