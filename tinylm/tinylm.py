"""TinyLM：全站手算与交互组件共用的玩具模型。

配置与大纲「贯穿全站的示例约定」一致：
  词表 6 个 token、隐藏维度 d=4、2 个注意力头（每头 2 维）、FFN 隐藏维度 8、2 层、序列最长 4。
权重用固定随机种子生成，取一位小数（-0.9 到 0.9），手算友好，每次生成结果相同。

内部以「整数 × 0.1」保存权重，矩阵乘时用整数运算，结果再除以 100，
因此各讲引用的数字没有浮点误差。

用法：
  python tinylm.py            生成 tinylm.json，并打印第 03 讲的示例
"""
import json
from pathlib import Path

import numpy as np

SEED = 2026
VOCAB = ["我", "爱", "学", "AI", "推理", "<eos>"]
SENTENCE = ["我", "爱", "学", "AI"]
D, N_HEADS, D_FFN, N_LAYERS, MAX_SEQ = 4, 2, 8, 2, 4


def tenths(rng, shape):
    """一位小数矩阵，以整数表示（单位 0.1）。"""
    return rng.integers(-9, 10, size=shape)


def build():
    rng = np.random.default_rng(SEED)
    weights = {"embedding": tenths(rng, (len(VOCAB), D))}
    layers = []
    for _ in range(N_LAYERS):
        layers.append({
            "W_q": tenths(rng, (D, D)),
            "W_k": tenths(rng, (D, D)),
            "W_v": tenths(rng, (D, D)),
            "W_o": tenths(rng, (D, D)),
            "W_1": tenths(rng, (D, D_FFN)),
            "W_2": tenths(rng, (D_FFN, D)),
        })
    weights["layers"] = layers
    weights["lm_head"] = tenths(rng, (D, len(VOCAB)))
    return weights


def to_float(a, scale):
    return np.round(np.asarray(a) / scale, 4).tolist()


def lecture_03(w):
    """第 03 讲：4 个 token 的向量 X（4×4）乘一个 4×4 权重矩阵 W。"""
    ids = [VOCAB.index(t) for t in SENTENCE]
    X = w["embedding"][ids]          # 单位 0.1
    W = w["layers"][0]["W_q"]        # 单位 0.1；第 26 讲里它是 W_Q
    C = X @ W                        # 单位 0.01，整数运算无误差
    return {"tokens": SENTENCE, "X": to_float(X, 10), "W": to_float(W, 10), "C": to_float(C, 100)}


def lecture_02(w):
    """第 02 讲：词向量两两之间的点积和余弦相似度（6 个词 × 6 个词）。"""
    E = w["embedding"]               # 单位 0.1
    dot = E @ E.T                    # 单位 0.01，整数运算无误差
    norm = np.sqrt(np.diag(dot))     # 每个词向量的长度（单位 0.1）
    cos = dot / np.outer(norm, norm)
    return {"vocab": VOCAB, "dot": to_float(dot, 100), "cos": np.round(cos, 2).tolist(),
            "norm": np.round(norm / 10, 4).tolist()}


def lecture_13(w):
    """第 13 讲：一句话 X（4×4）经过一个线性层 X·W + b，W 取第 1 层 FFN 的 W_1（4×8）。

    TinyLM 和 Llama 一样不用偏置；这里的 b 是为了演示另外生成的（种子 SEED + 13），不属于模型权重。
    """
    ids = [VOCAB.index(t) for t in SENTENCE]
    X = w["embedding"][ids]                                  # 单位 0.1
    W = w["layers"][0]["W_1"]                                # 单位 0.1
    b = np.random.default_rng(SEED + 13).integers(-9, 10, size=D_FFN)  # 单位 0.1
    Y = X @ W + b * 10                                       # 单位 0.01
    return {"tokens": SENTENCE, "X": to_float(X, 10), "W": to_float(W, 10), "b": to_float(b, 10),
            "Y": to_float(Y, 100)}


def lecture_16(w):
    """第 16 讲：最简单的「下一个词」预测——只用当前词的嵌入乘输出层 lm_head（不经过 Transformer）。

    logits = E · lm_head（6×6），第 i 行是「当前词为 vocab[i]」时对下一个词的打分。
    再看例句「我 爱 学 AI <eos>」里 4 次预测各自的交叉熵。
    """
    E, H = w["embedding"], w["lm_head"]                     # 单位 0.1
    logits = (E @ H) / 100                                   # 整数运算，无误差
    p = np.exp(logits) / np.exp(logits).sum(1, keepdims=True)
    seq = SENTENCE + ["<eos>"]
    ids = [VOCAB.index(t) for t in seq]
    loss = [float(-np.log(p[a, b])) for a, b in zip(ids[:-1], ids[1:])]
    return {"vocab": VOCAB, "logits": np.round(logits, 4).tolist(), "p": np.round(p, 4).tolist(),
            "seq": seq, "loss": np.round(loss, 4).tolist(), "mean": round(float(np.mean(loss)), 4),
            "ppl": round(float(np.exp(np.mean(loss))), 4)}


# ---------------------------------------------------------------------------
# 第 22–24 讲：小语料上训练的「只看前两个词」的语言模型（ToyLM）。
# TinyLM 的权重是随机的，看不出「意思」；这里用一份很小的语料真的训练一次，
# 让嵌入和下一个词的概率有含义。结构：嵌入 E（V×8）→ 拼接前两个词的嵌入（16 维）
# → 线性层 + ReLU（32 维）→ 线性层得到 V 个 logit。「。」既是句号也是句子开头的占位。
TOY_CORPUS = [
    ("小猫 吃 鱼", 3), ("小狗 吃 骨头", 3), ("我 吃 苹果", 2), ("我 吃 香蕉", 2),
    ("你 吃 苹果", 1), ("你 吃 香蕉", 1), ("我 喜欢 小猫", 1), ("我 喜欢 小狗", 1),
    ("你 喜欢 小猫", 1), ("小猫 喜欢 鱼", 1), ("小狗 喜欢 骨头", 1), ("我 学 AI", 2),
    ("我 学 推理", 1), ("你 学 AI", 1), ("你 学 推理", 2), ("我 喜欢 AI", 1),
]
TOY_VOCAB = ["。", "我", "你", "小猫", "小狗", "吃", "喜欢", "学", "鱼", "骨头", "苹果", "香蕉", "AI", "推理"]


def toy_pairs():
    """每句话前面补两个「。」，后面接一个「。」，拆成（前两个词 → 下一个词）的训练样本。"""
    ctx, nxt = [], []
    for sent, n in TOY_CORPUS:
        ids = [0, 0] + [TOY_VOCAB.index(t) for t in sent.split()] + [0]
        for _ in range(n):
            for i in range(2, len(ids)):
                ctx.append(ids[i - 2:i])
                nxt.append(ids[i])
    return np.array(ctx), np.array(nxt)


def toy_forward(P, ctx):
    E, W1, b1, W2, b2 = P
    x = E[ctx].reshape(len(ctx), -1)                 # [n, 16]
    z = x @ W1 + b1
    h = np.maximum(0, z)
    logits = h @ W2 + b2
    return x, z, h, logits


def lecture_22():
    rng = np.random.default_rng(SEED + 22)
    V, D, H = len(TOY_VOCAB), 8, 32
    P = [rng.normal(0, 0.1, (V, D)), rng.normal(0, np.sqrt(2 / (2 * D)), (2 * D, H)), np.zeros(H),
         rng.normal(0, np.sqrt(2 / H), (H, V)), np.zeros(V)]
    E0 = np.round(P[0], 3)                           # 训练前的随机嵌入，第 22 讲做对比
    ctx, nxt = toy_pairs()
    n = len(nxt)
    m = [np.zeros_like(p) for p in P]
    v = [np.zeros_like(p) for p in P]
    for t in range(1, 3001):                         # 全量数据、AdamW（权重衰减 0.01），第 16–20 讲的训练循环
        E, W1, b1, W2, b2 = P
        x, z, h, logits = toy_forward(P, ctx)
        pr = np.exp(logits - logits.max(1, keepdims=True))
        pr /= pr.sum(1, keepdims=True)
        dl = pr.copy()
        dl[np.arange(n), nxt] -= 1                   # 交叉熵 + softmax 的梯度：p − y
        dl /= n
        dh = dl @ W2.T
        dz = dh * (z > 0)
        dx = dz @ W1.T
        dE = np.zeros_like(E)
        np.add.at(dE, ctx[:, 0], dx[:, :D])
        np.add.at(dE, ctx[:, 1], dx[:, D:])
        G = [dE, x.T @ dz, dz.sum(0), h.T @ dl, dl.sum(0)]
        for k in range(5):
            m[k] = 0.9 * m[k] + 0.1 * G[k]
            v[k] = 0.999 * v[k] + 0.001 * G[k] ** 2
            P[k] = P[k] - 0.01 * ((m[k] / (1 - 0.9 ** t)) / (np.sqrt(v[k] / (1 - 0.999 ** t)) + 1e-8) + 0.01 * P[k])
    P = [np.round(p, 3) for p in P]                  # 取三位小数，文章和组件用的就是这组数
    logits = toy_forward(P, ctx)[3]
    pr = np.exp(logits - logits.max(1, keepdims=True))
    pr /= pr.sum(1, keepdims=True)
    loss = float(-np.mean(np.log(pr[np.arange(n), nxt])))
    clean = lambda a: (np.asarray(a, dtype=float) + 0.0).tolist()
    def pca2(E):                                     # 投影到方差最大的两个方向，只用来画图
        Ec = E - E.mean(0)
        _, _, vt = np.linalg.svd(Ec, full_matrices=False)
        xy = Ec @ vt[:2].T
        return np.round(xy, 3)
    return {"vocab": TOY_VOCAB, "corpus": [[s, c] for s, c in TOY_CORPUS], "E": clean(P[0]), "W1": clean(P[1]),
            "b1": clean(P[2]), "W2": clean(P[3]), "b2": clean(P[4]), "loss": round(loss, 4), "pairs": n,
            "E0": clean(E0), "pca": clean(pca2(P[0])), "pca0": clean(pca2(E0))}


# ---------------------------------------------------------------------------
# 第 25–28 讲：一个真正训练过的单层注意力模型（CopyLM，「复读机」）。
# TinyLM 的权重是随机的，注意力几乎平均分配，看不出「注意力学到了什么」。
# 这里的任务需要注意力：输入「a b c 。 a b c」，a、b、c 是随机抽的词，模型要在第二遍时把第一遍复读出来。
# 结构：x = 词嵌入 E[tok] + 位置嵌入 P[pos]（d = 8）→ 2 个头的因果自注意力（每头 4 维）→ 残差 → 输出层 WU。
COPY_T, COPY_D, COPY_H = 7, 8, 2


def copy_forward(p, inp, use_pos=True, causal=True):
    dh = COPY_D // COPY_H
    T = inp.shape[1]
    x = p["E"][inp] + (p["P"][None, :T] if use_pos else 0)
    Q, K, V = x @ p["Wq"], x @ p["Wk"], x @ p["Wv"]
    mask = np.triu(np.full((T, T), -1e9), 1) if causal else 0
    As, Os = [], []
    for h in range(COPY_H):
        sl = slice(h * dh, (h + 1) * dh)
        S = Q[..., sl] @ K[..., sl].transpose(0, 2, 1) / np.sqrt(dh) + mask
        A = np.exp(S - S.max(-1, keepdims=True))
        A /= A.sum(-1, keepdims=True)
        As.append(A)
        Os.append(A @ V[..., sl])
    O = np.concatenate(Os, -1)
    hdn = x + O @ p["Wo"]
    return x, Q, K, V, As, O, hdn, hdn @ p["WU"]


def lecture_27():
    nv, D, dh, T = len(TOY_VOCAB), COPY_D, COPY_D // COPY_H, COPY_T
    r = np.random.default_rng(SEED + 24)                     # 2050
    p = {"E": r.normal(0, .3, (nv, D)), "P": r.normal(0, .3, (T, D))}
    for k in ["Wq", "Wk", "Wv", "Wo"]:
        p[k] = r.normal(0, .35, (D, D))
    p["WU"] = r.normal(0, .35, (D, nv))
    data = np.random.default_rng(SEED + 24 + 1000)
    m = {k: 0 * v for k, v in p.items()}
    v2 = {k: 0 * v for k, v in p.items()}
    for it in range(1, 3001):                                # 每步随机抽 64 组三个词
        tri = data.integers(1, nv, (64, 3))
        sq = np.concatenate([tri, np.zeros((64, 1), int), tri, np.zeros((64, 1), int)], 1)
        inp, tgt = sq[:, :T], sq[:, 1:]
        x, Q, K, V, As, O, hdn, lg = copy_forward(p, inp)
        pr = np.exp(lg - lg.max(-1, keepdims=True))
        pr /= pr.sum(-1, keepdims=True)
        dl = pr.copy()
        np.put_along_axis(dl, tgt[..., None], np.take_along_axis(dl, tgt[..., None], -1) - 1, -1)
        dl /= 64 * T
        g = {"WU": np.einsum("btd,btv->dv", hdn, dl)}
        dh_ = dl @ p["WU"].T
        dx = dh_.copy()
        g["Wo"] = np.einsum("btd,bte->de", O, dh_)
        dO = dh_ @ p["Wo"].T
        dQ, dK, dV = np.zeros_like(Q), np.zeros_like(K), np.zeros_like(V)
        for h in range(COPY_H):                              # 第 18 讲的反向传播，逐个头
            sl = slice(h * dh, (h + 1) * dh)
            A = As[h]
            dA = dO[..., sl] @ V[..., sl].transpose(0, 2, 1)
            dV[..., sl] = A.transpose(0, 2, 1) @ dO[..., sl]
            dS = A * (dA - (dA * A).sum(-1, keepdims=True)) / np.sqrt(dh)
            dQ[..., sl] = dS @ K[..., sl]
            dK[..., sl] = dS.transpose(0, 2, 1) @ Q[..., sl]
        for k, d in [("Wq", dQ), ("Wk", dK), ("Wv", dV)]:
            g[k] = np.einsum("btd,bte->de", x, d)
            dx += d @ p[k].T
        g["P"] = dx.sum(0)
        gE = np.zeros_like(p["E"])
        np.add.at(gE, inp, dx)
        g["E"] = gE
        for k in p:                                          # AdamW
            m[k] = .9 * m[k] + .1 * g[k]
            v2[k] = .999 * v2[k] + .001 * g[k] ** 2
            p[k] = p[k] - 0.01 * ((m[k] / (1 - .9 ** it)) / (np.sqrt(v2[k] / (1 - .999 ** it)) + 1e-8) + 0.01 * p[k])
    p = {k: np.round(v, 3) for k, v in p.items()}
    clean = lambda a: (np.asarray(a, dtype=float) + 0.0).tolist()
    return {"vocab": TOY_VOCAB, "T": T, "d": D, "heads": COPY_H, **{k: clean(v) for k, v in p.items()}}


def sinusoid(n, d):
    """第 25 讲的正弦位置编码。"""
    pos = np.arange(n)[:, None]
    freq = 1 / 10000 ** (np.arange(0, d, 2) / d)
    P = np.zeros((n, d))
    P[:, 0::2], P[:, 1::2] = np.sin(pos * freq), np.cos(pos * freq)
    return P


def layer_norm(x, eps=1e-5):
    """第 30 讲：每一行减均值、除以标准差（γ = 1、β = 0，TinyLM 不训练它们）。"""
    mu = x.mean(-1, keepdims=True)
    var = ((x - mu) ** 2).mean(-1, keepdims=True)
    return (x - mu) / np.sqrt(var + eps)


def tiny_forward(w, tokens):
    """TinyLM 的完整前向（第 34 讲）。结构是原始 Transformer 的 Post-Norm：
    x = 嵌入 + 位置编码；每层：x = LN(x + 注意力(x))，x = LN(x + FFN(x))；最后 logits = x · lm_head。
    返回每一步的中间结果，供第 30–34 讲引用。"""
    E = w["embedding"] / 10
    ids = [VOCAB.index(t) for t in tokens]
    s, dh = len(ids), D // N_HEADS
    steps = [("embed", "词嵌入 X", E[ids])]
    x = E[ids] + sinusoid(s, D)
    steps.append(("pos", "加位置编码", x))
    mask = np.triu(np.full((s, s), -np.inf), 1)
    for l, L in enumerate(w["layers"]):
        Wq, Wk, Wv, Wo, W1, W2 = (L[k] / 10 for k in ["W_q", "W_k", "W_v", "W_o", "W_1", "W_2"])
        Q, K, V = x @ Wq, x @ Wk, x @ Wv
        heads, As = [], []
        for h in range(N_HEADS):
            c = slice(h * dh, (h + 1) * dh)
            S = Q[:, c] @ K[:, c].T / np.sqrt(dh) + mask
            A = np.exp(S - S.max(1, keepdims=True))
            A /= A.sum(1, keepdims=True)
            As.append(A)
            heads.append(A @ V[:, c])
        attn = np.concatenate(heads, 1) @ Wo
        r1 = x + attn
        n1 = layer_norm(r1)
        up = n1 @ W1
        act = np.maximum(0, up)
        down = act @ W2
        r2 = n1 + down
        x = layer_norm(r2)
        p = f"L{l + 1}"
        steps += [(p + "qkv", f"第 {l + 1} 层：Q、K、V", np.concatenate([Q, K, V], 1)),
                  (p + "attnw", f"第 {l + 1} 层：注意力权重（头 1 | 头 2）", np.concatenate(As, 1)),
                  (p + "attn", f"第 {l + 1} 层：注意力输出", attn),
                  (p + "res1", f"第 {l + 1} 层：残差相加 x + 注意力", r1),
                  (p + "ln1", f"第 {l + 1} 层：LayerNorm", n1),
                  (p + "up", f"第 {l + 1} 层：FFN 升维 × W_1", up),
                  (p + "relu", f"第 {l + 1} 层：ReLU", act),
                  (p + "down", f"第 {l + 1} 层：FFN 降维 × W_2", down),
                  (p + "res2", f"第 {l + 1} 层：残差相加", r2),
                  (p + "ln2", f"第 {l + 1} 层：LayerNorm（这一层的输出）", x)]
    logits = x @ (w["lm_head"] / 10)
    probs = np.exp(logits - logits.max(1, keepdims=True))
    probs /= probs.sum(1, keepdims=True)
    steps += [("logits", "输出层：logits = x · lm_head", logits), ("probs", "softmax：下一个词的概率", probs)]
    return steps


def lecture_34(w):
    steps = tiny_forward(w, SENTENCE)
    return {"tokens": SENTENCE, "vocab": VOCAB,
            "steps": [{"key": k, "name": n, "v": np.round(v, 4).tolist()} for k, n, v in steps]}


def lecture_38(w):
    """第 38 讲：SwiGLU 门控 FFN 的演示权重（TinyLM 本身是 ReLU FFN，这三组权重另外生成，种子 SEED + 38）。
    输入取 TinyLM 前向里第 1 层“AI”那一行 LayerNorm 的输出。"""
    r = np.random.default_rng(SEED + 38)
    Wg, Wu, Wd = (r.integers(-9, 10, size=sh) / 10 for sh in [(D, D_FFN), (D, D_FFN), (D_FFN, D)])
    steps = {k: v for k, _, v in tiny_forward(w, SENTENCE)}
    x = np.round(steps["L1ln1"][3], 4)
    g, u = x @ Wg, x @ Wu
    silu = g / (1 + np.exp(-g))
    h = silu * u
    return {"x": x.tolist(), "Wg": Wg.tolist(), "Wu": Wu.tolist(), "Wd": Wd.tolist(),
            "g": np.round(g, 4).tolist(), "u": np.round(u, 4).tolist(), "h": np.round(h, 4).tolist(),
            "y": np.round(h @ Wd, 4).tolist()}


def lecture_47():
    """第 47 讲：在 ToyLM 上做一次最小的 SFT：提示“你 学”、回答“AI 。”，只训练输出层，只对回答算损失。
    和文章里的代码同一个算法；存下几个前缀在微调前后的概率，给组件用。"""
    ex = lecture_22()
    V = ex["vocab"]
    E, W1, b1, W2, b2 = (np.array(ex[k]) for k in ["E", "W1", "b1", "W2", "b2"])
    hid = lambda a, b: np.maximum(0, np.concatenate([E[V.index(a)], E[V.index(b)]]) @ W1 + b1)
    def probs(a, b, W, bb):
        z = hid(a, b) @ W + bb
        q = np.exp(z - z.max())
        return q / q.sum()
    W2f, b2f = W2.copy(), b2.copy()
    train = [("你", "学", "AI"), ("学", "AI", "。")]
    for _ in range(50):
        gW, gb = np.zeros_like(W2f), np.zeros_like(b2f)
        for a, b, y in train:
            q = probs(a, b, W2f, b2f)
            q[V.index(y)] -= 1
            gW += np.outer(hid(a, b), q) / len(train)
            gb += q / len(train)
        W2f -= 0.5 * gW
        b2f -= 0.5 * gb
    ctx = [("你", "学"), ("我", "学"), ("小猫", "吃"), ("我", "吃")]
    return {"vocab": V, "ctx": [list(c) for c in ctx],
            "before": [np.round(probs(a, b, W2, b2), 3).tolist() for a, b in ctx],
            "after": [np.round(probs(a, b, W2f, b2f), 3).tolist() for a, b in ctx]}


def lecture_15():
    """第 15 讲：一个 1→8→8→1 的 ReLU 小网络，拟合 sin(1.5x)，x ∈ [−3, 3]。

    和 TinyLM 无关，只是同一个脚本里生成。训练方法是第 16–20 讲的内容（均方误差 + 反向传播 + Adam），
    这里先当成现成的结果。训练完把前两层权重取两位小数，再用最小二乘重算输出层并取两位小数，
    这样文章和组件里显示的权重就是实际参与计算的权重。
    """
    rng = np.random.default_rng(SEED + 15)
    xs = (np.arange(121) * 0.05 - 3)[:, None]
    ys = np.sin(1.5 * xs)
    sizes = (1, 8, 8, 1)
    P = [[rng.normal(0, np.sqrt(2 / a), (a, b)), np.zeros(b)] for a, b in zip(sizes[:-1], sizes[1:])]
    m = [[np.zeros_like(W), np.zeros_like(b)] for W, b in P]
    v = [[np.zeros_like(W), np.zeros_like(b)] for W, b in P]
    for t in range(1, 20001):
        hs, zs = [xs], []
        for i, (W, b) in enumerate(P):
            z = hs[-1] @ W + b
            zs.append(z)
            hs.append(np.maximum(0, z) if i < len(P) - 1 else z)
        g = 2 * (hs[-1] - ys) / len(xs)
        for i in range(len(P) - 1, -1, -1):
            W = P[i][0]
            grads = (hs[i].T @ g, g.sum(0))
            if i > 0:
                g = (g @ W.T) * (zs[i - 1] > 0)
            for k, gr in enumerate(grads):
                m[i][k] = 0.9 * m[i][k] + 0.1 * gr
                v[i][k] = 0.999 * v[i][k] + 0.001 * gr ** 2
                P[i][k] = P[i][k] - 0.01 * (m[i][k] / (1 - 0.9 ** t)) / (np.sqrt(v[i][k] / (1 - 0.999 ** t)) + 1e-8)
    W1, b1 = np.round(P[0][0], 2), np.round(P[0][1], 2)
    W2, b2 = np.round(P[1][0], 2), np.round(P[1][1], 2)
    h2 = np.maximum(0, np.maximum(0, xs @ W1 + b1) @ W2 + b2)
    sol = np.linalg.lstsq(np.hstack([h2, np.ones((len(xs), 1))]), ys, rcond=None)[0]
    W3, b3 = np.round(sol[:-1], 2), np.round(sol[-1], 2)
    clean = lambda a: (np.asarray(a, dtype=float) + 0.0).tolist()
    return {"target": "sin(1.5x)", "range": [-3, 3],
            "layers": [{"W": clean(W1), "b": clean(b1)}, {"W": clean(W2), "b": clean(b2)}, {"W": clean(W3), "b": clean(b3)}]}


def main():
    w = build()
    out = {
        "config": {"seed": SEED, "vocab": VOCAB, "d": D, "n_heads": N_HEADS, "d_head": D // N_HEADS,
                   "d_ffn": D_FFN, "n_layers": N_LAYERS, "max_seq": MAX_SEQ},
        "weights": {
            "embedding": to_float(w["embedding"], 10),
            "layers": [{k: to_float(v, 10) for k, v in layer.items()} for layer in w["layers"]],
            "lm_head": to_float(w["lm_head"], 10),
        },
        "examples": {"02": lecture_02(w), "03": lecture_03(w), "13": lecture_13(w), "15": lecture_15(), "16": lecture_16(w), "22": lecture_22(), "27": lecture_27(), "34": lecture_34(w), "38": lecture_38(w), "47": lecture_47()},
    }
    data = json.dumps(out, ensure_ascii=False, indent=1)
    path = Path(__file__).with_name("tinylm.json")
    path.write_text(data, encoding="utf-8")
    # 网站组件从 site/src/data/tinylm.json 导入，保持同步（仓库自包含，CI 只克隆 site/）
    site_path = Path(__file__).resolve().parent.parent / "site" / "src" / "data" / "tinylm.json"
    if site_path.parent.exists():
        site_path.write_text(data, encoding="utf-8")
    ex = out["examples"]["03"]
    print("第 03 讲示例")
    for name in ("X", "W", "C"):
        print(name, ex[name])
    print("已写入", path)
    print("已同步", site_path)


if __name__ == "__main__":
    main()
