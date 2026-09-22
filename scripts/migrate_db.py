"""
SQLite → 外部数据库迁移脚本（MySQL / PostgreSQL，一次性，幂等可重跑）。

用法:
    # 目标库通过环境变量指定（与网关运行时同名变量）
    DATABASE_URL=mysql+aiomysql://user:pass@host:3306/dbname \
        python scripts/migrate_db.py [--source ./data/gateway.db] [--dry-run]

    DATABASE_URL=postgresql+asyncpg://user:pass@host:5432/dbname \
        python scripts/migrate_db.py

行为:
- 逐表"清空目标表 → 全量插入"，保 ID / 主键，可重复执行（重跑覆盖）。
- 源库中不存在的表（新版本新增的表）自动跳过。

注意:
- 迁移前请先让目标库建好表：对空库执行
  `python -c "import sys; sys.path.insert(0,'any_gateway'); import asyncio; from db.database import init_db; asyncio.run(init_db())"`
  或先启动一次网关（lifespan 会建表/补列），再执行本脚本。
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sqlite3
import sys
from pathlib import Path

# 让脚本能以 `python scripts/migrate_db.py` 从仓库根目录运行
_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT / "any_gateway"))

import db.models  # noqa: F401,E402 - 注册全部表到 metadata
from sqlalchemy import text as sa_text  # noqa: E402
from sqlmodel import SQLModel  # noqa: E402

# 按外键依赖排序的迁移顺序（父表在前）
_TABLE_ORDER = [
    "user_groups",
    "users",
    "admin_users",
    "channels",
    "tokens",
    "vouchers",
    "user_group_memberships",
    "group_channels",
    "rate_limits",
    "model_prices",
    "group_model_prices",
    "usage_logs",
    "rate_limit_counters",
    "app_config",
]

_SUPPORTED_PREFIXES = ("mysql", "postgresql")


def read_sqlite_tables(source: Path) -> dict[str, list[dict]]:
    conn = sqlite3.connect(source)
    conn.row_factory = sqlite3.Row
    try:
        existing = {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        data: dict[str, list[dict]] = {}
        for table in _TABLE_ORDER:
            if table not in existing:
                print(f"  跳过 {table}（源库不存在）")
                continue
            rows = [dict(r) for r in conn.execute(f"SELECT * FROM {table}")]
            data[table] = rows
        return data
    finally:
        conn.close()


async def migrate(source: Path, target_url: str, dry_run: bool = False) -> None:
    from sqlalchemy.ext.asyncio import create_async_engine

    if not target_url.startswith(_SUPPORTED_PREFIXES):
        print(
            f"错误：目标 DATABASE_URL 必须以 {' 或 '.join(_SUPPORTED_PREFIXES)} 开头, 当前: {target_url}"
        )
        sys.exit(2)
    if not source.exists():
        print(f"错误：源库不存在: {source}")
        sys.exit(2)

    print(f"读取源库: {source}")
    data = read_sqlite_tables(source)
    total = sum(len(rows) for rows in data.values())
    print(f"待迁移 {len(data)} 张表 / {total} 行 → {target_url.split('@')[-1]}")

    if dry_run:
        for table, rows in data.items():
            print(f"  {table}: {len(rows)} 行")
        print("dry-run 结束，未写入。")
        return

    engine = create_async_engine(target_url, pool_pre_ping=True)
    metadata = SQLModel.metadata
    try:
        async with engine.begin() as conn:
            for table_name in _TABLE_ORDER:
                if table_name not in data:
                    continue
                table = metadata.tables[table_name]
                rows = data[table_name]
                # 表名均为简单标识符，无需引号（MySQL 默认不用双引号）
                await conn.execute(sa_text(f"DELETE FROM {table_name}"))
                if rows:
                    await conn.execute(table.insert(), rows)
                print(f"  {table_name}: {len(rows)} 行已写入")
        print("迁移完成。")
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="SQLite → MySQL/PostgreSQL 迁移")
    parser.add_argument(
        "--source", default="./data/gateway.db", help="源 SQLite 文件路径"
    )
    parser.add_argument(
        "--target",
        default=None,
        help="目标 DATABASE_URL（默认取环境变量 DATABASE_URL，mysql:// 或 postgresql://）",
    )
    parser.add_argument("--dry-run", action="store_true", help="只统计不写入")
    args = parser.parse_args()

    target = args.target or os.getenv("DATABASE_URL", "")
    asyncio.run(migrate(Path(args.source), target, dry_run=args.dry_run))


if __name__ == "__main__":
    main()
