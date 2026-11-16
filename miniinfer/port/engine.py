"""移植版引擎：在 v1 的基础上，把设备从写死的 "cpu" 换成 device.py 挑出来的后端。"""
import torch
from tokenizers import Tokenizer
from config import Config
from weights import load_weights
from model import Qwen3
from kv_cache import KVCache
from device import pick_device, supports


class LLM:
    def __init__(self, model_dir, device=None, dtype=torch.float32):
        self.device = pick_device(device)
        if not supports(self.device, dtype):
            raise ValueError(f"{self.device.type} 不支持 {dtype}")
        self.cfg = Config.load(model_dir)
        self.tok = Tokenizer.from_file(f"{model_dir}/tokenizer.json")
        self.model = Qwen3(self.cfg, load_weights(model_dir, dtype, self.device))
        self.dtype = dtype

    def generate(self, prompt, max_new_tokens=32):
        ids = self.tok.encode(prompt).ids
        cache = KVCache(self.cfg, len(ids) + max_new_tokens, self.dtype, self.device)
        new = list(ids)                             # 第一步（prefill）送入整个提示
        for _ in range(max_new_tokens):
            start = len(ids) - len(new)
            logits = self.model.forward(torch.tensor(new, device=self.device), start, cache)
            nxt = int(logits[-1].argmax())          # 每步只在这里把一个数拷回 CPU
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
