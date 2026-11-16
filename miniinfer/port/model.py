"""移植版的 Qwen3 前向：和 v1 一样只用 torch 的基本运算；改了两处，让它在 GPU 类的后端上不做多余的同步，并能逐层取出中间结果。"""
import torch


def rms_norm(x, weight, eps):
    # 每个向量除以自己的均方根，再乘可学习的缩放（第 36 讲）
    # 平方和先升到 FP32 再算：FP16 最大只能表示 65504，而 Qwen3 第 0 个位置的激活能到 6500 左右，
    # 平方就是 4000 多万，在 FP16 里直接变成 inf（第 139 讲）。FP32 下这两行和 v1 完全一样
    xf = x.float()
    var = xf.pow(2).mean(-1, keepdim=True)
    return (xf * torch.rsqrt(var + eps)).to(x.dtype) * weight


def rope(x, pos, theta):
    # x: [T, 头数, head_dim]，pos: [T]。把每个头的向量两两配对，按位置旋转（第 37 讲）
    half = x.shape[-1] // 2
    freq = 1.0 / theta ** (torch.arange(half, dtype=torch.float32, device=x.device) / half)
    angle = pos[:, None].float() * freq[None, :]                 # [T, half]
    cos, sin = angle.cos()[:, None, :], angle.sin()[:, None, :]  # 在“头”这一维上广播
    x1, x2 = x[..., :half].float(), x[..., half:].float()
    out = torch.cat([x1 * cos - x2 * sin, x1 * sin + x2 * cos], dim=-1)
    return out.to(x.dtype)


class Qwen3:
    def __init__(self, cfg, w):
        self.cfg, self.w = cfg, w

    def attention(self, i, x, pos, end, cache):
        c, w, p = self.cfg, self.w, f"model.layers.{i}.self_attn."
        T = x.shape[0]
        q = (x @ w[p + "q_proj.weight"].T).view(T, c.num_heads, c.head_dim)
        k = (x @ w[p + "k_proj.weight"].T).view(T, c.num_kv_heads, c.head_dim)
        v = (x @ w[p + "v_proj.weight"].T).view(T, c.num_kv_heads, c.head_dim)
        q = rms_norm(q, w[p + "q_norm.weight"], c.rms_eps)        # Qwen3 在 RoPE 之前对 q、k 各做一次 RMSNorm
        k = rms_norm(k, w[p + "k_norm.weight"], c.rms_eps)
        q, k = rope(q, pos, c.rope_theta), rope(k, pos, c.rope_theta)
        cache.write(i, pos, k, v)                                # 新 token 的 K、V 存进缓存
        # end 由调用方用 Python 整数传进来。v1 在这里写的是 int(pos[-1]) + 1：
        # 在 GPU 上这一步要等设备把这个数算完再拷回主机，28 层就停 28 次（第 141 讲量到一次约 140 μs）
        k, v = cache.read(i, end)                                # 取出从第 0 个位置到现在的全部 K、V
        rep = c.num_heads // c.num_kv_heads                      # GQA：每组 K、V 给 rep 个查询头用
        k, v = k.repeat_interleave(rep, dim=1), v.repeat_interleave(rep, dim=1)
        scores = torch.einsum("qhd,khd->hqk", q, k) / c.head_dim ** 0.5
        mask = torch.arange(end, device=x.device)[None, :] <= pos[:, None]   # 位置 p 的查询只看 ≤ p 的键
        scores = scores.masked_fill(~mask, float("-inf"))
        out = torch.einsum("hqk,khd->qhd", scores.softmax(-1), v).reshape(T, -1)
        return out @ w[p + "o_proj.weight"].T

    def mlp(self, i, x):
        w, p = self.w, f"model.layers.{i}.mlp."
        gate, up = x @ w[p + "gate_proj.weight"].T, x @ w[p + "up_proj.weight"].T
        return (torch.nn.functional.silu(gate) * up) @ w[p + "down_proj.weight"].T   # SwiGLU（第 38 讲）

    @torch.no_grad()
    def forward(self, tokens, start, cache, trace=None):
        # tokens: 这次新来的 [T] 个 token，从位置 start 开始；它们之前的 K、V 已经在 cache 里
        # trace: 传一个列表进来，就把每一层的输出依次存进去（精度对齐用，第 139 讲）
        c, w = self.cfg, self.w
        end = start + len(tokens)
        pos = torch.arange(start, end, device=tokens.device)
        x = w["model.embed_tokens.weight"][tokens]
        for i in range(c.num_layers):
            p = f"model.layers.{i}."
            x = x + self.attention(i, rms_norm(x, w[p + "input_layernorm.weight"], c.rms_eps), pos, end, cache)
            x = x + self.mlp(i, rms_norm(x, w[p + "post_attention_layernorm.weight"], c.rms_eps))
            if trace is not None:
                trace.append(x)
        x = rms_norm(x[-1:], w["model.norm.weight"], c.rms_eps)   # 只需要最后一个位置的打分
        return x @ w["lm_head.weight"].T
