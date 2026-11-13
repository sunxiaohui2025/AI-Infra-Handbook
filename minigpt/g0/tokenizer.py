"""BPE 分词器：从字符出发合并，生僻字退回到字节（第 52 讲）。

词表的编号这样排：
  0–255      256 个字节（生僻字、没见过的字拆成 UTF-8 字节，任何文字都能编码）
  256        <|endoftext|>（文章之间的分隔符）
  257 起     语料里出现过至少 min_freq 次的字符
  再往后     按学到的顺序排的合并结果
"""
import json
import re
from collections import Counter, defaultdict

EOT = "<|endoftext|>"
# 预切分：英文单词、单个数字、一串连续的汉字、单个空白、单个其他符号。合并只在一块之内发生。
CHUNK = re.compile(r"[A-Za-z]+|[0-9]|[\u4e00-\u9fff]+|\s|[^\sA-Za-z0-9\u4e00-\u9fff]")


class Tokenizer:
    def __init__(self):
        self.vocab: list[bytes] = [bytes([i]) for i in range(256)] + [EOT.encode()]
        self.char_id: dict[str, int] = {}             # 字符 → 编号
        self.merges: dict[tuple[int, int], int] = {}  # (左, 右) → 合并后的编号，编号越小越先合并
        self.cache: dict[str, list[int]] = {}

    @property
    def eot(self) -> int:
        return 256

    def __len__(self):
        return len(self.vocab)

    # ---------- 训练 ----------
    def train(self, text: str, vocab_size: int, min_freq: int = 3):
        chunks = Counter(c for part in text.split(EOT) for c in CHUNK.findall(part))
        chars = Counter()
        for c, n in chunks.items():
            for ch in c:
                chars[ch] += n
        for ch, n in sorted(chars.items(), key=lambda x: (-x[1], x[0])):   # 常见的字编号小
            if n >= min_freq:
                self.char_id[ch] = len(self.vocab)
                self.vocab.append(ch.encode())

        words = [self._base(c) for c in chunks]      # 每个不同的块一份 id 序列
        freq = list(chunks.values())                 # 这个块在语料里出现了几次
        pairs, where = Counter(), defaultdict(set)   # 相邻对的总次数；每个对出现在哪些块里
        for i, w in enumerate(words):
            for p in zip(w, w[1:]):
                pairs[p] += freq[i]
                where[p].add(i)

        while len(self.vocab) < vocab_size and pairs:
            best = max(pairs, key=lambda p: (pairs[p], -p[0], -p[1]))   # 次数最多；平局取编号小的
            if pairs[best] < 2:
                break
            new = len(self.vocab)
            self.merges[best] = new
            self.vocab.append(self.vocab[best[0]] + self.vocab[best[1]])
            for i in list(where[best]):              # 只更新含有这一对的块
                w = words[i]
                for p in zip(w, w[1:]):              # 先把这个块原来的相邻对减掉
                    pairs[p] -= freq[i]
                    if pairs[p] == 0:
                        del pairs[p]
                words[i] = w = self._merge(w, best, new)
                for p in zip(w, w[1:]):              # 再把合并后的相邻对加回来
                    pairs[p] += freq[i]
                    where[p].add(i)
            del where[best]
        self.cache.clear()

    @staticmethod
    def _merge(ids, pair, new):
        out, i = [], 0
        while i < len(ids):
            if i + 1 < len(ids) and (ids[i], ids[i + 1]) == pair:
                out.append(new)
                i += 2
            else:
                out.append(ids[i])
                i += 1
        return out

    def _base(self, chunk: str) -> list[int]:
        out = []
        for ch in chunk:
            if ch in self.char_id:
                out.append(self.char_id[ch])
            else:
                out.extend(ch.encode("utf-8"))       # 字节回退：生僻字拆成 UTF-8 字节
        return out

    # ---------- 编码、解码 ----------
    def _encode_chunk(self, chunk: str) -> list[int]:
        if chunk in self.cache:
            return self.cache[chunk]
        ids = self._base(chunk)
        while len(ids) >= 2:
            # 在所有相邻对里，找最早学到的那条合并规则
            p = min(zip(ids, ids[1:]), key=lambda q: self.merges.get(q, 1 << 30))
            if p not in self.merges:
                break
            ids = self._merge(ids, p, self.merges[p])
        self.cache[chunk] = ids
        return ids

    def encode(self, text: str) -> list[int]:
        out = []
        for k, part in enumerate(text.split(EOT)):
            if k:
                out.append(self.eot)
            for c in CHUNK.findall(part):
                out.extend(self._encode_chunk(c))
        return out

    def decode(self, ids: list[int]) -> str:
        return b"".join(self.vocab[i] for i in ids).decode("utf-8", errors="replace")

    # ---------- 存取 ----------
    def save(self, path: str):
        json.dump({"chars": list(self.char_id), "merges": [list(p) for p in self.merges]},
                  open(path, "w", encoding="utf-8"), ensure_ascii=False)

    @classmethod
    def load(cls, path: str) -> "Tokenizer":
        t, d = cls(), json.load(open(path, encoding="utf-8"))
        for ch in d["chars"]:
            t.char_id[ch] = len(t.vocab)
            t.vocab.append(ch.encode())
        for a, b in d["merges"]:
            t.merges[(a, b)] = len(t.vocab)
            t.vocab.append(t.vocab[a] + t.vocab[b])
        return t
