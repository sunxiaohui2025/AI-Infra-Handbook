"""v1：带 KV Cache 的生成。prefill 一次算完整个提示，之后每步只算一个新 token。"""
import torch
from tokenizers import Tokenizer
from config import Config
from weights import load_weights
from model import Qwen3
from kv_cache import KVCache


class LLM:
    def __init__(self, model_dir, device="cpu", dtype=torch.float32):
        self.cfg = Config.load(model_dir)
        self.tok = Tokenizer.from_file(f"{model_dir}/tokenizer.json")
        self.model = Qwen3(self.cfg, load_weights(model_dir, dtype, device))
        self.device, self.dtype = device, dtype

    def generate(self, prompt, max_new_tokens=32):
        ids = self.tok.encode(prompt).ids
        cache = KVCache(self.cfg, len(ids) + max_new_tokens, self.dtype, self.device)
        new = list(ids)                             # 第一步（prefill）送入整个提示
        for _ in range(max_new_tokens):
            logits = self.model.forward(torch.tensor(new, device=self.device), len(ids) - len(new), cache)
            nxt = int(logits[-1].argmax())          # 贪心：取打分最高的 token
            ids.append(nxt)
            new = [nxt]                             # 之后（decode）每步只送入刚生成的那一个
            if nxt == self.cfg.eos_token_id:
                break
        return ids

    def check_generate(self, prompts, max_new_tokens):
        # 给 tests/check.py 用：逐条生成，只返回新生成的 token
        outs = []
        for p in prompts:
            n = len(self.tok.encode(p).ids)
            outs.append(self.generate(p, max_new_tokens)[n:])
        return outs
