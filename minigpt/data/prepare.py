"""把课程讲义（site/src/content/lectures/*.mdx）整理成纯文本语料 data/corpus.txt。

只保留正文段落：去掉元数据、import、组件、代码块、公式、表格和 Markdown 标记。
每一讲之间用 <|endoftext|> 隔开，告诉模型“这里换了一篇文章”。
仓库里已经放好了生成好的 corpus.txt（取自写第 7 篇之前已有的 121 讲，快照），
一般不需要重新运行；重新运行会把新写的讲也收进来，后面各讲的数字会跟着变。
用法：python data/prepare.py
"""
import glob
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
LECTURES = os.path.join(HERE, "..", "..", "site", "src", "content", "lectures")


def clean(s: str) -> str:
    s = re.sub(r"^---\n.*?\n---\n", "", s, flags=re.S)           # 元数据
    s = re.sub(r"^import .*$", "", s, flags=re.M)                # import 行
    s = re.sub(r"```.*?```", "", s, flags=re.S)                  # 代码块
    s = re.sub(r"\$\$.*?\$\$", "", s, flags=re.S)                # 公式
    s = re.sub(r"<([A-Z]\w*)\b[^>]*?/>", "", s, flags=re.S)      # 自闭合组件 <X ... />
    s = re.sub(r"<([A-Z]\w*)\b.*?</\1>", "", s, flags=re.S)      # 成对组件 <X>...</X>（Note 等）
    s = re.sub(r"<[^>]+>", "", s)                                # 剩下的 HTML 标签
    s = re.sub(r"^\|.*$", "", s, flags=re.M)                     # 表格
    s = re.sub(r"^#+\s*", "", s, flags=re.M)                     # 标题的 #
    s = re.sub(r"^\s*(?:[-*]|\d+\.)\s+", "", s, flags=re.M)      # 列表符号
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)               # 链接只留文字
    s = s.replace("**", "").replace("`", "")
    lines = [l.strip() for l in s.split("\n")]
    return "\n".join(l for l in lines if len(l) >= 8)            # 太短的行多半是残渣


def main():
    files = sorted(glob.glob(os.path.join(LECTURES, "*.mdx")), key=lambda p: int(os.path.basename(p).split("-")[0]))
    files = [p for p in files if not 52 <= int(os.path.basename(p).split("-")[0]) <= 59]   # 不收第 7 篇自己
    docs = [clean(open(p, encoding="utf-8").read()) for p in files]
    text = "\n<|endoftext|>\n".join(docs)
    out = os.path.join(HERE, "corpus.txt")
    open(out, "w", encoding="utf-8").write(text)
    print(f"{len(files)} 讲，{len(text):,} 个字符，写入 {os.path.relpath(out)}")


if __name__ == "__main__":
    main()
