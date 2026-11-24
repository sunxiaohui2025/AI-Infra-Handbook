#!/usr/bin/env python3
"""本地 SQLite 访问数据备份（一致性快照 + 自动清理旧备份）。

用法：
    python3 admin/backup-local.py

行为：
- 用 sqlite3 官方 backup API 生成一致性快照，服务运行中也能安全备份；
- 备份到 admin/backups/app-YYYYMMDD-HHMMSS.db；
- 校验备份完整性（integrity_check）与关键表行数；
- 只保留最近 KEEP 份（默认 14），更旧的自动删除；
- 每次备份写一个 manifest.json，记录时间与行数，方便核对。
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ADMIN_DIR = Path(__file__).resolve().parent
SRC = Path(os.environ.get("AI_DB", ADMIN_DIR / "data" / "app.db"))
# BACKUP_DIR 可用环境变量覆盖（便于测试隔离）；默认真实备份目录
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", ADMIN_DIR / "backups"))
KEEP = int(os.environ.get("BACKUP_KEEP", "14"))
TABLES = ("visitors", "pageviews", "feedback", "sessions")


def counts(conn):
    out = {}
    for t in TABLES:
        try:
            out[t] = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        except sqlite3.Error:
            out[t] = -1
    return out


def main():
    if not SRC.exists():
        print(f"✗ 源库不存在: {SRC}")
        sys.exit(1)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = BACKUP_DIR / f"app-{ts}.db"

    src_conn = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)
    dst_conn = sqlite3.connect(dst)
    try:
        src_conn.backup(dst_conn)  # 一致性在线备份
        check = dst_conn.execute("PRAGMA integrity_check").fetchone()[0]
        if check != "ok":
            print(f"✗ 备份完整性校验失败: {check}")
            sys.exit(1)
        row_counts = counts(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()

    size = dst.stat().st_size
    manifest = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "source": str(SRC),
        "file": dst.name,
        "size_bytes": size,
        "integrity": "ok",
        "rows": row_counts,
    }
    (BACKUP_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"✓ 备份完成: {dst}")
    print(f"  大小 {size} 字节 · 完整性 ok · 行数 {row_counts}")

    # 清理旧备份（按文件名时间戳排序，保留最近 KEEP 份）
    backups = sorted(
        [p for p in BACKUP_DIR.glob("app-*.db") if re.match(r"app-\d{8}-\d{6}\.db$", p.name)],
        key=lambda p: p.name,
    )
    removed = 0
    for old in backups[:-KEEP] if len(backups) > KEEP else []:
        old.unlink()
        removed += 1
    print(f"  当前保留 {min(len(backups), KEEP)}/{KEEP} 份，已清理 {removed} 份旧备份")


if __name__ == "__main__":
    main()
