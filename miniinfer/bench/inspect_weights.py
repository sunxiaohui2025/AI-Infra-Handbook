"""看一眼 model.safetensors 里有什么：一共多少个张量、多少参数，第 0 层有哪些权重、各是什么形状。"""
import os
from safetensors import safe_open

path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "Qwen3-0.6B", "model.safetensors")
with safe_open(path, "pt") as f:
    names = list(f.keys())
    total = sum(f.get_slice(n).get_shape()[0] * (f.get_slice(n).get_shape() + [1])[1] for n in names)
    print(f"{len(names)} 个张量，共 {total / 1e6:.0f} M 个参数，数据类型 {f.get_slice(names[0]).get_dtype()}")
    for n in sorted(names):
        if n.startswith("model.layers.0.") or not n.startswith("model.layers."):
            print(f"  {n:<45} {f.get_slice(n).get_shape()}")
