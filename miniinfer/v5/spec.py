"""v5：投机解码。用 n-gram（prompt lookup）起草：在已有的 token 里找和结尾相同的片段，把它后面的几个 token 当作草稿。"""


def propose(tokens, k=4, max_n=3):
    """从最长的 n-gram 开始找：结尾的 n 个 token 之前出现过，就把那次出现之后的 k 个 token 当草稿。"""
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


def verify(draft, pred):
    """pred[j] 是模型在第 j 个送入位置上的贪心预测。草稿第 j 个 token 被接受，当且仅当它等于 pred[j]。
    返回这一步真正新增的 token：接受的草稿，加上第一个不一致处（或末尾）模型自己的预测。"""
    out = []
    for j, t in enumerate(draft):
        if t != pred[j]:
            break
        out.append(t)
    out.append(pred[len(out)])
    return out
