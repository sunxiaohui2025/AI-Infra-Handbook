# 访问统计数据备份

运营后台的真实访问数据存在 **Cloudflare D1**（线上）；本地 `data/app.db` 是本地开发/运行库。两套都要留意，下面分别说明。

备份文件含访问 IP 等数据，`admin/backups/` 已加入 `.gitignore`，不会进 Git 仓库。

## 1. 本地库备份（已配置自动）

- **自动**：已设置定时任务「备份 AI Infra 访问统计数据」，每天 **03:30** 自动运行 `backup-local.py`。
- **手动**：在 `site/` 目录下执行：
  ```bash
  python3 admin/backup-local.py
  ```
- **输出**：`admin/backups/app-YYYYMMDD-HHMMSS.db`（SQLite 一致性快照）+ `manifest.json`（时间/大小/各表行数）。
- **保留策略**：只留最近 14 份，更旧的自动删除。可用环境变量 `BACKUP_KEEP` 调整份数。
- **恢复**：停掉后台服务，把某份 `.db` 复制回 `admin/data/app.db` 即可；也可直接用 sqlite3 打开查询。
- **下载**：`admin/backups/` 下的 `.db` 文件可直接下载；manifest.json 记录了该备份的内容概要。

脚本用 SQLite 官方 `backup()` API，服务运行中备份也安全，且会做 `integrity_check` 校验。

## 2. 线上 D1 备份（Cloudflare 控制台 / wrangler）

线上真实数据在 D1 数据库 `ai-infra-handbook-db`。建议**定期导出**一份留存。

### 方式 A：Cloudflare 控制台（无需命令行登录）
1. 打开 <https://dash.cloudflare.com> → 选择账号 → 左侧 **Workers & Pages** → **D1**。
2. 点击数据库 **ai-infra-handbook-db**。
3. 进入 **Data** 标签页，浏览确认数据。
4. 点击 **Export**（导出）→ 选择 **SQL** 格式 → 下载 `.sql` 文件到本地。
5. 把下载的文件放进 `admin/backups/` 并改名带上日期，例如 `d1-ai-infra-handbook-db-20261124.sql`。

> 控制台的 D1 导出入口可能随界面调整；若找不到 Export，见方式 B。

### 方式 B：wrangler 脚本（需先登录）
```bash
npx wrangler login                 # 首次登录 Cloudflare
bash admin/backup-d1.sh            # 在 site/ 目录下运行
```
脚本会自动读取 `wrangler.jsonc` 里的库名/ID，导出到 `admin/backups/d1-<库名>-<时间戳>.sql`，并保留最近 14 份。
也可设置 `CLOUDFLARE_API_TOKEN` 环境变量做无交互导出（适合放进服务器 cron）。

### 恢复 D1（需要时）
```bash
npx wrangler d1 execute ai-infra-handbook-db --remote --file=admin/backups/d1-xxx.sql
```

## 3. 建议

- D1 免费版每日读取有限额（详见 D1 用量优化说明）；导出操作也会消耗读取额度，**不用过于频繁**，每周或每月一次即可。
- 重要的节点（如上线大改、数据清理前）手动导出一次。
- 如需异地容灾，把 `admin/backups/` 同步一份到云盘或对象存储。
