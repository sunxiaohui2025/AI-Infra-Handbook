"""Qwen3 的前向计算：只用 torch 的基本运算，一层一层写出来。"""
import torch


def rms_norm(x, weight, eps):
    # 每个向量除以自己的均方根，再乘可学习的缩放（第 36 讲）
    var = x.pow(2).mean(-1, keepdim=True)
    return x * torch.rsqrt(var + eps) * weight


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

    def attention(self, i, x, pos, cache):
        c, w, p = self.cfg, self.w, f"model.layers.{i}.self_attn."
        T = x.shape[0]
        q = (x @ w[p + "q_proj.weight"].T).view(T, c.num_heads, c.head_dim)
        k = (x @ w[p + "k_proj.weight"].T).view(T, c.num_kv_heads, c.head_dim)
        v = (x @ w[p + "v_proj.weight"].T).view(T, c.num_kv_heads, c.head_dim)
        q = rms_norm(q, w[p + "q_norm.weight"], c.rms_eps)        # Qwen3 在 RoPE 之前对 q、k 各做一次 RMSNorm
        k = rms_norm(k, w[p + "k_norm.weight"], c.rms_eps)
        q, k = rope(q, pos, c.rope_theta), rope(k, pos, c.rope_theta)
        cache.write(i, pos, k, v)                                # 新 token 的 K、V 存进缓存
        end = int(pos[-1]) + 1
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
    def forward(self, tokens, start, cache):
        # tokens: 这次新来的 [T] 个 token，从位置 start 开始；它们之前的 K、V 已经在 cache 里
        c, w = self.cfg, self.w
        pos = torch.arange(start, start + len(tokens), device=tokens.device)
        x = w["model.embed_tokens.weight"][tokens]
        for i in range(c.num_layers):
            p = f"model.layers.{i}."
            x = x + self.attention(i, rms_norm(x, w[p + "input_layernorm.weight"], c.rms_eps), pos, cache)
            x = x + self.mlp(i, rms_norm(x, w[p + "post_attention_layernorm.weight"], c.rms_eps))
        x = rms_norm(x[-1:], w["model.norm.weight"], c.rms_eps)   # 只需要最后一个位置的打分
        return x @ w["lm_head.weight"].T
