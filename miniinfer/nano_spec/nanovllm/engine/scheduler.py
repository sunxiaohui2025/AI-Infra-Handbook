from collections import deque

from nanovllm.config import Config
from nanovllm.engine.sequence import Sequence, SequenceStatus
from nanovllm.engine.block_manager import BlockManager
from nanovllm.engine.spec import propose, verify


class Scheduler:

    def __init__(self, config: Config):
        self.max_num_seqs = config.max_num_seqs
        self.max_num_batched_tokens = config.max_num_batched_tokens
        self.eos = config.eos
        self.block_size = config.kvcache_block_size
        self.block_manager = BlockManager(config.num_kvcache_blocks, config.kvcache_block_size)
        self.num_spec_tokens = config.num_spec_tokens
        self.num_accepted = 0                     # 一共接受了多少个草稿 token
        self.waiting: deque[Sequence] = deque()
        self.running: deque[Sequence] = deque()

    def is_finished(self):
        return not self.waiting and not self.running

    def add(self, seq: Sequence):
        self.waiting.append(seq)

    def schedule(self) -> tuple[list[Sequence], bool]:
        scheduled_seqs = []
        num_batched_tokens = 0

        # prefill
        while self.waiting and len(scheduled_seqs) < self.max_num_seqs:
            seq = self.waiting[0]
            remaining = self.max_num_batched_tokens - num_batched_tokens
            if remaining == 0:
                break
            if not seq.block_table:
                num_cached_blocks = self.block_manager.can_allocate(seq)
                if num_cached_blocks == -1:
                    break
                num_tokens = seq.num_tokens - num_cached_blocks * self.block_size
            else:
                num_tokens = seq.num_tokens - seq.num_cached_tokens
            if remaining < num_tokens and scheduled_seqs:  # only allow chunked prefill for the first seq
                break
            if not seq.block_table:
                self.block_manager.allocate(seq, num_cached_blocks)
            seq.num_scheduled_tokens = min(num_tokens, remaining)
            num_batched_tokens += seq.num_scheduled_tokens
            if seq.num_cached_tokens + seq.num_scheduled_tokens == seq.num_tokens:
                seq.status = SequenceStatus.RUNNING
                self.waiting.popleft()
                self.running.append(seq)
            scheduled_seqs.append(seq)

        if scheduled_seqs:
            return scheduled_seqs, True

        # decode（可以带草稿）
        while self.running and len(scheduled_seqs) < self.max_num_seqs:
            seq = self.running.popleft()
            seq.draft = self.propose(seq, self.max_num_batched_tokens - num_batched_tokens)
            while not self.block_manager.can_append(seq, len(seq.draft)):
                if seq.draft:
                    seq.draft = []                    # 块不够：先放弃草稿，再考虑抢占别人
                elif self.running:
                    self.preempt(self.running.pop())
                else:
                    self.preempt(seq)
                    break
            else:
                seq.num_scheduled_tokens = 1 + len(seq.draft)
                num_batched_tokens += seq.num_scheduled_tokens
                seq.is_prefill = False
                self.block_manager.may_append(seq, len(seq.draft))
                scheduled_seqs.append(seq)
        assert scheduled_seqs
        self.running.extendleft(reversed(scheduled_seqs))
        return scheduled_seqs, False

    def propose(self, seq: Sequence, budget: int) -> list[int]:
        # 草稿数不超过：设定的上限、这个请求还能生成的数量减一、这一步剩下的 token 预算减一
        k = min(self.num_spec_tokens, seq.max_tokens - seq.num_completion_tokens - 1, budget - 1)
        return propose(seq.token_ids, k) if k > 0 else []

    def preempt(self, seq: Sequence):
        seq.status = SequenceStatus.WAITING
        seq.is_prefill = True
        self.block_manager.deallocate(seq)
        self.waiting.appendleft(seq)

    def postprocess(self, seqs: list[Sequence], token_ids: list[int], is_prefill: bool):
        i = 0
        for seq in seqs:
            draft, seq.draft = seq.draft, []
            pred = token_ids[i:i + 1 + len(draft)]    # 这个请求的 1 + 草稿数 个位置上采样出的 token
            i += 1 + len(draft)
            if is_prefill and seq.num_cached_tokens + seq.num_scheduled_tokens < seq.num_tokens:
                self.block_manager.hash_blocks(seq)   # 分块 prefill 的中间一段：不出 token
                seq.num_cached_tokens += seq.num_scheduled_tokens
                seq.num_scheduled_tokens = 0
                continue
            new = verify(draft, pred)                 # 没有草稿时就是 [pred[0]]，和原来一样
            self.num_accepted += len(new) - 1
            finished = False
            for n, token_id in enumerate(new, 1):
                seq.append_token(token_id)
                if (not seq.ignore_eos and token_id == self.eos) or seq.num_completion_tokens == seq.max_tokens:
                    finished = True
                    break
            if not is_prefill:
                # 回滚：KV 有效的只有最后一个真实 token 和被接受（并且追加了）的草稿
                seq.num_scheduled_tokens = min(n + 1, len(new))
            self.block_manager.hash_blocks(seq)       # 要在追加之后：被接受的草稿所在的块，这时才有完整的 token
            seq.num_cached_tokens += seq.num_scheduled_tokens
            seq.num_scheduled_tokens = 0
            if finished:
                seq.status = SequenceStatus.FINISHED
                self.block_manager.deallocate(seq)
                self.running.remove(seq)
            else:
                self.block_manager.trim(seq)
