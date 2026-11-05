# AI Infra 课程网站

按设计系统「AI Infra 课程」实现的静态站点（Astro 5 + MDX）。

## 本地运行

```bash
cd site
npm install
npm run dev
```

浏览器打开 http://localhost:4321 。

- `npm run build`：生成静态站点到 `site/dist/`（首页 + 14 个篇页 + 110 个文章页）。
- `npm run preview`：本地预览构建结果。

## 页面

| 地址 | 页面 |
| --- | --- |
| `/` | 首页 = 全部目录：5 章横排成 5 列（第一章第一列…第五章第五列），每列自上而下是本章各篇，篇卡里列出全部讲；顶部筛选框按讲名、问题、编号实时过滤，回车打开第一个结果 |
| `/p/<篇>` | 篇页：左侧本章目录树，右侧讲列表 |
| `/l/<讲>` | 文章页：左侧本章目录树，右侧衬线正文；`/l/<讲>#<小节名>` 直达小节 |
| `/search.json` | ⌘K 搜索索引（篇、讲、小节） |

顶栏：⌘K 或 `/` 打开搜索；「完整路线 / Infra 快速路线」切换会记在浏览器里。

## 目录结构

```
site/
  src/data/course.ts          课程结构（章、篇、110 讲、快速路线规则），导航和地图都从这里生成
  src/content/lectures/*.mdx  每讲一篇 MDX；没有文件的讲按 10 节模板显示占位
  src/components/             SideNav、MatrixStepper、MatmulCalc 等组件
  src/pages/                  首页、篇页、文章页、搜索索引
  src/styles/global.css       设计系统的 tokens + 组件样式
```

## 写一讲

在 `src/content/lectures/` 新建 `NN-slug.mdx`，头部元数据与大纲模板一致：

```yaml
---
id: 26
slug: self-attention
title: 自注意力
chapter: 2
part: 4
problem: 每个词怎么看到上下文
prereqs: [2, 3, 6, 22]
level: 主线
minutes: 25
demos: [MatrixStepper]
video: ""
formula: "<i>Q</i> = <i>X</i> · <i>W</i><sub>Q</sub>"   # 可选：标题下的核心公式
shape: "形状：(4×4) · (4×4) → 4×4"                    # 可选
---
```

正文第一段是「一句话」导语，之后用 `## 前置知识`、`## 问题引入` … `## 小结与下一讲` 九个二级标题。可参考 `03-matrix-multiplication.mdx`。

## 数字从哪来

手算和交互里的数字来自课程目录下的 `tinylm/tinylm.py` 生成的 `tinylm/tinylm.json`，组件直接 import 这个文件。改了权重或新增示例后，先运行：

```bash
cd tinylm && python tinylm.py
```
