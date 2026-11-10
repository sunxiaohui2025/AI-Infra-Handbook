"""v1：一个请求一份连续的 KV Cache。按最大长度一次分配好，生成时往后追加。"""
import torch


class KVCache:
    def __init__(self, cfg, max_len, dtype=torch.float32, device="cpu"):
        shape = (cfg.num_layers, max_len, cfg.num_kv_heads, cfg.head_dim)
        self.k = torch.zeros(shape, dtype=dtype, device=device)
        self.v = torch.zeros(shape, dtype=dtype, device=device)

    def write(self, layer, pos, k, v):
        # pos: 这次新 token 的位置 [T]；k、v: [T, KV 头数, head_dim]
        self.k[layer, pos] = k
        self.v[layer, pos] = v

    def read(self, layer, end):
        # 读出前 end 个位置的全部 K、V，给注意力用
        return self.k[layer, :end], self.v[layer, :end]
