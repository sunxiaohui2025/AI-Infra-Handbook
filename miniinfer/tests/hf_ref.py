"""用 HuggingFace transformers 生成参考答案（贪心），存成 JSON，各版本的测试都和它比。"""
import json, torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = "models/Qwen3-0.6B"
PROMPTS = ["The capital of France is",
           "def fibonacci(n):",
           "一个推理引擎由哪几部分组成？",
           "1, 2, 3, 4, 5,"]
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32).eval()
ref = []
for p in PROMPTS:
    ids = tok(p, return_tensors="pt").input_ids
    out = model.generate(ids, max_new_tokens=32, do_sample=False)
    ref.append({"prompt": p, "prompt_ids": ids[0].tolist(), "output_ids": out[0, ids.shape[1]:].tolist()})
json.dump(ref, open("tests/hf_ref.json", "w"), ensure_ascii=False)
print("参考答案已生成：", [len(r["output_ids"]) for r in ref])
