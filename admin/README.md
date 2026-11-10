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
| 访客明细 | 匿名 ID 列表（IP/首访/最近/回访次数/浏览量），点一行展开浏览轨迹 |
| 反馈意见 | 用户通过 `/feedback` 提交的反馈，可标记 处理/忽略/重置 |

## 接口

- 公开
  - `POST /api/track` — 上报一次浏览，body `{ vid, path, title }`；服务端另取客户端 IP（有 `X-Forwarded-For`/`X-Real-IP` 则优先，适合放 nginx/CDN 反代后）
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

任何能跑 Node 的环境都行。

### 本机 / 内网
```bash
cd admin && node server.js   # 或 nohup / pm2 常驻
```

### VPS（推荐：systemd 一键部署）
把 `admin/` 整个传上服务器后：
```bash
cd admin/deploy
sudo bash install.sh                       # 默认端口 8787
# 或指定口令和端口：
sudo ADMIN_PASSWORD=你的口令 PORT=9000 bash install.sh
```
它会：装到 `/opt/ai-infra-admin`、以系统用户 `ai-infra-admin` 运行、开机自启、自动处理口令。

```bash
journalctl -u ai-infra-admin -f   # 看日志
sudo bash install.sh --uninstall  # 卸载（会删数据）
```

### Cloudflare（如果你已把站点发到 Workers）

如果前端已经部署在 `*.workers.dev`，不再需要单独的 Node 服务——本后台可作为 **同域的 Cloudflare Worker** 一起部署，前端 `/api/*` 埋点/反馈直接打到 Worker，由 **D1（SQLite 兼容）** 存数据，**无需 `PUBLIC_BACKEND_BASE`**。

配套文件：`admin/worker.js`（Worker 版）、`admin/schema.sql`（D1 表结构）、`admin/deploy/deploy-cloudflare.sh`（一键部署）。

```bash
# 0) 登录（只需一次）
npx wrangler login

# 1) 部署（在 site/ 目录下）
sh admin/deploy/deploy-cloudflare.sh
#    或指定口令：ADMIN_PASSWORD=你的口令 sh admin/deploy/deploy-cloudflare.sh
```

脚本自动完成：`astro build` → 把 `admin/public` 拷进 `dist/admin` → 创建/复用 D1 → 把 `database_id` 写进 `wrangler.jsonc` → 应用 `schema.sql` → 写入 `ADMIN_PASSWORD` 密文 → `wrangler deploy`。

部署后：

```
前端:  https://<你的>.workers.dev
后台:  https://<你的>.workers.dev/admin
```

`/admin`（无斜杠）会自动 302 到 `/admin/`；站点页面、`/admin/*` 走静态资源，`/api/*` 由 Worker 处理并读写 D1。

本地验证 Worker 逻辑（用 node:sqlite 模拟 D1，跑通全部接口）：

```bash
node admin/worker-test.mjs
```

> 若你更想要独立 Node 服务而非 Cloudflare，用上一节「VPS（推荐）」即可，两种方案并存、互不影响。

### HTTPS 反代
在它前面挂 nginx 或 Caddy，把 `/`、`/api/*`、`/admin/*` 代理到本地端口（如 `127.0.0.1:8787`）。

- nginx：`admin/deploy/nginx.conf.example`
- Caddy（自动 HTTPS）：`admin/deploy/Caddyfile.example`

把后台域名/地址设成前端 `PUBLIC_BACKEND_BASE` 即可同域联调；若前端和后台同域，留空即可。

## 数据说明

- 「用户」= 浏览器 localStorage 里的匿名随机 ID（`ai_vid`），**不含姓名/手机/邮箱**。
- 另记**最近一次客户端 IP**（服务端取，含反代转发链）；本地访问通常显示 `::1`/`127.0.0.1`，线上部署后显示真实公网 IP。若需更严格的匿名，可去掉 `server.js` 里的 `getClientIp`。

- 回访判定：距上次浏览超过 30 分钟算一次新的回访。
- 表：`visitors`（访客），`pageviews`（每次浏览），`feedback`（反馈），`sessions`（后台登录会话）。
