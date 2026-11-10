"""v0：没有 KV Cache 的生成。每生成一个 token，都把整段序列从头算一遍。"""
import torch
from tokenizers import Tokenizer
from config import Config
from weights import load_weights
from model import Qwen3


class LLM:
    def __init__(self, model_dir, device="cpu", dtype=torch.float32):
        self.cfg = Config.load(model_dir)
        self.tok = Tokenizer.from_file(f"{model_dir}/tokenizer.json")
        self.model = Qwen3(self.cfg, load_weights(model_dir, dtype, device))
        self.device = device

    def generate(self, prompt, max_new_tokens=32):
        ids = self.tok.encode(prompt).ids
        for _ in range(max_new_tokens):
            logits = self.model.forward(torch.tensor(ids, device=self.device))
            nxt = int(logits[-1].argmax())          # 贪心：取最后一个位置打分最高的 token
            ids.append(nxt)
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
