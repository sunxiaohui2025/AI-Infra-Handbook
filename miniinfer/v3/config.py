"""模型配置：从 config.json 读出前向计算需要的几个数。"""
import json
from dataclasses import dataclass


@dataclass
class Config:
    vocab_size: int
    hidden_size: int          # d，每个 token 的向量长度
    intermediate_size: int    # FFN 中间层的宽度
    num_layers: int
    num_heads: int            # 查询头数
    num_kv_heads: int         # KV 头数（GQA：几个查询头共用一组 K、V）
    head_dim: int
    rope_theta: float
    rms_eps: float
    eos_token_id: int

    @staticmethod
    def load(model_dir):
        c = json.load(open(f"{model_dir}/config.json"))
        return Config(
            vocab_size=c["vocab_size"],
            hidden_size=c["hidden_size"],
            intermediate_size=c["intermediate_size"],
            num_layers=c["num_hidden_layers"],
            num_heads=c["num_attention_heads"],
            num_kv_heads=c["num_key_value_heads"],
            head_dim=c["head_dim"],
            rope_theta=c["rope_theta"],
            rms_eps=c["rms_norm_eps"],
            eos_token_id=c["eos_token_id"],
        )
