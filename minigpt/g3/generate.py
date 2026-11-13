"""自回归生成：每次把整段序列送进模型，取最后一个位置的 logits，选出下一个 token 接在后面（第 55 讲）。"""
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
