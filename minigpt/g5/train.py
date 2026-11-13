"""在讲义语料上预训练，加上存档、续训和按验证集挑最好的存档（第 57 讲）。
用法：python g5/train.py [--steps 3000] [--resume checkpoints/gpt.pt]
每 eval_every 步估一次 loss，记到 outputs/train_log_<out>.json；验证 loss 创新低时存 checkpoints/<out>_best.pt，训练完存 checkpoints/<out>.pt。"""
import argparse
import json
import math
import os
import time

import torch
import torch.nn.functional as F

import checkpoint
from data import load_corpus, make_loader
from generate import generate_greedy
from model import GPT, GPTConfig

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def pick_device():
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():       # Apple 芯片的 GPU
        return "mps"
    return "cpu"


def loss_batch(model, x, y):
    logits = model(x)                                         # [B, T, V]
    # 交叉熵要的形状是 [N, V] 和 [N]：把 B、T 两维摊平，B·T 个位置各算一个 loss，再取平均
    return F.cross_entropy(logits.flatten(0, 1), y.flatten())


@torch.no_grad()
def estimate_loss(model, loader, device, n_batches):
    model.eval()                                              # 关掉 dropout
    total, n = 0.0, 0
    for i, (x, y) in enumerate(loader):
        if i >= n_batches:
            break
        total += loss_batch(model, x.to(device), y.to(device)).item()
        n += 1
    model.train()
    return total / n


def lr_at(step, total, peak, warmup):
    if step < warmup:                                         # 预热：从 0 线性升到峰值
        return peak * (step + 1) / warmup
    p = (step - warmup) / max(1, total - warmup)              # 余弦退火：从峰值降到峰值的 10%
    return peak * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * p)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--warmup", type=int, default=100)
    ap.add_argument("--eval_every", type=int, default=100)
    ap.add_argument("--dropout", type=float, default=0.1)
    ap.add_argument("--out", default="gpt")
    ap.add_argument("--resume", default=None, help="从这个存档接着训练")
    a = ap.parse_args()

    torch.manual_seed(123)
    device = pick_device()
    c = GPTConfig(dropout=a.dropout)
    tok, train_ids, val_ids = load_corpus()
    assert len(tok) == c.V
    # 训练集：窗口一半重叠（stride = T/2），样本多一倍；验证集：不重叠、不打乱
    train_loader = make_loader(train_ids, c.T_max, c.T_max // 2, a.batch, shuffle=True)
    val_loader = make_loader(val_ids, c.T_max, c.T_max, a.batch, shuffle=False)

    os.makedirs(os.path.join(ROOT, "checkpoints"), exist_ok=True)
    model = GPT(c).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.1)
    log, step, seen = [], 0, 0
    if a.resume:                                              # 续训：参数、优化器状态、步数、日志都接上
        model, ck = checkpoint.load(os.path.join(ROOT, a.resume), device)
        opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.1)
        opt.load_state_dict(ck["optimizer"])
        log, step, seen = ck["log"], ck["step"], ck["seen"]
        print(f"从 {a.resume} 接着训练：已经训练了 {step} 步")
    print(f"设备 {device}，参数 {sum(p.numel() for p in model.parameters()):,}；"
          f"训练集每轮 {len(train_loader)} 个 batch，每个 batch {a.batch} × {c.T_max} = {a.batch * c.T_max:,} 个 token")

    prompt = torch.tensor([tok.encode("KV Cache")], device=device)
    best, t0 = min((r["val"] for r in log), default=float("inf")), time.time()
    while step < a.steps:
        for x, y in train_loader:
            if step >= a.steps:
                break
            for g in opt.param_groups:
                g["lr"] = lr_at(step, a.steps, a.lr, a.warmup)
            x, y = x.to(device), y.to(device)
            loss = loss_batch(model, x, y)
            opt.zero_grad()
            loss.backward()                                   # 反向传播：算出每个参数的梯度
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)   # 梯度总长度超过 1 就等比缩小
            opt.step()                                        # 按梯度更新参数
            step += 1
            seen += x.numel()
            if step % a.eval_every == 0 or step == 1:
                tr = estimate_loss(model, train_loader, device, 20)
                va = estimate_loss(model, val_loader, device, 20)
                log.append({"step": step, "tokens": seen, "train": round(tr, 4), "val": round(va, 4),
                            "lr": opt.param_groups[0]["lr"]})
                if va < best:                                 # 验证 loss 创新低：存一份“最好的”
                    best = va
                    checkpoint.save(os.path.join(ROOT, "checkpoints", f"{a.out}_best.pt"), model, opt,
                                    step=step, seen=seen, log=log)
                print(f"step {step:>5}  已看 {seen / 1e6:5.2f} M token  训练 loss {tr:.3f}  验证 loss {va:.3f}"
                      f"  ({time.time() - t0:.0f} s)")
                if step % (a.eval_every * 10) == 0:
                    model.eval()
                    s = tok.decode(generate_greedy(model, prompt, 30)[0].tolist())
                    model.train()
                    print("    样例：" + s.replace("\n", " "))
    checkpoint.save(os.path.join(ROOT, "checkpoints", f"{a.out}.pt"), model, opt, step=step, seen=seen, log=log)
    json.dump(log, open(os.path.join(ROOT, "outputs", f"train_log_{a.out}.json"), "w"), indent=0)
    best = min(log, key=lambda r: r["val"])
    print(f"用时 {time.time() - t0:.0f} s。验证 loss 最低 {best['val']:.3f}（第 {best['step']} 步），"
          f"最后 {log[-1]['val']:.3f}；存到 checkpoints/{a.out}.pt")


if __name__ == "__main__":
    main()
