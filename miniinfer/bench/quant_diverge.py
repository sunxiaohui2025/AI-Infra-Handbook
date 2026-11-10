"""v4：量化后和 HuggingFace 不一致的那条，从第几个 token 开始不同。"""
import sys, os, json
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "v4"))
from engine import LLM

ref = json.load(open(os.path.join(ROOT, "tests", "hf_ref.json")))
llm = LLM(os.path.join(ROOT, "models", "Qwen3-0.6B"), quant=True)
outs = llm.generate([r["prompt"] for r in ref], 32)
for r, o in zip(ref, outs):
    k = next((i for i, (a, b) in enumerate(zip(o, r["output_ids"])) if a != b), None)
    if k is None:
        print(f"{r['prompt']!r}：32 个 token 全部相同")
    else:
        print(f"{r['prompt']!r}：前 {k} 个 token 相同，第 {k + 1} 个开始不同"
              f"（HuggingFace {llm.tok.decode(r['output_ids'][k:k + 3])!r}，INT8 {llm.tok.decode(o[k:k + 3])!r}）")
