"""Qwen3-0.6B 的 KV Cache 有多大：每个 token、每个请求。"""
import sys, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "v1"))
from config import Config

c = Config.load(os.path.join(ROOT, "models", "Qwen3-0.6B"))
for name, b in [("FP32", 4), ("BF16", 2)]:
    per = 2 * c.num_layers * c.num_kv_heads * c.head_dim * b      # K 和 V，每层，每个 KV 头
    print(f"{name}：每个 token {per // 1024} KiB；一个 2048 token 的请求 {per * 2048 / 2**20:.0f} MiB")
