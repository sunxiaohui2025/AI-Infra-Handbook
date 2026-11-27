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
| 总览 | 总 PV/UV、今日、近 7 天、回访率、待处理反馈；近 30 天 PV 走势图（柱顶显示数值） |
| 全球学习地图 | 按访客 IP 归属地聚合「最近 30 分钟在线」读者，信标落在真实经纬度上；每 3 分钟轮询刷新。Cloudflare 用 `request.cf`，Node 版读取网关注入的 `CF-IPCountry` / `X-Vercel-Ip-*` 等请求头；取不到地理位置的访客不计入地图（不造假） |

> **D1 用量优化（免费版每天 500 万 `rows_read`）**：
> - 排行榜改用 `MAX(ts)` + bare column 一次扫描取最新标题，去掉了原来每个分组都再查一次的相关子查询（官方用量分析里单次读 16,328 行、占 41% 的头号消耗）。
> - 重查询走两级缓存：L1 内存（最多 1 分钟，命中 0 次读）+ L2 `stats_cache` 表（`stats`/`lectures` 1 小时、留言板 3 分钟，跨 isolate 共享，命中只读 1 行）。刷新再频繁，TTL 内也只重算一次。
> - `schema_meta` 记录结构版本，建表/补列/建索引只在版本升级时执行一次（此前每次请求都跑 `ALTER`，24 小时静默失败 600+ 次）。
> - 完整统计 `GET /api/admin/stats` 只在首屏加载一次；定时（3 分钟）只调轻量的 `GET /api/admin/presence`；前端停留心跳放宽到 60 秒。
> - 写留言、管理员回复、改状态会立即清掉相关缓存，留言板和待处理数不会滞后。`visitors.last_seen/first_seen/visit_count` 与 `pageviews(ts, vid, dwell)` 均已建索引。

| 每讲热度 | 按 `/l/讲号` 的浏览量排行 + 平均停留时长，可看哪些讲最受欢迎、哪几讲大家停留最久 |
| 访客明细 | 匿名 ID 列表（IP/首访/最近/回访次数/浏览量/停留），点一行展开浏览轨迹（含每页停留） |
| 反馈意见（公开留言板） | 用户通过 `/feedback` 提交的留言，所有人可见内容和管理员逐条回复；回复需校验 `ADMIN_PASSWORD`，可标记 处理/忽略/重置。公开的 `/api/board` 不返回联系方式、IP、UA、`vid` |
| PDF电子书下载 | 顶栏「全文PDF」点击次数（累计 + 今日 `today`），走独立的 `/api/admin/pdfstats`（3 分钟缓存），不混入访问 PV/UV；前台点击时上报 `/api/pdfdl` |

> **停留时长**：前端页面加载后每 60 秒心跳上报一次 `/api/dwell`（离开/切后台时补发剩余时长），只计“页面可见”的时间。上报的是距上次心跳的真实秒数，放宽间隔不影响累计值，但 D1 写入次数降到原来的 1/3。后端在 `pageviews.dwell` 列累加秒数，热度/总览/访客明细都带 `dwell`（总秒）与 `avgDwell`（平均秒）。

## 接口

- 公开
  - `POST /api/track` — 上报一次浏览，body `{ vid, path, title }` → `{ ok, id }`（`id` 为本次 pageview，供停留心跳用）；服务端另取客户端 IP（有 `X-Forwarded-For`/`X-Real-IP` 则优先，适合放 nginx/CDN 反代后）
  - `POST /api/dwell` — 停留心跳，body `{ vid, id, dt }`，把 `dt` 秒累加到该访客自己那条 pageview 的 `dwell`（防止刷别人）
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

### Cloudflare（如果你已把站点发到 Workers / Pages）

不需要单独的 Node 服务——本后台可作为 **同域的 Cloudflare Worker** 一起部署：前端 `/api/*` 埋点/反馈直接打到 Worker，由 **D1（SQLite 兼容）** 存数据，**无需 `PUBLIC_BACKEND_BASE`**。

配套文件：`admin/worker.js`（Worker 版）、`admin/schema.sql`（D1 表结构）、`admin/deploy/deploy-cloudflare.sh`（部署脚本）、`scripts/copy-admin.mjs`（构建时把后台拷进 `dist/admin`）。

#### 方式一：在 Cloudflare Pages 项目里配置（推荐，构建环境自动认证）

在 Pages 项目的「构建设置」里：

| 字段 | 填什么 |
| --- | --- |
| 构建命令 (Build command) | `npm run build` |
| 部署命令 (Deploy command) | `bash admin/deploy/deploy-cloudflare.sh` |
| 环境变量 | 新增一个 **Secret** 类型变量 `ADMIN_PASSWORD`，值是后台登录口令 |

`npm run build` 现在会顺带把 `admin/public` 拷进 `dist/admin`；部署命令会自动：创建/复用 D1 `ai-infra-handbook-db` → 把 `database_id` 写进 `wrangler.jsonc` → 应用 `schema.sql` → 把 `ADMIN_PASSWORD` 写成 Workers 密文 → `wrangler deploy`。

#### 方式二：在自己有 wrangler 登录的终端里

```bash
# 0) 登录（只需一次）
npx wrangler login

# 1) 部署（在 site/ 目录下）
sh admin/deploy/deploy-cloudflare.sh
#    或指定口令：ADMIN_PASSWORD=你的口令 sh admin/deploy/deploy-cloudflare.sh
```

部署后：

```
前端:  https://<你的>.workers.dev
后台:  https://<你的>.workers.dev/admin
```

`/admin`（无斜杠）会自动 302 到 `/admin/`；站点页面、`/admin/*` 走静态资源，`/api/*` 由 Worker 处理并读写 D1。

> **后台口令**：`wrangler.jsonc` 的 `vars.ADMIN_PASSWORD` 里有一个默认口令（`infra2026`），部署后即可登录 `/admin`。仓库是私有的，所以能放这里；若想改用密文且不落库，可在 Worker 控制台 **Settings → Variables and Secrets** 加一个 `ADMIN_PASSWORD` 密文，它会优先于 `vars`。

> 若部署报 `binding DB of type d1 must have a valid database_id`（code 10021），说明 D1 还没建、`wrangler.jsonc` 里的 `database_id` 还是占位符 `__D1_ID__`。用上面任一方式跑一次（脚本会自动建库并写入真实 id）即可；别手动跑 `wrangler deploy`。

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
- 表：`visitors`（访客），`pageviews`（每次浏览），`feedback`（反馈），`sessions`（后台登录会话），`pdf_downloads`（PDF 全文下载事件），`stats_cache`（看板结果缓存），`schema_meta`（表结构版本号）。缓存表只存派生结果，随时可清空，不影响原始访问数据；备份时整库导出即可，恢复后缓存过期会自动重算。
