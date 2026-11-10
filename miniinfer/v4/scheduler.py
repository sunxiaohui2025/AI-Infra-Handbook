"""v3：调度器按块的数量决定放谁进来；块不够时，把最晚进来的请求抢占回等待队列（之后重算）。"""
from collections import deque
from sequence import Status


class Scheduler:
    def __init__(self, block_manager, max_num_seqs=8, max_num_tokens=2048):
        self.bm = block_manager
        self.max_num_seqs = max_num_seqs
        self.max_num_tokens = max_num_tokens
        self.waiting, self.running = deque(), []
        self.num_preempted = 0
        self.num_cached = 0                         # 一共有多少个位置是前缀缓存命中、没有重算的

    def add(self, seq):
        self.waiting.append(seq)

    def schedule(self):
        # 1. 正在运行的请求各 decode 一个 token；下一个位置要进新块时先拿块，拿不到就抢占
        batch = []
        for seq in list(self.running):
            if seq not in self.running:             # 已经在本轮被抢占了
                continue
            while not self.bm.append_slot(seq):
                victim = self.running[-1]           # 抢占最晚进来的那个，把它的块让出来
                self.preempt(victim)
                if victim is seq:
                    break
            if seq in self.running:
                batch.append(seq)
        budget = self.max_num_tokens - len(batch)
        # 2. 有空位、有空闲块，就从等待队列放新请求进来做 prefill
        while self.waiting and len(batch) < self.max_num_seqs:
            seq = self.waiting[0]
            need = self.bm.blocks_needed(len(seq.tokens))
            if len(seq.tokens) > budget or need > self.bm.num_free():
                break
            self.waiting.popleft()
            seq.num_computed = self.bm.allocate(seq)  # 前缀缓存命中的部分不用再算
            self.num_cached += seq.num_computed
            seq.status = Status.RUNNING
            self.running.append(seq)
            batch.append(seq)
            budget -= len(seq.tokens) - seq.num_computed
        return batch

    def preempt(self, seq):
        # 抢占：释放它所有的块，放回等待队列最前面；它已经生成的 token 留着，下次连同提示一起重算
        self.running.remove(seq)
        self.bm.release(seq)
        seq.num_computed, seq.status = 0, Status.WAITING
        seq.cache = None
        self.waiting.appendleft(seq)
        self.num_preempted += 1

    def finish(self, seq):
        seq.status = Status.FINISHED
        self.running.remove(seq)
        self.bm.release(seq)
        seq.cache = None

    def has_work(self):
        return bool(self.waiting or self.running)
