"""把一长串 token 切成训练样本（第 53 讲）。

语言模型的一个样本是一对等长的序列：输入 x = 第 i 到 i+T−1 个 token，
目标 y = 第 i+1 到 i+T 个 token，也就是 x 整体往后错一位。模型在每个位置都预测“下一个”。
"""
import os

import torch
from torch.utils.data import DataLoader, Dataset

from tokenizer import Tokenizer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


class GPTDataset(Dataset):
    def __init__(self, ids: list[int], T: int, stride: int):
        self.ids = torch.tensor(ids, dtype=torch.long)
        self.T = T
        # 窗口的起点：0, stride, 2·stride, …，最后一个窗口还要多留 1 个 token 给 y
        self.starts = list(range(0, len(ids) - T, stride))

    def __len__(self):
        return len(self.starts)

    def __getitem__(self, k):
        i = self.starts[k]
        chunk = self.ids[i : i + self.T + 1]       # 取 T+1 个
        return chunk[:-1], chunk[1:]               # x 是前 T 个，y 是后 T 个


def load_corpus(val_frac: float = 0.1):
    """读语料、分词，按字符把最后 10% 切成验证集（和训练分词器时一致）。"""
    text = open(os.path.join(ROOT, "data", "corpus.txt"), encoding="utf-8").read()
    tok = Tokenizer.load(os.path.join(ROOT, "data", "tokenizer.json"))
    n_val = int(len(text) * val_frac)
    return tok, tok.encode(text[:-n_val]), tok.encode(text[-n_val:])


def make_loader(ids, T, stride, batch_size, shuffle, seed=0):
    g = torch.Generator().manual_seed(seed)        # 固定打乱的顺序，结果可以复现
    return DataLoader(GPTDataset(ids, T, stride), batch_size=batch_size, shuffle=shuffle,
                      drop_last=shuffle, generator=g)
