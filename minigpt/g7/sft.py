"""指令微调：在预训练好的模型上，用“指令 → 回答”的数据接着训练（第 59 讲）。
用法：python g7/sft.py [--ckpt checkpoints/gpt_best.pt] [--epochs 20] [--lr 5e-4]"""
import argparse
import json
import os
import time

import torch
import torch.nn.functional as F

import checkpoint
from generate import generate
from train import pick_device
from tokenizer import Tokenizer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
IGNORE = -100            # F.cross_entropy 会跳过目标等于 −100 的位置


def prompt_of(instruction: str) -> str:
    return f"### 指令：\n{instruction}\n\n### 回答：\n"


def encode_example(tok, ex):
    """返回整条序列的编号，以及回答从第几个 token 开始。"""
    p = tok.encode(prompt_of(ex["instruction"]))
    a = tok.encode(ex["output"]) + [tok.eot]          # 回答后面接结束符，模型要学会“说完了就停”
    return p + a, len(p)


def collate(batch, pad_id):
    """batch：[(ids, n_prompt), ...]。补齐到同一长度，并做出 x、y。"""
    L = max(len(ids) for ids, _ in batch)
    xs, ys = [], []
    for ids, n_prompt in batch:
        n = len(ids)
        ids = ids + [pad_id] * (L - n)
        x = torch.tensor(ids[:-1])
        y = torch.tensor(ids[1:])                     # y[t] 是第 t+1 个 token
        y[: n_prompt - 1] = IGNORE                    # 目标还落在指令里的位置不算 loss
        y[n - 1 :] = IGNORE                           # 补齐用的位置也不算
        xs.append(x); ys.append(y)
    return torch.stack(xs), torch.stack(ys)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="checkpoints/gpt_best.pt")
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=5e-4)
    a = ap.parse_args()

    torch.manual_seed(123)
    device = pick_device()
    tok = Tokenizer.load(os.path.join(ROOT, "data", "tokenizer.json"))
    data = json.load(open(os.path.join(ROOT, "data", "sft.json"), encoding="utf-8"))
    model, _ = checkpoint.load(os.path.join(ROOT, a.ckpt), device)
    train = [encode_example(tok, ex) for ex in data["train"]]
    print(f"训练 {len(train)} 条，最长 {max(len(i) for i, _ in train)} 个 token；测试 {len(data['test'])} 条")

    def answer(ex):
        ids = torch.tensor([tok.encode(prompt_of(ex["instruction"]))], device=device)
        out = generate(model, ids, 30, temperature=0, eos=tok.eot)[0, ids.shape[1]:].tolist()
        if tok.eot in out:
            out = out[: out.index(tok.eot)]
        return tok.decode(out).strip().replace("\n", " ")

    model.eval()
    before = [answer(ex) for ex in data["test"][:6]]

    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.1)
    model.train()
    t0, g = time.time(), torch.Generator().manual_seed(0)
    for ep in range(a.epochs):
        order = torch.randperm(len(train), generator=g).tolist()
        total, n = 0.0, 0
        for i in range(0, len(order), a.batch):
            x, y = collate([train[j] for j in order[i : i + a.batch]], tok.eot)
            x, y = x.to(device), y.to(device)
            loss = F.cross_entropy(model(x).flatten(0, 1), y.flatten(), ignore_index=IGNORE)
            opt.zero_grad(); loss.backward(); opt.step()
            total += loss.item(); n += 1
        print(f"第 {ep + 1} 轮  平均 loss {total / n:.3f}  ({time.time() - t0:.0f} s)")

    model.eval()
    print("\n测试集（这些讲的题都没进训练集），贪心解码：")
    for ex, b in zip(data["test"][:6], before):
        print(f"指令：{ex['instruction']}\n  标准答案：{ex['output']}\n  微调前：{b[:40]}\n  微调后：{answer(ex)}")
    for split in ("train", "test"):
        exs = data[split]
        hit = sum(answer(ex) == ex["output"] for ex in exs)
        print(f"{'训练集' if split == 'train' else '测试集'}：{hit}/{len(exs)} 条和标准答案一字不差")
    print("训练集里的两条：")
    for ex in data["train"][:2]:
        print(f"指令：{ex['instruction']}\n  标准答案：{ex['output']}\n  微调后：{answer(ex)}")
    checkpoint.save(os.path.join(ROOT, "checkpoints", "gpt_sft.pt"), model)


if __name__ == "__main__":
    main()
