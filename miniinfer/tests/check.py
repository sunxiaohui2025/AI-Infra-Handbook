"""python tests/check.py v1 —— 用某个版本的引擎做贪心生成，和 HuggingFace 的结果逐 token 比对。"""
import json, sys, os
ver = sys.argv[1]
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ver))
from engine import LLM

ref = json.load(open(os.path.join(os.path.dirname(__file__), "hf_ref.json")))
llm = LLM(os.path.join(os.path.dirname(__file__), "..", "models", "Qwen3-0.6B"), **({} if len(sys.argv) < 3 else eval(sys.argv[2])))
outs = llm.check_generate([r["prompt"] for r in ref], 32)
ok = 0
for r, o in zip(ref, outs):
    same = o[:len(r["output_ids"])] == r["output_ids"]
    ok += same
    print(f"{'一致' if same else '不一致'}：{r['prompt']!r} → {llm.tok.decode(o)!r}")
n_pre = getattr(getattr(llm, "scheduler", None), "num_preempted", 0)
if n_pre:
    print(f"运行中发生了 {n_pre} 次抢占")
print(f"{ver}：{ok}/{len(ref)} 条与 HuggingFace 逐 token 一致")
