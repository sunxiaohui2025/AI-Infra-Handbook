"""v4：只量化权重的 INT8（W8A16 的思路）。每个输出通道（权重矩阵的每一行）一个 scale。"""
import torch


class QuantWeight:
    """一个线性层的 INT8 权重：q 是 [输出, 输入] 的 int8，scale 是每一行的缩放 [输出]。"""

    def __init__(self, w):
        amax = w.abs().amax(dim=1).clamp(min=1e-8)          # 每一行的最大绝对值
        self.scale = (amax / 127).float()                   # 对称量化：[-amax, amax] 映射到 [-127, 127]
        self.q = torch.round(w / self.scale[:, None]).clamp(-127, 127).to(torch.int8)

    def nbytes(self):
        return self.q.numel() + self.scale.numel() * 4


def linear(x, w):
    """y = x · Wᵀ。W 是量化权重时，先算 x · qᵀ，再按输出通道乘回 scale：(x·qᵀ)·scale = x·(q·scale)ᵀ。"""
    if isinstance(w, QuantWeight):
        return (x @ w.q.T.to(x.dtype)) * w.scale.to(x.dtype)
    return x @ w.T


LINEAR = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")


def quantize_model(w):
    """把每一层的 7 个线性层换成 INT8；嵌入表、归一化和输出层保持原样。返回量化前后线性层的字节数。"""
    before = after = 0
    for name in list(w):
        if name.endswith(".weight") and name.split(".")[-2] in LINEAR:
            before += w[name].numel() * w[name].element_size()
            w[name] = QuantWeight(w[name])
            after += w[name].nbytes()
    return before, after
