"""第 116 讲：在有 NVIDIA GPU 的机器上检查移植的投机解码。本站没有 GPU，这个脚本没有在本站运行过。

准备：把 nano_spec/nanovllm/ 下的 8 个文件覆盖到 nano-vllm（提交 bb823b3）的同名位置，按 nano-vllm 的 README 装好依赖。
用法：先关闭投机跑一次，再打开投机跑一次，第二次会和第一次逐个请求比较：
    python check_spec.py /path/to/Qwen3-0.6B 0
    python check_spec.py /path/to/Qwen3-0.6B 4
"""
import json, sys, time
from nanovllm import LLM, SamplingParams

CODE = '''def moving_average(values, window):
    result = []
    total = 0.0
    for i, v in enumerate(values):
        total += v
        if i >= window:
            total -= values[i - window]
        if i >= window - 1:
            result.append(total / window)
    return result
'''
PROMPTS = ["Add type hints to this function and keep everything else the same:\n\n" + CODE + "\nAnswer:\n\n",
           "Explain in a few sentences why large language models need a KV cache.",
           "Repeat the following list exactly, then sort it: banana, cherry, apple, kiwi, mango, grape, lemon, peach."]


def main():
    path, k = sys.argv[1], int(sys.argv[2])
    llm = LLM(path, num_spec_tokens=k)
    sp = SamplingParams(temperature=1e-5, max_tokens=256, ignore_eos=True)   # 极小的温度，效果接近贪心
    llm.generate(["warm up"], SamplingParams(max_tokens=8), use_tqdm=False)
    llm.scheduler.num_accepted = 0
    t = time.perf_counter()
    ids = [o["token_ids"] for o in llm.generate(PROMPTS, sp, use_tqdm=False)]
    dt = time.perf_counter() - t
    n = sum(map(len, ids))
    print(f"num_spec_tokens={k}：{n} 个 token，{dt:.2f} s，{n / dt:.1f} token/s，接受草稿 {llm.scheduler.num_accepted} 个")
    json.dump(ids, open(f"spec_{k}.json", "w"))
    if k:
        # GPU 上两次运行用的注意力 kernel、batch 形状不同，BF16 的打分会有末位差异，
        # 两个候选很接近时可能选得不一样（第 111 讲）。所以报告“前多少个 token 相同”，而不只是“是否完全相同”。
        for a, b in zip(ids, json.load(open("spec_0.json"))):
            same = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            print(f"  前 {same}/{len(b)} 个 token 和不投机时相同")


if __name__ == "__main__":
    main()
