"""n-gram 起草和验证，和 miniinfer v5 的 spec.py 相同（第 112 讲）。"""


def propose(tokens: list[int], k: int, max_n: int = 3) -> list[int]:
    """结尾的 n 个 token 之前出现过，就把那次出现之后的最多 k 个 token 当草稿；n 从 max_n 退到 1。"""
    for n in range(max_n, 0, -1):
        if len(tokens) <= n:
            continue
        tail = tokens[-n:]
        for start in range(len(tokens) - n - 1, -1, -1):     # 从近往远找
            if tokens[start:start + n] == tail:
                draft = tokens[start + n:start + n + k]
                if draft:
                    return draft
    return []


def verify(draft: list[int], pred: list[int]) -> list[int]:
    """pred[j] 是第 j 个送入位置上采样出的 token。草稿第 j 个被接受，当且仅当它等于 pred[j]。
    返回这一步真正新增的 token：被接受的草稿，再加上第一个不一致处（或末尾）采样出的那个。"""
    out = []
    for j, t in enumerate(draft):
        if t != pred[j]:
            break
        out.append(t)
    out.append(pred[len(out)])
    return out
