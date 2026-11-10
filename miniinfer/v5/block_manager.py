"""v3：分页的 KV Cache。所有请求共用一个块池，每个请求用一张块表记下自己的 KV 在哪些块里。"""
import torch


class KVPool:
    """一大块预先分配好的显存，切成 num_blocks 个块，每块放 block_size 个位置的 K、V。"""

    def __init__(self, cfg, num_blocks, block_size, dtype=torch.float32, device="cpu"):
        shape = (cfg.num_layers, num_blocks, block_size, cfg.num_kv_heads, cfg.head_dim)
        self.k = torch.zeros(shape, dtype=dtype, device=device)
        self.v = torch.zeros(shape, dtype=dtype, device=device)
        self.block_size = block_size


class SeqKV:
    """一个请求看到的 KV Cache。接口和 v1 的 KVCache 一样，所以 model.py 不用改。"""

    def __init__(self, pool, block_table):
        self.pool, self.table = pool, block_table

    def _slots(self, pos):
        # 第 p 个位置在第 table[p // B] 个块里的第 p % B 格
        B = self.pool.block_size
        table = torch.tensor(self.table, device=pos.device)
        return table[pos // B], pos % B

    def write(self, layer, pos, k, v):
        blk, off = self._slots(pos)
        self.pool.k[layer, blk, off] = k
        self.pool.v[layer, blk, off] = v

    def read(self, layer, end):
        # 按块表把这个请求的块取出来，拼成连续的 [end, KV 头数, head_dim]
        B = self.pool.block_size
        n = (end + B - 1) // B
        table = self.table[:n]
        k = self.pool.k[layer, table].reshape(-1, *self.pool.k.shape[3:])[:end]
        v = self.pool.v[layer, table].reshape(-1, *self.pool.v.shape[3:])[:end]
        return k, v


class BlockManager:
    """管块的分配和回收。前缀缓存（第 110 讲）也在这里：内容相同的整块可以被多个请求共用。"""

    def __init__(self, num_blocks, block_size, prefix_cache=False):
        self.block_size = block_size
        self.free = list(range(num_blocks))         # 空闲块的编号
        self.ref = [0] * num_blocks                 # 每个块被几个请求用着
        self.prefix_cache = prefix_cache
        self.hash_of = [None] * num_blocks          # 块里存的是哪段内容（只记装满的块）
        self.block_of = {}                          # 内容的哈希 → 块编号

    def num_free(self):
        return len(self.free)

    def _take(self):
        blk = self.free.pop(0)                      # 取最早空出来的块
        if self.hash_of[blk] is not None:           # 它原来缓存的内容要作废了
            del self.block_of[self.hash_of[blk]]
            self.hash_of[blk] = None
        self.ref[blk] = 1
        return blk

    def blocks_needed(self, n_tokens):
        return (n_tokens + self.block_size - 1) // self.block_size

    def allocate(self, seq):
        """请求进 batch：给它要算的全部 token（提示，被抢占过的还有已生成的部分）分配块。
        返回能直接复用的位置数（前缀缓存命中）。"""
        B, h, hit, n = self.block_size, None, 0, len(seq.tokens)
        seq.block_table, seq.block_hashes = [], []
        for i in range(self.blocks_needed(n)):
            chunk = tuple(seq.tokens[i * B:(i + 1) * B])
            full = len(chunk) == B
            h = hash((h, chunk)) if full else None  # 哈希连着前面所有块：前缀相同才算相同
            # 只复用不含最后一个 token 的整块：最后一个 token 总要算一遍，才能得到下一个 token 的打分
            if self.prefix_cache and full and h in self.block_of and hit == i * B and (i + 1) * B < n:
                blk = self.block_of[h]              # 命中：直接用别人算好的块
                if self.ref[blk] == 0:
                    self.free.remove(blk)
                self.ref[blk] += 1
                hit += B
            else:
                blk = self._take()
            seq.block_table.append(blk)
            seq.block_hashes.append(h)
        return hit

    def append_slot(self, seq, extra=0):
        """decode 前调用：保证块表能放下到第 len(tokens) + extra 个位置（extra 是草稿的个数）。拿不到返回 False。"""
        while len(seq.tokens) + extra > len(seq.block_table) * self.block_size:
            if not self.free:
                return False
            seq.block_table.append(self._take())
            seq.block_hashes.append(None)
        return True

    def register(self, seq):
        """一步算完后，把这个请求新装满的块登记进前缀缓存。"""
        if not self.prefix_cache:
            return
        B = self.block_size
        for i, blk in enumerate(seq.block_table):
            if (i + 1) * B > seq.num_computed:      # 这一块还没装满，或者还没算完
                break
            if seq.block_hashes[i] is None:         # decode 新装满的块：现在才知道它的内容
                prev = seq.block_hashes[i - 1] if i else None
                seq.block_hashes[i] = hash((prev, tuple(seq.tokens[i * B:(i + 1) * B])))
            h = seq.block_hashes[i]
            if self.hash_of[blk] is None and h not in self.block_of:
                self.block_of[h], self.hash_of[blk] = blk, h

    def release(self, seq):
        # 请求结束或被抢占：引用计数减一，没人用的块回到空闲列表（内容先留着，还可能被命中）
        for blk in reversed(seq.block_table):
            self.ref[blk] -= 1
            if self.ref[blk] == 0:
                self.free.append(blk)
        seq.block_table, seq.block_hashes = [], []
