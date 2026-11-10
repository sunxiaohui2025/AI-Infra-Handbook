"""从 safetensors 文件读出全部权重，按名字放进一个字典。"""
import torch
from safetensors.torch import load_file


def load_weights(model_dir, dtype=torch.float32, device="cpu"):
    raw = load_file(f"{model_dir}/model.safetensors")
    w = {name: t.to(dtype=dtype, device=device) for name, t in raw.items()}
    # Qwen3-0.6B 的输出层和嵌入表是同一份权重（config.json 里 tie_word_embeddings 为 true）。
    # 这个文件里另存了一份一模一样的 lm_head；没有的话，直接用嵌入表
    if "lm_head.weight" not in w:
        w["lm_head.weight"] = w["model.embed_tokens.weight"]
    return w
