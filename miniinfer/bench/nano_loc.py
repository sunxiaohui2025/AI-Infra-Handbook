"""nano-vllm 和 miniinfer v5 逐模块对照：各有多少行代码（不算空行）。只读源码文本，不运行 nano-vllm。"""
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NANO = os.path.join(ROOT, "third_party", "nano-vllm", "nanovllm")


def loc(path):
    return sum(1 for l in open(path, encoding="utf-8") if l.strip())


ROWS = [  # (模块, nano-vllm 的文件, miniinfer v5 的文件)
    ("入口、配置",     ["llm.py", "config.py", "sampling_params.py", "engine/llm_engine.py"], ["config.py"]),
    ("请求状态",       ["engine/sequence.py"], ["sequence.py"]),
    ("调度器",         ["engine/scheduler.py"], ["scheduler.py"]),
    ("块管理、前缀缓存", ["engine/block_manager.py"], ["block_manager.py"]),
    ("执行器（拼 batch、跑模型）", ["engine/model_runner.py", "utils/context.py"], ["engine.py"]),
    ("模型",           ["models/qwen3.py", "layers/activation.py", "layers/layernorm.py",
                        "layers/rotary_embedding.py", "layers/embed_head.py", "layers/linear.py"], ["model.py"]),
    ("注意力、写 KV",  ["layers/attention.py"], []),
    ("采样",           ["layers/sampler.py"], []),
    ("读权重",         ["utils/loader.py"], ["weights.py"]),
    ("量化",           [], ["quant.py"]),
    ("投机解码",       [], ["spec.py"]),
]
tn = tm = 0
print("nano-vllm  miniinfer v5  模块")
for name, nf, mf in ROWS:
    n = sum(loc(os.path.join(NANO, f)) for f in nf)
    m = sum(loc(os.path.join(ROOT, "v5", f)) for f in mf)
    tn, tm = tn + n, tm + m
    print(f"{n or '—':>9}{m or '—':>14}  {name}")
print(f"{tn:>9}{tm:>14}  合计（不含 __init__.py）")
