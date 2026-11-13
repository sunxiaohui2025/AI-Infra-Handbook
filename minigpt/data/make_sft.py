"""从课程目录（site/src/data/course.ts）生成指令微调的数据 data/sft.json（第 59 讲）。

每一讲有“技术点”和“解决什么问题”两栏，正好可以出两种题：
  技术点 → 问题：“用一句话说明 KV Cache 解决什么问题。” → “怎么避免重复计算历史 token”
  问题 → 技术点：“哪个技术点回答了：怎么避免重复计算历史 token？” → “KV Cache”
固定种子打乱后，每 10 讲留 1 讲做测试：这一讲的两道题都不进训练集。
用法：python data/make_sft.py
"""
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
COURSE = os.path.join(HERE, "..", "..", "site", "src", "data", "course.ts")

rows = re.findall(r"^  '(\d+)\|([^|]+)\|([^|]+)\|[^']*',$", open(COURSE, encoding="utf-8").read(), flags=re.M)
items = []
for part, title, q in rows:
    if int(part) >= 15:                     # 第五章是项目讲，“问题”栏写法不同，不收
        continue
    title = re.sub(r"\s*⭐|（选读）", "", title).strip()
    title = re.sub(r"^g\d · ", "", title)
    items.append((title, q.strip()))

random.seed(0)
random.shuffle(items)
data = {"train": [], "test": []}
for k, (title, q) in enumerate(items):
    split = "test" if k % 10 == 0 else "train"
    data[split].append({"instruction": f"用一句话说明“{title}”解决什么问题。", "output": q})
    data[split].append({"instruction": f"哪个技术点回答了：{q.rstrip('？?')}？", "output": title})
json.dump(data, open(os.path.join(HERE, "sft.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(items)} 讲 → 训练 {len(data['train'])} 条，测试 {len(data['test'])} 条")
print("例：", json.dumps(data["train"][0], ensure_ascii=False))
