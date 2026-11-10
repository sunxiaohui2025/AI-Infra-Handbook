# 运营后台（独立服务）

给《AI Infra 学习网站》加的独立后端：**匿名访问统计 + 用户反馈收集 + 运营管理页面**。

- **零依赖**：只用 Node 内置 `http` + `node:sqlite`（Node 22.5+），不需要 `npm install`。
- **独立页面**：后台页在 `/admin`，与静态网站解耦，可放任何 Node 环境（本机、VPS、任意托管）。
- 数据存本地 SQLite 文件 `admin/data/app.db`（已 gitignore）。

## 快速开始

```bash
cd admin
node server.js
```

启动后按提示访问：

```
后台页面  http://localhost:8787/admin
统计接口  http://localhost:8787/api/*
当前口令  <首次运行自动生成的随机口令>
```

首次运行会在 `admin/config.json` 生成随机口令（**改它**，或设环境变量 `ADMIN_PASSWORD`），数据表自动建好。

### 设置口令

改 `admin/config.json` 里的 `adminPassword`，或启动前设环境变量：

```bash
ADMIN_PASSWORD=你的口令 PORT=8787 node server.js
```

> `config.json` 与 `data/` 都已 gitignore 不会入库。仓库里只有无敏感的 `config.example.json`。

## 后台功能

| 板块 | 内容 |
|---|---|
| 总览 | 总 PV/UV、今日、近 7 天、回访率、待处理反馈；近 14 天走势图 |
| 每讲热度 | 按 `/l/讲号` 的浏览量排行，可看哪些讲最受欢迎 |
| 访客明细 | 匿名 ID 列表（首访/最近/回访次数/浏览量），点一行展开浏览轨迹 |
| 反馈意见 | 用户通过 `/feedback` 提交的反馈，可标记 处理/忽略/重置 |

## 接口

- 公开
  - `POST /api/track` — 上报一次浏览，body `{ vid, path, title }`
  - `POST /api/feedback` — 提交反馈，body `{ vid, kind, content, page, contact }`
- 后台（需 `Authorization: Bearer <token>`，先 `POST /api/admin/login` 拿 token）
  - `POST /api/admin/login` — body `{ password }` → `{ token }`
  - `GET /api/admin/stats` — 总览 + 走势
  - `GET /api/admin/lectures` — 讲热度
  - `GET /api/admin/visitors[?vid=]` — 访客列表 / 单个访客轨迹
  - `GET /api/admin/feedback[?status=]` — 反馈列表
  - `POST /api/admin/feedback/:id` — body `{ status }`（done/ignored/new）
  - `POST /api/admin/logout`、`GET /api/admin/me`

## 让前端站点接入

前端埋点和反馈默认走**同源**（`BACKEND_BASE = ''`）。当后端独立部署在别的地址时，告诉前端后端在哪：

```bash
# 构建前端前设置环境变量（Astro 会内联）
PUBLIC_BACKEND_BASE=https://your-admin-host node_modules/.bin/astro build
```

或直接改 `site/src/data/site.ts` 里的 `BACKEND_BASE`。

- 埋点在 `site/src/layouts/Base.astro` 的 `<script>` 里调用 `track()`，全站页面自动上报。
- 反馈页 `site/src/pages/feedback.astro`，顶栏有「反馈」入口。
- 后端连不上时**不影响访客浏览**：埋点静默失败，反馈页会提示「提交失败」。

## 部署到哪里

任何能跑 Node 的环境都行，例如：

- 本机/内网：`node server.js`，用 `nohup` 或 pm2 常驻。
- VPS：配一个 systemd 服务或 `pm2 start server.js`。
- 想给全站用 HTTPS：在它前面挂 nginx/Caddy 反代，把 `/`、`/api/*`、`/admin/*` 代理到这个服务，前端 `BACKEND_BASE` 留空即可同源。

## 数据说明

- 「用户」= 浏览器 localStorage 里的匿名随机 ID（`ai_vid`），**不含姓名/手机/邮箱**。
- 回访判定：距上次浏览超过 30 分钟算一次新的回访。
- 表：`visitors`（访客），`pageviews`（每次浏览），`feedback`（反馈），`sessions`（后台登录会话）。
