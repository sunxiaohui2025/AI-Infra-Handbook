"""v4：在 v3 的基础上，加载权重后把线性层量化成 INT8。"""
import torch
from tokenizers import Tokenizer
from config import Config
from weights import load_weights
from model import Qwen3
from quant import quantize_model
from block_manager import KVPool, SeqKV, BlockManager
from sequence import Sequence
from scheduler import Scheduler


class LLM:
    def __init__(self, model_dir, device="cpu", dtype=torch.float32,
                 num_blocks=256, block_size=16, prefix_cache=False, quant=True, **sched_args):
        self.cfg = Config.load(model_dir)
        self.tok = Tokenizer.from_file(f"{model_dir}/tokenizer.json")
        w = load_weights(model_dir, dtype, device)
        self.weight_bytes = quantize_model(w) if quant else None   # (量化前, 量化后) 线性层的字节数
        self.model = Qwen3(self.cfg, w)
        self.device, self.dtype = device, dtype
        self.pool = KVPool(self.cfg, num_blocks, block_size, dtype, device)
        self.bm = BlockManager(num_blocks, block_size, prefix_cache)
        self.scheduler = Scheduler(self.bm, **sched_args)
        self.log = []                                    # 每一步的 (prefill 请求数, decode 请求数)

    def add_request(self, prompt_ids, max_new_tokens):
        seq = Sequence(prompt_ids, max_new_tokens)
        self.scheduler.add(seq)
        return seq

    def step(self):
        batch = self.scheduler.schedule()
        # 把 batch 里每个请求这一步的新 token 拼成一维，记下每个请求占哪一段
        tokens, pos, segs = [], [], []
        for seq in batch:
            if seq.cache is None:                        # 刚进 batch：块已经由调度器分好，这里包一层给模型用
                seq.cache = SeqKV(self.pool, seq.block_table)
            new = seq.new_tokens()
            segs.append((len(tokens), len(tokens) + len(new), seq.cache))
            pos += range(seq.num_computed, seq.num_computed + len(new))
            tokens += new
        n_prefill = sum(1 for s in batch if len(s.new_tokens()) > 1)
        self.log.append((n_prefill, len(batch) - n_prefill))
        logits = self.model.forward(torch.tensor(tokens, device=self.device),
                                    torch.tensor(pos, device=self.device), segs)
        nxt = logits.argmax(-1).tolist()                 # 贪心：每个请求各取打分最高的 token
        for seq, t in zip(batch, nxt):
            seq.num_computed = len(seq.tokens)           # 这一步送进去的 token 都已经写进缓存
            self.bm.register(seq)                        # 新装满的块登记进前缀缓存
            seq.tokens.append(t)
            if t == self.cfg.eos_token_id or seq.num_generated >= seq.max_new_tokens:
                self.scheduler.finish(seq)

    def generate(self, prompts, max_new_tokens):
        # prompts: 提示文本的列表；max_new_tokens: 一个数，或每个请求各一个数
        if isinstance(max_new_tokens, int):
            max_new_tokens = [max_new_tokens] * len(prompts)
        seqs = [self.add_request(self.tok.encode(p).ids, n) for p, n in zip(prompts, max_new_tokens)]
        while self.scheduler.has_work():
            self.step()
        return [s.tokens[s.num_prompt:] for s in seqs]

    def check_generate(self, prompts, max_new_tokens):
        return self.generate(prompts, max_new_tokens)
