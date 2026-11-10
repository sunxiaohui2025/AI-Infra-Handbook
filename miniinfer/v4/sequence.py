"""一个请求在引擎里的全部状态。"""
from enum import Enum, auto
from itertools import count


class Status(Enum):
    WAITING = auto()     # 还没进 batch
    RUNNING = auto()     # 在 batch 里，每步生成一个 token
    FINISHED = auto()    # 生成完了


class Sequence:
    _ids = count()

    def __init__(self, prompt_ids, max_new_tokens):
        self.id = next(Sequence._ids)
        self.tokens = list(prompt_ids)          # 提示 + 已生成的 token
        self.num_prompt = len(prompt_ids)
        self.max_new_tokens = max_new_tokens
        self.num_computed = 0                   # 有多少个位置的 K、V 已经在缓存里
        self.status = Status.WAITING
        self.cache = None                       # 进入 batch 时才分配 KV Cache

    @property
    def num_generated(self):
        return len(self.tokens) - self.num_prompt

    def new_tokens(self):
        # 这一步要送进模型的 token：prefill 时是整个提示，decode 时是最后生成的那一个
        return self.tokens[self.num_computed:]
