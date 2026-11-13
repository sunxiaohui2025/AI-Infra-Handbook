"""自回归生成，加上温度、Top-k、Top-p 和结束符（第 57 讲）。"""
import torch


@torch.no_grad()
def generate_greedy(model, idx, max_new: int):
    """idx：[B, T] 的编号。贪心：每步取打分最高的 token。"""
    for _ in range(max_new):
        ctx = idx[:, -model.c.T_max:]            # 超过上下文上限时，只保留最后 T_max 个
        logits = model(ctx)[:, -1, :]            # [B, V]：只要最后一个位置
        nxt = logits.argmax(dim=-1, keepdim=True)
        idx = torch.cat([idx, nxt], dim=1)
    return idx


def filter_logits(logits, temperature=1.0, top_k=None, top_p=None):
    """logits：[B, V]。返回处理过的 logits，被去掉的候选设成 −∞。"""
    logits = logits / temperature                # 温度 < 1 拉大差距，> 1 抹平差距
    if top_k is not None:
        kth = torch.topk(logits, top_k, dim=-1).values[:, -1:]          # 第 k 大的分数
        logits = logits.masked_fill(logits < kth, float("-inf"))
    if top_p is not None:
        srt, order = torch.sort(logits, descending=True, dim=-1)
        cum = torch.softmax(srt, dim=-1).cumsum(dim=-1)
        drop = cum - torch.softmax(srt, dim=-1) >= top_p                # 前面的累计概率已经够 p 了
        srt = srt.masked_fill(drop, float("-inf"))
        logits = torch.full_like(logits, float("-inf")).scatter(-1, order, srt)   # 按原来的顺序放回去
    return logits


@torch.no_grad()
def generate(model, idx, max_new: int, temperature=1.0, top_k=None, top_p=None, eos=None, seed=None):
    g = torch.Generator(device=idx.device).manual_seed(seed) if seed is not None else None
    for _ in range(max_new):
        logits = model(idx[:, -model.c.T_max:])[:, -1, :]
        if temperature == 0:                     # 约定：温度 0 就是贪心
            nxt = logits.argmax(dim=-1, keepdim=True)
        else:
            probs = torch.softmax(filter_logits(logits, temperature, top_k, top_p), dim=-1)
            nxt = torch.multinomial(probs, 1, generator=g)              # 按概率抽一个
        idx = torch.cat([idx, nxt], dim=1)
        if eos is not None and (nxt == eos).all():                     # 生成了结束符就停
            break
    return idx
