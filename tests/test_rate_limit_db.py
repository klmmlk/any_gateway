"""
DB 固定窗口限流后端单元测试（替代原 test_rate_limit_redis.py）。

覆盖：key 构造、计数/求和语义、固定窗口翻转、并发原子性、fail open、
MySQL / PostgreSQL 方言编译验证。
"""
import asyncio
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlmodel import SQLModel, create_engine

# 确保 any_gateway 包路径在 sys.path 中
_REPO_ROOT = Path(__file__).parent.parent
_AG_PATH = _REPO_ROOT / "any_gateway"
if str(_AG_PATH) not in sys.path:
    sys.path.insert(0, str(_AG_PATH))

# 注意：db.database.engine 是模块级单例，被进程中首个导入它的测试文件锁定，
# 各测试文件设置的 DATABASE_URL 互不生效。因此本文件使用独立 engine，
# 在 fixture 里解析 services.rate_limit_db 的"当前"实例并打桩（而非模块级
# 绑定函数引用），保证 engine 替换与 patch 始终作用于同一模块对象。
_TEST_DB_PATH = Path(tempfile.gettempdir()) / f"any_gateway_rate_limit_db_{uuid4().hex}.db"

import db.models  # noqa: F401,E402 - 注册全部表到 metadata

_MY_ENGINE = create_async_engine(
    f"sqlite+aiosqlite:///{_TEST_DB_PATH}",
    connect_args={"check_same_thread": False},
)
_SYNC_ENGINE = create_engine(
    f"sqlite:///{_TEST_DB_PATH}", connect_args={"check_same_thread": False}
)


@pytest.fixture(autouse=True)
async def rl(monkeypatch):
    """yield 当前 rate_limit_db 模块实例，engine 指向本文件独立库；
    测试后释放连接池（pytest-asyncio 每测试新建 event loop，跨 loop
    复用连接会被 fail-open 吞掉造成偶发失败）。"""
    import services.rate_limit_db as _rl_mod
    monkeypatch.setattr(_rl_mod, "engine", _MY_ENGINE)
    yield _rl_mod
    await _MY_ENGINE.dispose()


@pytest.fixture(scope="session", autouse=True)
def setup_db():
    SQLModel.metadata.create_all(_SYNC_ENGINE)
    yield
    _SYNC_ENGINE.dispose()
    asyncio.run(_MY_ENGINE.dispose())
    _TEST_DB_PATH.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# build_key
# ---------------------------------------------------------------------------

def test_build_key_group_level_and_per_user():
    from services.rate_limit_db import build_key
    assert build_key("g1", "request_limit", 60) == "rate:g1:request_limit:60"
    assert (
        build_key("g1", "request_limit", 60, username="alice")
        == "rate:g1:user:alice:request_limit:60"
    )


# ---------------------------------------------------------------------------
# 计数 / 求和语义
# ---------------------------------------------------------------------------

async def test_count_starts_at_zero_and_increments(rl):
    key = rl.build_key("g-count", "request_limit", 60)
    assert await rl.get_window_count(key, "request_limit", 60) == 0
    await rl.record_request(key, "request_limit", 60, "req-1")
    await rl.record_request(key, "request_limit", 60, "req-2")
    assert await rl.get_window_count(key, "request_limit", 60) == 2


async def test_sum_accumulates_amounts(rl):
    key = rl.build_key("g-sum", "quota_limit", 3600)
    assert await rl.get_window_sum(key, "quota_limit", 3600) == 0.0
    await rl.record_value(key, "quota_limit", 3600, "req-1", 0.5)
    await rl.record_value(key, "quota_limit", 3600, "req-2", 1.25)
    assert await rl.get_window_sum(key, "quota_limit", 3600) == pytest.approx(1.75)


async def test_count_and_amount_are_independent_columns(rl):
    """同一 subject 的计数型与求和型规则互不干扰。"""
    key = rl.build_key("g-mixed", "request_limit", 60)
    await rl.record_request(key, "request_limit", 60, "r1")
    # 同 key 下不同 limit_type 的求和读数应为 0
    assert await rl.get_window_sum(key, "token_limit", 60) == 0.0


# ---------------------------------------------------------------------------
# 固定窗口语义
# ---------------------------------------------------------------------------

async def test_window_rollover_resets_counter(rl):
    """窗口翻转后读数归零（固定窗口语义）。"""
    key = rl.build_key("g-rollover", "request_limit", 60)
    with patch.object(rl, "_window_start", return_value=1_000):
        await rl.record_request(key, "request_limit", 60, "r1")
        await rl.record_request(key, "request_limit", 60, "r2")
        assert await rl.get_window_count(key, "request_limit", 60) == 2
    # 下一个窗口：计数清零
    with patch.object(rl, "_window_start", return_value=1_060):
        assert await rl.get_window_count(key, "request_limit", 60) == 0


async def test_expired_window_rows_are_opportunistically_cleaned(rl):
    """机会式清理应删除本 subject 的过期窗口行（表内不无限增长）。"""
    from sqlalchemy import text as sa_text
    key = rl.build_key("g-cleanup", "request_limit", 60)
    with patch.object(rl, "_window_start", return_value=1_000):
        await rl.record_request(key, "request_limit", 60, "old")
    # 清理概率 1/16，重复写入保证触发
    with patch.object(rl, "_window_start", return_value=1_060):
        for i in range(200):
            await rl.record_request(key, "request_limit", 60, f"new-{i}")
        async with AsyncSession(_MY_ENGINE) as session:
            rows = (
                await session.execute(
                    sa_text(
                        "SELECT COUNT(*) FROM rate_limit_counters "
                        "WHERE subject_key = :k AND window_start < 1060"
                    ),
                    {"k": key},
                )
            ).scalar()
    assert rows == 0


# ---------------------------------------------------------------------------
# 并发原子性
# ---------------------------------------------------------------------------

async def test_concurrent_record_requests_are_all_counted(rl):
    """并发 50 次 UPSERT 递增不丢计数（多实例安全性）。"""
    key = rl.build_key("g-concurrent", "request_limit", 60)
    await asyncio.gather(
        *(rl.record_request(key, "request_limit", 60, f"req-{i}") for i in range(50))
    )
    assert await rl.get_window_count(key, "request_limit", 60) == 50


# ---------------------------------------------------------------------------
# fail open
# ---------------------------------------------------------------------------

async def test_get_window_count_fails_open_on_db_error(rl):
    key = rl.build_key("g-err", "request_limit", 60)
    with patch.object(rl, "AsyncSession", side_effect=Exception("db down")):
        assert await rl.get_window_count(key, "request_limit", 60) == 0


async def test_get_window_sum_fails_open_on_db_error(rl):
    key = rl.build_key("g-err", "token_limit", 60)
    with patch.object(rl, "AsyncSession", side_effect=Exception("db down")):
        assert await rl.get_window_sum(key, "token_limit", 60) == 0.0


async def test_record_swallows_db_error(rl):
    key = rl.build_key("g-err", "request_limit", 60)
    with patch.object(rl, "AsyncSession", side_effect=Exception("db down")):
        await rl.record_request(key, "request_limit", 60, "r1")  # 不应抛出


# ---------------------------------------------------------------------------
# 多方言（MySQL / PostgreSQL）编译验证
# 本地测试库是 sqlite，无法连真实 MySQL/PG；用 SQLAlchemy 方言编译保证
# DDL 与 UPSERT 在目标方言下语法成立（能抓住 VARCHAR 缺长度等问题）。
# 真实 MySQL 运行时行为在部署时联调（见 README 部署清单）。
# ---------------------------------------------------------------------------

def test_all_tables_compile_for_mysql_and_postgresql():
    """全部模型的 CREATE TABLE 在 MySQL / PostgreSQL 方言下可编译。"""
    from sqlalchemy.dialects import mysql, postgresql
    from sqlalchemy.schema import CreateTable

    for dialect in (mysql.dialect(), postgresql.dialect()):
        for table in SQLModel.metadata.tables.values():
            str(CreateTable(table).compile(dialect=dialect))  # 编译失败即抛错


def test_upsert_sql_per_dialect(rl):
    """限流 UPSERT：MySQL 为 ON DUPLICATE KEY UPDATE（:value 二次引用在
    pyformat 参数风格下合法），PG/SQLite 为 ON CONFLICT ... DO UPDATE。"""
    from sqlalchemy.dialects import mysql, postgresql

    mysql_count, mysql_value = rl._build_upserts("mysql")
    c = str(mysql_count.compile(dialect=mysql.dialect()))
    assert "ON DUPLICATE KEY UPDATE" in c
    assert "count = count + 1" in c
    v = str(mysql_value.compile(dialect=mysql.dialect()))
    assert "ON DUPLICATE KEY UPDATE" in v
    assert "amount = amount + %s" in v

    pg_count, pg_value = rl._build_upserts("postgresql")
    assert "ON CONFLICT" in str(pg_count.compile(dialect=postgresql.dialect()))
    assert "DO UPDATE" in str(pg_value.compile(dialect=postgresql.dialect()))
