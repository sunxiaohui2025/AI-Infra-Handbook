"""设备抽象：引擎里所有和“哪块卡”有关的地方都走这里，换后端只改这一个文件（第 141 讲）。"""
import torch


def pick_device(name=None):
    # 没指定时按 CUDA（含 ROCm、海光 DCU 这类沿用 cuda 设备名的后端）→ MPS → CPU 的顺序挑
    if name:
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def synchronize(device):
    # GPU 上的 kernel 是异步执行的：计时之前必须等它们跑完，否则量到的只是“发射”的时间
    if device.type == "cuda":
        torch.cuda.synchronize()
    elif device.type == "mps":
        torch.mps.synchronize()


def supports(device, dtype):
    # 试着在这块设备上建一个这种类型的张量，再做一次乘法：不支持的组合会在这里报错，而不是跑到一半才报
    try:
        x = torch.ones(4, 4, dtype=dtype, device=device)
        (x @ x).sum().item()
        return True
    except (RuntimeError, TypeError):
        return False
