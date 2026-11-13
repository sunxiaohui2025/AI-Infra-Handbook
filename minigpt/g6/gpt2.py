"""把 GPT-2 的权重装进我们的 GPT（第 58 讲）。

HuggingFace 的 GPT-2 和我们的结构一样，只是名字不同，还有两处存法不同：
  1. 它的线性层是 Conv1D，权重存成 [输入, 输出]；nn.Linear 是 [输出, 输入]，要转置。
  2. 它把 W_q、W_k、W_v 拼成一个 c_attn，[d, 3d]；要切成三份。
输出层和 token 嵌入共用一份权重（weight tying），文件里只有 wte。
"""
import torch

from model import GPT, GPTConfig


def config_from_hf(hf: dict) -> GPTConfig:
    return GPTConfig(V=hf["vocab_size"], T_max=hf["n_positions"], d=hf["n_embd"], H=hf["n_head"],
                     L=hf["n_layer"], dropout=0.0, qkv_bias=True)


@torch.no_grad()
def load_gpt2(sd: dict, c: GPTConfig) -> GPT:
    """sd：GPT-2 的 state_dict（名字不带 “transformer.” 前缀也行）。"""
    sd = {k.removeprefix("transformer."): v for k, v in sd.items()}
    m = GPT(c).eval()

    def put(param, w, transpose=False):
        w = w.t() if transpose else w
        assert param.shape == w.shape, f"形状对不上：{tuple(param.shape)} vs {tuple(w.shape)}"
        param.copy_(w)

    put(m.tok_emb.weight, sd["wte.weight"])
    put(m.pos_emb.weight, sd["wpe.weight"])
    for i, b in enumerate(m.blocks):
        p = f"h.{i}."
        put(b.norm1.scale, sd[p + "ln_1.weight"]); put(b.norm1.shift, sd[p + "ln_1.bias"])
        qw, kw, vw = sd[p + "attn.c_attn.weight"].split(c.d, dim=1)       # [d, 3d] 按列切成三份
        qb, kb, vb = sd[p + "attn.c_attn.bias"].split(c.d)
        put(b.att.W_q.weight, qw, True); put(b.att.W_q.bias, qb)
        put(b.att.W_k.weight, kw, True); put(b.att.W_k.bias, kb)
        put(b.att.W_v.weight, vw, True); put(b.att.W_v.bias, vb)
        put(b.att.out_proj.weight, sd[p + "attn.c_proj.weight"], True); put(b.att.out_proj.bias, sd[p + "attn.c_proj.bias"])
        put(b.norm2.scale, sd[p + "ln_2.weight"]); put(b.norm2.shift, sd[p + "ln_2.bias"])
        put(b.ff.net[0].weight, sd[p + "mlp.c_fc.weight"], True); put(b.ff.net[0].bias, sd[p + "mlp.c_fc.bias"])
        put(b.ff.net[2].weight, sd[p + "mlp.c_proj.weight"], True); put(b.ff.net[2].bias, sd[p + "mlp.c_proj.bias"])
    put(m.final_norm.scale, sd["ln_f.weight"]); put(m.final_norm.shift, sd["ln_f.bias"])
    put(m.out_head.weight, sd["wte.weight"])          # 共用 token 嵌入
    return m
