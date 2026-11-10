"""v2：continuous batching 的调度器。每一步都重新决定 batch 里有谁。"""
from collections import deque
from sequence import Status


class Scheduler:
    def __init__(self, max_num_seqs=8, max_num_tokens=2048, static=False, kv_budget=None):
        self.max_num_seqs = max_num_seqs        # batch 里最多几个请求（同时占几份 KV Cache）
        self.max_num_tokens = max_num_tokens    # 一步最多送进模型多少个 token（限制 prefill 的大小）
        self.static = static                    # True：静态批处理，等整批都结束才放新请求进来
        self.kv_budget = kv_budget              # KV Cache 最多能放多少个位置（None 表示不限）
        self.kv_reserved = 0                    # 已经分出去的位置数：每个请求按“提示 + 最大输出”预留
        self.waiting, self.running = deque(), []

    def add(self, seq):
        self.waiting.append(seq)

    def schedule(self):
        # 1. 正在运行的请求，这一步各 decode 一个 token
        batch = list(self.running)
        budget = self.max_num_tokens - len(batch)
        # 2. 有空位就从等待队列里放新请求进来，这一步做它们的 prefill
        can_admit = not (self.static and self.running)
        while can_admit and self.waiting and len(batch) < self.max_num_seqs:
            seq = self.waiting[0]
            if seq.num_prompt > budget:         # 这一步的 token 预算不够了，下一步再说
                break
            need = seq.num_prompt + seq.max_new_tokens
            if self.kv_budget is not None and self.kv_reserved + need > self.kv_budget:
                break                           # KV Cache 的空间不够预留一整份了
            self.kv_reserved += need
            self.waiting.popleft()
            seq.status = Status.RUNNING
            self.running.append(seq)
            batch.append(seq)
            budget -= seq.num_prompt
        return batch

    def finish(self, seq):
        seq.status = Status.FINISHED
        self.running.remove(seq)
        seq.cache = None                        # 释放这个请求的 KV Cache
        self.kv_reserved -= seq.num_prompt + seq.max_new_tokens

    def has_work(self):
        return bool(self.waiting or self.running)
