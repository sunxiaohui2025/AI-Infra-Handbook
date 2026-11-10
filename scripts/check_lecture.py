"""检查已写好的讲，不用打开浏览器。

用法（在 site/ 目录下，先 npx astro build）：
    python3 scripts/check_lecture.py 4        # 检查第 4 讲
    python3 scripts/check_lecture.py          # 检查所有已写的讲

检查三件事：
  1. 文章里的 ```python 代码块在 tinylm/ 目录下实际运行，输出与紧跟其后的 ```text 块逐字一致；
  2. 构建出的页面（dist/l/N/index.html）存在，正文里没有残留的 ** 或 `（加粗、代码没渲染成功）；
  3. 文章的二级标题列表（方便快速看结构）。
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent
LECTURES = SITE / "src" / "content" / "lectures"
TINYLM = SITE.parent / "tinylm"


def lecture_files(which):
    files = sorted(LECTURES.glob("*.mdx"))
    if which is None:
        return files
    return [f for f in files if re.search(rf"^\s*id:\s*{which}\s*$", f.read_text(encoding="utf-8"), re.M)]


def check_code(text):
    """每个 python 代码块后面如果紧跟一个 text 代码块，就当作它的期望输出。"""
    problems = []
    # 代码组不能跨过 ```：没有紧跟输出的代码块（比如只示意、不运行的 PyTorch 片段）就跳过
    pairs = re.findall(r"```python\n((?:(?!```).)*?)```(?:(?!```python).)*?```text\n(.*?)```", text, re.S)
    for i, (code, expected) in enumerate(pairs, 1):
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(code)
        r = subprocess.run([sys.executable, "-I", f.name], cwd=TINYLM, capture_output=True, text=True, timeout=120)
        Path(f.name).unlink()
        if r.returncode != 0:
            problems.append(f"代码块 {i} 运行出错：\n{r.stderr.strip()}")
        elif r.stdout.strip() != expected.strip():
            problems.append(f"代码块 {i} 的输出和文中不一致。\n实际输出：\n{r.stdout.rstrip()}\n文中写的：\n{expected.rstrip()}")
    return len(pairs), problems


def check_page(lid):
    page = SITE / "dist" / "l" / str(lid) / "index.html"
    if not page.exists():
        return [f"没有找到 {page.relative_to(SITE)}，先运行 npx astro build"], []
    html = page.read_text(encoding="utf-8")
    body = re.sub(r"<pre.*?</pre>|<script.*?</script>|<style.*?</style>|<code.*?</code>", "", html, flags=re.S)
    text = re.sub(r"<[^>]+>", "", body)
    problems = []
    for mark in ("**", "`"):
        n = text.count(mark)
        if n:
            i = text.index(mark)
            problems.append(f"页面正文里有 {n} 处残留的 {mark}，例如：…{text[max(0, i - 20):i + 20]}…")
    heads = [re.sub(r"<[^>]+>", "", h) for h in re.findall(r"<h2[^>]*>(.*?)</h2>", html, re.S)]
    return problems, heads


def main():
    which = int(sys.argv[1]) if len(sys.argv) > 1 else None
    files = lecture_files(which)
    if not files:
        print("没有找到对应的讲。")
        sys.exit(1)
    failed = False
    for f in files:
        text = f.read_text(encoding="utf-8")
        lid = int(re.search(r"^\s*id:\s*(\d+)", text, re.M).group(1))
        n_code, p1 = check_code(text)
        p2, heads = check_page(lid)
        problems = p1 + p2
        if lid >= 36 and any(c in text for c in "「」『』"):
            problems.append("第 36 讲起不用直角引号「」『』，改用 “ ” 和 ‘ ’（见写作规范）")
        status = "通过" if not problems else "有问题"
        print(f"第 {lid:02d} 讲 {f.name}：{status}（核对了 {n_code} 段代码输出，{len(text)} 字符）")
        print("  小节：" + " / ".join(heads))
        for p in problems:
            failed = True
            print("  ✗ " + p.replace("\n", "\n    "))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
