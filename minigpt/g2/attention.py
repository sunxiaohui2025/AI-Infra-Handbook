"""因果多头自注意力（第 54 讲）。

输入 x：[B, T, d]。H 个头，每个头的维度 hd = d / H。
一次矩阵乘同时算出所有头的 Q、K、V，再把 d 维拆成 H 个 hd 维，各头独立做注意力，最后拼回 d 维。
"""
import math

import torch
from torch import nn


class MultiHeadAttention(nn.Module):
    def __init__(self, d: int, H: int, T_max: int, dropout: float, qkv_bias: bool = False):
        super().__init__()
        assert d % H == 0, "d 必须能被头数整除"
        self.H, self.hd = H, d // H
        self.W_q = nn.Linear(d, d, bias=qkv_bias)   # 所有头的 W_q 并排放在一个 d × d 矩阵里
        self.W_k = nn.Linear(d, d, bias=qkv_bias)
        self.W_v = nn.Linear(d, d, bias=qkv_bias)
        self.out_proj = nn.Linear(d, d)             # 把各头的结果混合回 d 维
        self.dropout = nn.Dropout(dropout)
        # 上三角（不含对角线）为 True 的位置是“未来”，要屏蔽。register_buffer：跟着模型搬到 GPU，但不是参数
        self.register_buffer("mask", torch.triu(torch.ones(T_max, T_max, dtype=torch.bool), diagonal=1))

    def forward(self, x):
        B, T, d = x.shape
        # [B, T, d] → [B, T, H, hd] → [B, H, T, hd]：把头这一维提到前面，后面的矩阵乘对每个头分别做
        q = self.W_q(x).view(B, T, self.H, self.hd).transpose(1, 2)
        k = self.W_k(x).view(B, T, self.H, self.hd).transpose(1, 2)
        v = self.W_v(x).view(B, T, self.H, self.hd).transpose(1, 2)

        scores = q @ k.transpose(2, 3) / math.sqrt(self.hd)        # [B, H, T, T]
        scores = scores.masked_fill(self.mask[:T, :T], float("-inf"))  # 未来的位置打成 −∞
        w = torch.softmax(scores, dim=-1)                          # −∞ 经过 softmax 变成 0
        w = self.dropout(w)                                        # 训练时随机丢掉一部分注意力

        out = w @ v                                                # [B, H, T, hd]
        out = out.transpose(1, 2).contiguous().view(B, T, d)       # 拼回 [B, T, d]
        return self.out_proj(out)
