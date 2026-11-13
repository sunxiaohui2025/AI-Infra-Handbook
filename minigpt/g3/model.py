"""GPT 模型：嵌入 → N 个 Transformer Block → 最后的 LayerNorm → 输出层（第 55 讲）。

结构和 GPT-2 一样：Pre-Norm（先归一化再进注意力 / FFN），残差连接，GELU，学出来的位置嵌入。
"""
from dataclasses import dataclass

import torch
from torch import nn

from attention import MultiHeadAttention


@dataclass
class GPTConfig:
    V: int = 4096          # 词表大小
    T_max: int = 256       # 最长上下文
    d: int = 256           # 隐藏维度
    H: int = 4             # 注意力头数
    L: int = 4             # 层数
    dropout: float = 0.1
    qkv_bias: bool = False


class LayerNorm(nn.Module):
    def __init__(self, d: int, eps: float = 1e-5):
        super().__init__()
        self.eps = eps
        self.scale = nn.Parameter(torch.ones(d))    # γ，初始为 1
        self.shift = nn.Parameter(torch.zeros(d))   # β，初始为 0

    def forward(self, x):
        mean = x.mean(dim=-1, keepdim=True)
        var = x.var(dim=-1, keepdim=True, unbiased=False)   # 除以 d，不是 d − 1
        return self.scale * (x - mean) / torch.sqrt(var + self.eps) + self.shift


class GELU(nn.Module):
    """GPT-2 用的 tanh 近似。"""
    def forward(self, x):
        return 0.5 * x * (1 + torch.tanh((2 / torch.pi) ** 0.5 * (x + 0.044715 * x ** 3)))


class FeedForward(nn.Module):
    def __init__(self, d: int):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(d, 4 * d), GELU(), nn.Linear(4 * d, d))   # 升到 4d，再降回 d

    def forward(self, x):
        return self.net(x)


class TransformerBlock(nn.Module):
    def __init__(self, c: GPTConfig):
        super().__init__()
        self.norm1 = LayerNorm(c.d)
        self.att = MultiHeadAttention(c.d, c.H, c.T_max, c.dropout, c.qkv_bias)
        self.norm2 = LayerNorm(c.d)
        self.ff = FeedForward(c.d)
        self.drop = nn.Dropout(c.dropout)

    def forward(self, x):
        x = x + self.drop(self.att(self.norm1(x)))   # 残差 1：x + 注意力(归一化(x))
        x = x + self.drop(self.ff(self.norm2(x)))    # 残差 2：x + FFN(归一化(x))
        return x


class GPT(nn.Module):
    def __init__(self, c: GPTConfig):
        super().__init__()
        self.c = c
        self.tok_emb = nn.Embedding(c.V, c.d)
        self.pos_emb = nn.Embedding(c.T_max, c.d)
        self.drop = nn.Dropout(c.dropout)
        self.blocks = nn.Sequential(*[TransformerBlock(c) for _ in range(c.L)])
        self.final_norm = LayerNorm(c.d)
        self.out_head = nn.Linear(c.d, c.V, bias=False)

    def forward(self, idx):
        B, T = idx.shape
        assert T <= self.c.T_max, f"序列长 {T}，超过了上下文上限 {self.c.T_max}"
        x = self.tok_emb(idx) + self.pos_emb(torch.arange(T, device=idx.device))   # [B, T, d]
        x = self.drop(x)
        x = self.blocks(x)
        x = self.final_norm(x)
        return self.out_head(x)                      # [B, T, V]：每个位置对下一个 token 的打分（logits）
