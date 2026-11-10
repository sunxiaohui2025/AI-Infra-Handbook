# miniinfer：从零写一个迷你推理引擎

《AI Infra 学习网站》第 14 篇配套代码。每个版本是一个完整目录，后一版在前一版的基础上修改：

| 目录 | 内容 | 讲 |
| --- | --- | --- |
| v0 | 手写 Qwen3 前向，不带缓存的贪心生成 | 106 |
| v1 | KV Cache | 107 |
| v2 | 请求状态、调度器、continuous batching | 108 |
| v3 | 分页 KV（块池、块表、抢占）与前缀缓存 | 109、110 |
| v4 | INT8 权重量化 | 111 |
| v5 | n-gram 投机解码 | 112 |

```bash
python3 -m venv .venv && .venv/bin/pip install torch transformers safetensors huggingface_hub
.venv/bin/python -c "from huggingface_hub import snapshot_download as d; d('Qwen/Qwen3-0.6B', local_dir='models/Qwen3-0.6B')"
.venv/bin/python tests/hf_ref.py          # 生成 HuggingFace 的参考答案
.venv/bin/python tests/check.py v2        # 某个版本和参考答案逐 token 比对
.venv/bin/python bench/batching.py        # 各讲的压测脚本在 bench/ 里，输出存在 outputs/
diff -r v1 v2                             # 看一讲改了什么
```

## 第 15 篇：解读 nano-vllm

```bash
git clone https://github.com/GeeeekExplorer/nano-vllm third_party/nano-vllm
cd third_party/nano-vllm && git checkout bb823b3 && cd ../..
.venv/bin/python bench/nano_loc.py        # nano-vllm 和 miniinfer 逐模块的行数（只读源码文本）
.venv/bin/python bench/nano_spec_diff.py  # 第 116 讲的移植改了多少行
```

- `third_party/nano-vllm/`：第 114、115 讲读的源码（MIT 许可），网站构建时会读取这里的文件。nano-vllm 需要 NVIDIA GPU，本仓库不运行它。
- `nano_spec/nanovllm/`：第 116 讲把投机解码移植进 nano-vllm 后改动的 8 个文件，覆盖到 nano-vllm 的同名位置即可。**没有在 GPU 上验证过**；`nano_spec/check_spec.py` 是在 GPU 上验证的脚本。

## 第 16 篇：解读 vLLM、SGLang

```bash
cd third_party
git clone --filter=blob:none --sparse https://github.com/vllm-project/vllm && cd vllm && git checkout 821851e
git sparse-checkout set --no-cone '/vllm/v1/' '/vllm/engine/' '/vllm/config/' '/vllm/entrypoints/llm.py' '/vllm/entrypoints/openai/' '/LICENSE' && cd ..
git clone --filter=blob:none --sparse https://github.com/sgl-project/sglang && cd sglang && git checkout 48da6bd
git sparse-checkout set python/sglang/srt/managers python/sglang/srt/mem_cache python/sglang/srt/model_executor python/sglang/srt/constrained python/sglang/srt/entrypoints python/sglang/srt/arg_groups && cd ../..
.venv/bin/python bench/engine_loc.py                                 # 三个引擎关键文件的行数
.venv/bin/python bench/trace_flag.py long_prefill_token_threshold    # 在 vLLM 源码里顺着一个配置项找代码
```

两个仓库都只读不运行（需要 NVIDIA GPU）；网站构建时会读取其中的文件。

