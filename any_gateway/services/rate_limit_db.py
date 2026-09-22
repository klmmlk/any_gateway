"""
DB 固定窗口限流（去 Redis 化，状态入主库；MySQL / PostgreSQL / SQLite 通用）。

与原 Redis ZSET 滑动窗口实现的语义对齐：
- 预检（get_window_count / get_window_sum）只读，被拒绝/失败的请求不计数；
- 记录（record_request / record_value）在响应成功转发后原子 UPSERT 递增，
  并发多实例下靠唯一键冲突合并保证不丢计数；
- DB 异常时 fail open（返回 0 / 静默丢弃），与原 Redis 版行为一致。

与原实现的差异：滑动窗口 → 固定窗口（window_start = int(now // window_sec) * window_sec），
窗口交界处最多可能出现约 2 倍突刺；套餐限流场景可接受，账户余额扣减（Type 2）仍兜底。

UPSERT 语法按方言分派：MySQL 用 ON DUPLICATE KEY UPDATE，
PostgreSQL / SQLite 用 ON CONFLICT ... DO UPDATE。
过期行由写入路径机会式清理（每个 subject 最多保留当前窗口一行），无需定时任务。
"""
from __future__ import annotations

import random
import time

from loguru import logger
from sqlalchemy import text as sa_text
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import engine

_TABLE = "rate_limit_counters"
# 机会式清理概率：写入时抽中才顺带删本 subject 的过期窗口行
_CLEANUP_PROB = 0.0625  # 1/16

_SELECT = sa_text(
    f"SELECT count, amount FROM {_TABLE} "
    "WHERE subject_key = :subject_key AND limit_type = :limit_type "
    "AND window_start = :window_start"
)
_DELETE_EXPIRED = sa_text(
    f"DELETE FROM {_TABLE} "
    "WHERE subject_key = :subject_key AND limit_type = :limit_type "
    "AND window_start < :window_start"
)


def _build_upserts(dialect_name: str) -> tuple[object, object]:
    """按方言构造（计数型, 求和型）UPSERT 语句。

    MySQL 用 ON DUPLICATE KEY UPDATE；PostgreSQL / SQLite 用
    ON CONFLICT ... DO UPDATE。提成独立函数便于测试按方言编译验证。
    """
    if dialect_name == "mysql":
        return (
            sa_text(
                f"INSERT INTO {_TABLE} (subject_key, limit_type, window_start, count, amount) "
                "VALUES (:subject_key, :limit_type, :window_start, 1, 0) "
                "ON DUPLICATE KEY UPDATE count = count + 1"
            ),
            sa_text(
                f"INSERT INTO {_TABLE} (subject_key, limit_type, window_start, count, amount) "
                "VALUES (:subject_key, :limit_type, :window_start, 0, :value) "
                "ON DUPLICATE KEY UPDATE amount = amount + :value"
            ),
        )
    return (
        sa_text(
            f"INSERT INTO {_TABLE} (subject_key, limit_type, window_start, count, amount) "
            "VALUES (:subject_key, :limit_type, :window_start, 1, 0) "
            f"ON CONFLICT (subject_key, limit_type, window_start) "
            f"DO UPDATE SET count = {_TABLE}.count + 1"
        ),
        sa_text(
            f"INSERT INTO {_TABLE} (subject_key, limit_type, window_start, count, amount) "
            "VALUES (:subject_key, :limit_type, :window_start, 0, :value) "
            f"ON CONFLICT (subject_key, limit_type, window_start) "
            f"DO UPDATE SET amount = {_TABLE}.amount + :value"
        ),
    )


_UPSERT_COUNT, _UPSERT_VALUE = _build_upserts(engine.dialect.name)


def build_key(group_id: str, limit_type: str, window_sec: int, username: str | None = None) -> str:
    """构造限流主体 key（格式与原 Redis key 一致）。username 存在时为 per-user 级别。"""
    if username:
        return f"rate:{group_id}:user:{username}:{limit_type}:{window_sec}"
    return f"rate:{group_id}:{limit_type}:{window_sec}"


def _window_start(window_sec: int) -> int:
    return int(time.time() // window_sec) * window_sec


async def get_window_count(key: str, limit_type: str, window_sec: int) -> int:
    """读取当前固定窗口内计数。DB 异常时返回 0（fail open）。"""
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            row = (
                await session.execute(
                    _SELECT,
                    {"subject_key": key, "limit_type": limit_type, "window_start": _window_start(window_sec)},
                )
            ).first()
            return int(row.count) if row else 0
    except Exception as exc:
        logger.warning(f"rate_limit_db get_window_count 失败，fail open: key={key} err={exc}")
        return 0


async def get_window_sum(key: str, limit_type: str, window_sec: int) -> float:
    """读取当前固定窗口内累计值（token 数或金额）。DB 异常时返回 0.0（fail open）。"""
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            row = (
                await session.execute(
                    _SELECT,
                    {"subject_key": key, "limit_type": limit_type, "window_start": _window_start(window_sec)},
                )
            ).first()
            return float(row.amount) if row else 0.0
    except Exception as exc:
        logger.warning(f"rate_limit_db get_window_sum 失败，fail open: key={key} err={exc}")
        return 0.0


async def _record(key: str, limit_type: str, window_sec: int, upsert, params: dict) -> None:
    """UPSERT 递增 + 机会式清理过期窗口行（同一事务）。失败静默。"""
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            await session.execute(upsert, params)
            if random.random() < _CLEANUP_PROB:
                await session.execute(
                    _DELETE_EXPIRED,
                    {"subject_key": key, "limit_type": limit_type, "window_start": params["window_start"]},
                )
            await session.commit()
    except Exception as exc:
        logger.warning(f"rate_limit_db 记录失败（本条计数丢弃）: key={key} err={exc}")


async def record_request(key: str, limit_type: str, window_sec: int, request_id: str) -> None:
    """记录一次成功转发的请求（计数 +1）。失败静默（不抛异常）。

    request_id 仅为接口兼容保留（原 Redis ZADD member）；DB 实现按窗口聚合，
    不存单请求明细，用量明细以 UsageLog 为准。
    """
    await _record(
        key, limit_type, window_sec, _UPSERT_COUNT,
        {"subject_key": key, "limit_type": limit_type, "window_start": _window_start(window_sec)},
    )


async def record_value(key: str, limit_type: str, window_sec: int, request_id: str, value: float) -> None:
    """记录一个数值（token 数或金额）到当前窗口（amount 原子累加）。失败静默。"""
    await _record(
        key, limit_type, window_sec, _UPSERT_VALUE,
        {
            "subject_key": key,
            "limit_type": limit_type,
            "window_start": _window_start(window_sec),
            "value": float(value),
        },
    )
