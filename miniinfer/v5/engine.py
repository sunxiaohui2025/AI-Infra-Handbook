"""v5：投机解码。decode 时每个请求带上几个草稿 token 一起送进模型，一步验证、可能一次接受好几个。"""
import torch
from tokenizers import Tokenizer
from config import Config
from weights import load_weights
from model import Qwen3
from quant import quantize_model
from spec import propose, verify
from block_manager import KVPool, SeqKV, BlockManager
from sequence import Sequence
from scheduler import Scheduler


class LLM:
    def __init__(self, model_dir, device="cpu", dtype=torch.float32,
                 num_blocks=256, block_size=16, prefix_cache=False, quant=False, num_draft=4, **sched_args):
        self.cfg = Config.load(model_dir)
        self.tok = Tokenizer.from_file(f"{model_dir}/tokenizer.json")
        w = load_weights(model_dir, dtype, device)
        self.weight_bytes = quantize_model(w) if quant else None   # (量化前, 量化后) 线性层的字节数
        self.model = Qwen3(self.cfg, w)
        self.device, self.dtype = device, dtype
        self.pool = KVPool(self.cfg, num_blocks, block_size, dtype, device)
        self.bm = BlockManager(num_blocks, block_size, prefix_cache)
        self.scheduler = Scheduler(self.bm, num_draft=num_draft, **sched_args)
        self.num_draft = num_draft
        self.num_accepted = 0                            # 一共接受了多少个草稿 token
        self.log = []                                    # 每一步的 (prefill 请求数, decode 请求数)

    def add_request(self, prompt_ids, max_new_tokens):
        seq = Sequence(prompt_ids, max_new_tokens)
        self.scheduler.add(seq)
        return seq

    def step(self):
        batch = self.scheduler.schedule()
        tokens, pos, segs, out_idx, drafts = [], [], [], [], []
        for seq in batch:
            if seq.cache is None:
                seq.cache = SeqKV(self.pool, seq.block_table)
            new = seq.new_tokens()
            # decode 的请求：在已有 token 里找草稿，接在最后一个 token 后面一起送进去
            draft = propose(seq.tokens, self.num_draft) if len(new) == 1 and self.num_draft else []
            room = seq.max_new_tokens - seq.num_generated - 1
            draft = draft[:max(room, 0)]                 # 草稿不能超过剩下还能生成的数量
            new = new + draft
            a = len(tokens)
            segs.append((a, a + len(new), seq.cache))
            out_idx += range(a + len(new) - len(draft) - 1, a + len(new))   # 最后一个真实 token 和每个草稿位置的打分
            pos += range(seq.num_computed, seq.num_computed + len(new))
            tokens += new
            drafts.append(draft)
        n_prefill = sum(1 for s, d in zip(batch, drafts) if len(s.new_tokens()) > 1)
        self.log.append((n_prefill, len(batch) - n_prefill))
        logits = self.model.forward(torch.tensor(tokens, device=self.device),
                                    torch.tensor(pos, device=self.device), segs, out_idx)
        pred = logits.argmax(-1).tolist()
        k = 0
        for seq, draft in zip(batch, drafts):
            p, k = pred[k:k + len(draft) + 1], k + len(draft) + 1
            accepted = verify(draft, p)                  # 接受的草稿 + 模型自己预测的下一个 token
            self.num_accepted += len(accepted) - 1
            seq.num_computed = len(seq.tokens) + len(accepted) - 1   # 被拒绝的草稿位置作废，之后会被覆盖
            for t in accepted:
                seq.tokens.append(t)
                if t == self.cfg.eos_token_id or seq.num_generated >= seq.max_new_tokens:
                    break
            self.bm.register(seq)
            if seq.tokens[-1] == self.cfg.eos_token_id or seq.num_generated >= seq.max_new_tokens:
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
