"""存档和读档（第 57 讲）。

存档里放三样东西：模型配置、模型参数、优化器状态。只想用模型生成，前两样就够；
要接着训练，最好带上优化器状态（AdamW 给每个参数记了两份滑动平均，丢了它就要从 0 重新攒）。
"""
import torch

from model import GPT, GPTConfig


def save(path, model, opt=None, **extra):
    torch.save({"config": model.c.__dict__, "model": model.state_dict(),
                "optimizer": opt.state_dict() if opt is not None else None, **extra}, path)


def load(path, device="cpu"):
    ck = torch.load(path, map_location=device)     # map_location：在 GPU 上存的，也能读到 CPU 上
    model = GPT(GPTConfig(**ck["config"])).to(device)
    model.load_state_dict(ck["model"])
    return model, ck
