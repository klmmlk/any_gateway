import os
from pathlib import Path
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy import text
from sqlmodel import SQLModel, select

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./data/gateway.db")

if DATABASE_URL.startswith("sqlite"):
    _db_path = DATABASE_URL.split("///")[-1]
    Path(_db_path).parent.mkdir(parents=True, exist_ok=True)

    engine_kwargs: dict = {
        "echo": False,
        "connect_args": {"check_same_thread": False},
    }
    # StaticPool 适合内存 SQLite；文件型 SQLite 复用单一异步连接时，
    # 请求取消后容易把后续请求共用的连接一并终止。
    if DATABASE_URL.endswith(":memory:"):
        engine_kwargs["poolclass"] = StaticPool
else:
    # 外部数据库：MySQL（生产，TDSQL-C MySQL serverless）/ PostgreSQL。
    # pool_pre_ping：serverless DB 自动暂停唤醒后池内旧连接已断，
    # 取用前探测并重建；pool_recycle 定期换新，减少半开连接。
    engine_kwargs = {
        "echo": False,
        "pool_pre_ping": True,
        "pool_recycle": 300,
        "pool_size": int(os.getenv("DB_POOL_SIZE", "5")),
        "max_overflow": int(os.getenv("DB_MAX_OVERFLOW", "10")),
    }
    if DATABASE_URL.startswith("postgresql"):
        # CloudBase 内置 PG 网关强制 TLS；prefer 同时兼容无 TLS 的自建实例
        engine_kwargs["connect_args"] = {"ssl": os.getenv("DB_SSL", "prefer")}
    elif DATABASE_URL.startswith("mysql"):
        engine_kwargs["connect_args"] = {"charset": "utf8mb4"}

engine = create_async_engine(DATABASE_URL, **engine_kwargs)


async def async_session_generator() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        yield session


# 多实例并发冷启动（serverless 自动扩容）时的 DDL 串行化锁标识。
_DDL_LOCK_ID = 92031701        # PostgreSQL: pg_advisory_lock 参数
_DDL_LOCK_NAME = "any_gateway_ddl"  # MySQL: GET_LOCK 名称


async def _init_ddl() -> None:
    """幂等建表 + 补列。

    每条 ALTER 各自独立事务：某列已存在而失败时不影响其他语句——
    PostgreSQL 中同一事务内一条语句失败后，后续语句会以
    InFailedSqlTransaction 被直接拒绝，新列将永远加不上。
    """
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)

    # channels 表的渠道级网络/兼容性选项，BOOLEAN 默认值按方言区分
    _bool_col = (
        "BOOLEAN NOT NULL DEFAULT false"
        if engine.dialect.name == "postgresql"
        else "BOOLEAN NOT NULL DEFAULT 0"
    )
    idempotent_columns = [
        ("model_prices", "context_length", "INTEGER"),
        ("model_prices", "vendor", "TEXT"),
        ("model_prices", "stability", "TEXT"),
        ("channels", "proxy_url", "VARCHAR(512)"),
        ("channels", "disable_ssl", _bool_col),
        ("channels", "disable_compression", _bool_col),
        # vouchers 表的兑卡时长与绑定分组（匿名兑卡直接吐 key 的场景）
        ("vouchers", "duration_days", "INTEGER"),
        ("vouchers", "group_id", "VARCHAR(64)"),
    ]
    for table, col_name, col_type in idempotent_columns:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(
                    f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}"
                ))
        except Exception:
            pass


async def init_db():
    """在 FastAPI lifespan 启动时调用，自动建表（如表已存在则跳过）"""
    dialect = engine.dialect.name
    if dialect == "postgresql":
        # 咨询锁串行化多实例并发冷启动的 DDL；连接关闭时锁自动释放。
        async with engine.connect() as lock_conn:
            await lock_conn.execute(text(f"SELECT pg_advisory_lock({_DDL_LOCK_ID})"))
            try:
                await _init_ddl()
            finally:
                await lock_conn.execute(text(f"SELECT pg_advisory_unlock({_DDL_LOCK_ID})"))
    elif dialect == "mysql":
        # MySQL 命名锁（GET_LOCK 是连接级锁，连接关闭自动释放）。
        # 拿不到锁说明另一实例正在做 DDL；30 秒超时后报错让平台重启实例重试。
        async with engine.connect() as lock_conn:
            got = (await lock_conn.execute(
                text(f"SELECT GET_LOCK('{_DDL_LOCK_NAME}', 30)")
            )).scalar()
            if got != 1:
                raise RuntimeError("获取 DDL 锁超时（另一实例正在初始化 schema）")
            try:
                await _init_ddl()
            finally:
                await lock_conn.execute(text(f"SELECT RELEASE_LOCK('{_DDL_LOCK_NAME}')"))
    else:
        await _init_ddl()

    # 确保 default 分组存在（幂等）
    from db.models import UserGroup
    async with AsyncSession(engine, expire_on_commit=False) as session:
        result = await session.execute(
            select(UserGroup).where(UserGroup.name == "default")
        )
        if result.scalar_one_or_none() is None:
            session.add(UserGroup(name="default"))
            await session.commit()
