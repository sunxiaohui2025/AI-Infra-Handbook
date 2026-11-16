"""第 138 讲：给 torch.compile 写一个最小的“自定义后端”，看它拿到了几张图、每张图多大、什么时候会重新编译。
后端只是一个函数：收到 FX 图（GraphModule）和示例输入，返回一个可调用对象。真实的厂商后端在这里把图交给自己的图编译器。
v1 的模型每层有一次 int(pos[-1])，port/ 去掉了它；分别编译，比较图的数量。在 CPU 上运行。"""
import os, sys, importlib
import torch
import torch._dynamo as dynamo
import logging
torch._logging.set_logs(dynamo=logging.ERROR)          # 关掉“重新编译次数到上限”之类的警告，下面自己统计
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

graphs = []
def my_backend(gm, example_inputs):
    # 统计这张图里有多少个“真的要算”的节点（call_function / call_method），不算输入、输出、取属性
    n = sum(1 for node in gm.graph.nodes if node.op in ("call_function", "call_method"))
    graphs.append(n)
    return gm.forward                        # 不做任何优化，原样执行：这里就是厂商后端接手的位置


def load(ver):
    for m in ["engine", "model", "kv_cache", "config", "weights", "device"]:
        sys.modules.pop(m, None)
    sys.path.insert(0, os.path.join(ROOT, ver))
    eng, kv = importlib.import_module("engine"), importlib.import_module("kv_cache")
    sys.path.pop(0)
    return eng.LLM(os.path.join(ROOT, "models", "Qwen3-0.6B"), device="cpu"), kv.KVCache


for ver in ["v1", "port"]:
    llm, KVCache = load(ver)
    dynamo.reset(); graphs.clear()
    fwd = torch.compile(llm.model.forward, backend=my_backend)
    cache = KVCache(llm.cfg, 64, torch.float32, "cpu")
    ids = llm.tok.encode("The capital of France is").ids
    log = []
    steps = [("prefill，5 个 token", ids, 0), ("decode 第 1 步", [12095], 5), ("decode 第 2 步", [13], 6), ("decode 第 3 步", [576], 7)]
    for name, toks, start in steps:
        before = len(graphs)
        fwd(torch.tensor(toks), start, cache)
        log.append(f"{name}：新编译 {len(graphs) - before} 张图")
    print(f"{ver}：一共编译了 {len(graphs)} 张图，每张图的节点数 {graphs[:6]}{' …' if len(graphs) > 6 else ''}")
    for line in log:
        print("   " + line)
    exp = dynamo.explain(llm.model.forward)(torch.tensor([13]), 6, cache)
    print(f"   explain：{exp.graph_count} 张图，{exp.graph_break_count} 处图中断")
    for r in exp.break_reasons[:1]:
        print("   第一处中断的原因：" + r.reason.split("\n")[0][:110])


# 形状变了会不会重新编译：换几个长度的 prefill，再看静态 / 动态两种编译方式
for mode, kw in [("默认（按形状特化）", {}), ("dynamic=True（一次编译，形状当变量）", {"dynamic": True})]:
    llm, KVCache = load("port")
    dynamo.reset(); graphs.clear()
    fwd = torch.compile(llm.model.forward, backend=my_backend, **kw)
    cache = KVCache(llm.cfg, 512, torch.float32, "cpu")
    log = []
    for n in [8, 16, 24, 8]:                      # 四次 prefill，长度 8、16、24，再回到 8
        before = len(graphs)
        fwd(torch.arange(n), 0, cache)
        log.append(f"prefill {n} 个 token：+{len(graphs) - before}")
    for step in range(3):                         # 三步 decode，每步 1 个 token
        before = len(graphs)
        fwd(torch.tensor([13]), 64 + step, cache)
        log.append(f"decode：+{len(graphs) - before}")
    print(f"{mode}：共 {len(graphs)} 张图　" + "，".join(log))
