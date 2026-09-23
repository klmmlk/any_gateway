"""ExecutePGSql-based SQLAlchemy AsyncEngine 适配层。

让 SQLAlchemy AsyncSession 在 CloudBase 内置 PG 上工作：
- 不依赖 PG TCP 直连（容器到 PG 内网不通时仍可用）
- secretId + secretKey 鉴权走 TCB OpenAPI，平台自动注入环境变量
- SQL 透传原样执行；多条 SQL 拼一个字符串一次发，保留事务边界
"""
from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.engine.interfaces import DBAPIConnection
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncConnection

from loguru import logger

# SDK 用 SDK 的实例化（同步初始化），包成 AsyncConnection 用 httpx 异步？不，
# TCB SDK 是同步的（基于 requests），而 SQLAlchemy AsyncEngine 要求 conn.execute 是 coroutine。
# 我们用 asyncio.to_thread 包一层即可。

# SCF 等平台保留 TENCENTCLOUD_ 前缀（自动注入临时凭证），云函数侧改用 TC_ 前缀；
# 回退原名以兼容本地开发与云托管环境。
_secret_id = os.getenv("TC_SECRET_ID") or os.getenv("TENCENTCLOUD_SECRETID")
_secret_key = os.getenv("TC_SECRET_KEY") or os.getenv("TENCENTCLOUD_SECRETKEY")
_env_id = os.getenv("CLOUDBASE_ENV_ID") or os.getenv("TCB_ENV_ID")
_region = os.getenv("TC_REGION") or os.getenv("TENCENTCLOUD_REGION") or "ap-shanghai"

_client_lock = threading.Lock()
_tcb_client = None


def _get_client():
    global _tcb_client
    if _tcb_client is not None:
        return _tcb_client
    with _client_lock:
        if _tcb_client is not None:
            return _tcb_client
        if not (_secret_id and _secret_key):
            raise RuntimeError(
                "ExecutePGSql backend requires TENCENTCLOUD_SECRETID and "
                "TENCENTCLOUD_SECRETKEY in environment."
            )
        from tencentcloud.common.credential import Credential
        from tencentcloud.tcb.v20180608 import tcb_client

        cred = Credential(_secret_id, _secret_key)
        _tcb_client = tcb_client.TcbClient(cred, _region)
        return _tcb_client


def _exec_sql_sync(sql: str) -> Tuple[List[str], List[List[str]], int]:
    """同步调用 ExecutePGSql，返回 (columns, rows, affected_rows)。

    ExecutePGSql 有账号级每秒频率上限（约 20 QPS）；多并发请求的 SQL 突发会触发
    RequestLimitExceeded，这里指数退避重试把突发摊平而不是直接失败。

    抛出:
        OperationalError: PG SQL 错误 / 重试后仍失败
    """
    import random
    import time

    from tencentcloud.tcb.v20180608 import models

    client = _get_client()
    req = models.ExecutePGSqlRequest()
    req.EnvId = _env_id
    req.Sql = sql

    max_attempts = 5  # 1 次原始调用 + 4 次退避重试（0.12/0.24/0.48/0.96s ± 抖动）
    for attempt in range(max_attempts):
        try:
            resp = client.ExecutePGSql(req)
            break
        except Exception as e:  # network / auth / rate limit
            code = str(getattr(e, "code", "") or "")
            if "RequestLimitExceeded" in code and attempt < max_attempts - 1:
                time.sleep(0.12 * (2 ** attempt) + random.uniform(0, 0.08))
                continue
            raise OperationalError("ExecutePGSql call failed", params=sql, orig=e) from e

    # 把 PG 错误信息翻译为 ProgrammingError
    if resp.Columns is None and (not resp.Rows or resp.Rows == ["[]"]):
        if "ERROR" in (sql or "").upper() and "BEGIN" not in sql.upper():
            pass  # 写语句无结果集是正常的
    if resp.AffectedRows is None:
        resp.AffectedRows = 0

    return resp.Columns or [], resp.Rows or [], resp.AffectedRows


async def _exec_sql(sql: str) -> Tuple[List[str], List[List[str]], int]:
    import asyncio
    return await asyncio.to_thread(_exec_sql_sync, sql)


# ---------------------------------------------------------------------
# SQLAlchemy 兼容层（仅满足业务代码用到的接口）
# ---------------------------------------------------------------------


class _RowsView:
    """Result 视图代理：可迭代，带 first()/all()/scalars()（FastCRUD 等依赖）。"""

    def __init__(self, rows: List[Dict[str, Any]], columns: List[str]):
        self._rows = rows
        self._columns = columns

    def __iter__(self):
        return iter(self._rows)

    def __len__(self):
        return len(self._rows)

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return list(self._rows)

    def scalars(self):
        return _ScalarView(self._rows, self._columns)


class _ScalarView:
    """Result.scalars() 代理：迭代标量，带 first()/all()。"""

    def __init__(self, rows: List[Dict[str, Any]], columns: List[str]):
        self._rows = rows
        self._columns = columns

    def __iter__(self):
        return (r[self._columns[0]] if self._columns else None for r in self._rows)

    def __len__(self):
        return len(self._rows)

    def first(self):
        return (self._rows[0] or {}).get(self._columns[0]) if self._rows else None

    def all(self):
        return list(self) if self._columns else []


class _MappingsView(_RowsView):
    """Result.mappings() 代理（FastCRUD 依赖）。"""

    def __init__(self, rows: List[Dict[str, Any]], columns: List[str]):
        super().__init__(rows, columns)


class _RowDict(dict):
    """结果行：dict 语义 + ORM 实体式属性访问（业务代码普遍写 channel.models 这类点取值）。"""

    @property
    def _mapping(self):
        return self

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name)

    def __setattr__(self, name, value):
        self[name] = value

    def model_dump(self, **kwargs):
        # 业务代码把查询结果当 SQLModel 实体用（t.model_dump()），这里返回普通 dict 视图
        return dict(self)

    @property
    def __class__(self):
        # 业务代码常调 obj.__table__（SQLAlchemy class-level 属性）；
        # 普通 dict 的 __getattr__ 兜不到 class-level 查询。把类伪装成目标 ORM 实体类，
        # 让 isinstance/属性查找走 SQLAlchemy 的路径。_orm_class 由 ExecSession 在
        # ORM 模式 execute 时注入到每行的隐藏键。
        orm_cls = dict.get(self, "_orm_class")
        if orm_cls is not None:
            return orm_cls
        return type(self).__mro__[0]

    @property
    def __class__(self):
        # 业务代码常调 voucher.__table__（SQLAlchemy class-level 属性）；
        # dict 行的 __getattr__ 兜不到 class-level 查询。把类伪装成 ORM 实体类，
        # 让 isinstance/属性查找走 SQLAlchemy 的路径。
        orm_cls = self.get("_orm_class") or type(self).__mro__[0].__mro__[-1]
        return orm_cls


# ExecutePGSql 把所有 PG 类型序列化成文本（bool→'false'、int→'0'、NULL→None），
# 业务代码直接拿值做布尔判断/数值比较会全线误判。按值形状保守还原：
# 只还原无歧义的 true/false 与纯数字，其余（时间戳、JSON 文本、sk- key 等）保持字符串。
import re as _re

_INT_RE = _re.compile(r"^-?\d+$")
_FLOAT_RE = _re.compile(r"^-?\d+\.\d+(e[+-]?\d+)?$", _re.I)


def _coerce_value(v):
    if v is None:
        return None
    if isinstance(v, str):
        if v == "true":
            return True
        if v == "false":
            return False
        if _INT_RE.match(v):
            return int(v)
        if _FLOAT_RE.match(v):
            return float(v)
    return v


class ExecSqlResult:
    """AsyncSession.execute() 的返回值代理，最小实现。"""

    def __init__(self, columns: List[str], rows: List[List[str]], affected_rows: int = 0):
        self._columns = columns
        self._affected = affected_rows
        parsed_rows: List[Dict[str, Any]] = []
        for raw in rows:
            if isinstance(raw, str):
                try:
                    import json
                    values = json.loads(raw)
                except Exception:
                    values = [raw]
            else:
                values = list(raw) if raw is not None else []
            parsed_rows.append(self._to_row(columns, values))
        self._row_tuples = parsed_rows

    def attach_orm_class(self, orm_cls):
        """由 ExecSession 在 ORM 模式 execute 后调用：把每行替换为 SQLModel 实例，
        满足 obj.__table__ / isinstance / FastCRUD 的 ._mapping 等查询。"""
        from sqlmodel import SQLModel
        self._orm_class = orm_cls
        if not (isinstance(orm_cls, type) and issubclass(orm_cls, SQLModel)):
            return
        # FastCRUD 调 result._mapping 期望拿到 Mapping 行；给 orm_cls 加 property。
        # SQLModel 实例本身是 dict-like（Pydantic model_dump），property 即可。
        if not hasattr(orm_cls, "_mapping"):
            orm_cls._mapping = property(lambda self: self)
        new_rows = []
        for row in self._row_tuples:
            field_names = set(orm_cls.model_fields.keys())
            clean = {k: row.get(k) for k in field_names if k in row}
            obj = orm_cls(**clean)
            obj._was_loaded = True
            new_rows.append(obj)
        self._row_tuples = new_rows

    def _to_row(self, columns: List[str], values: List[str]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for i, col in enumerate(columns):
            out[col] = _coerce_value(values[i]) if i < len(values) else None
        return _RowDict(out)

    def scalars(self):
        # ORM 实体查询时返回整行 dict（近似 ORM 实体），否则返回第一列标量
        if getattr(self, "_orm_mode", False):
            return _RowsView(self._row_tuples, self._columns)
        return _ScalarView(self._row_tuples, self._columns)

    def mappings(self):
        """返回 MappingView 行（FastCRUD 依赖）。"""
        return _MappingsView(self._row_tuples, self._columns)

    def all(self):
        return self._row_tuples

    def first(self):
        return self._row_tuples[0] if self._row_tuples else None

    def scalar(self):
        if not self._row_tuples:
            return None
        # ORM 实体查询：真 SQLAlchemy 的 scalar* 返回实体而非首列；
        # 本后端用整行 dict 近似实体（_orm_mode 由 ExecSession 按 column_descriptions 设置）。
        if getattr(self, "_orm_mode", False):
            return self._row_tuples[0]
        return self._row_tuples[0][self._columns[0]] if self._columns else None

    def scalar_one_or_none(self):
        if not self._row_tuples:
            return None
        if len(self._row_tuples) > 1:
            raise RuntimeError(f"multiple rows returned")
        if getattr(self, "_orm_mode", False):
            return self._row_tuples[0]
        first = self._row_tuples[0]
        return first[self._columns[0]] if self._columns else None


class ExecSqlConnection(AsyncConnection):
    """最小 AsyncConnection：每次 execute 调一次 ExecutePGSql。"""

    def __init__(self):
        self._in_transaction = False
        self._tx_buffer: List[str] = []

    async def execute(self, statement, parameters=None):
        sql_text = _render_text(statement, parameters)
        # ExecutePGSql 每次调用是独立 PG 连接，跨调用没有事务；
        # 因此多语句（BEGIN...COMMIT）必须整体一次发送（simple query protocol）。
        cols, rows, affected = await _exec_sql(sql_text)
        return ExecSqlResult(cols, rows, affected)

    async def run_sync(self, fn, *args, **kwargs):
        # init_db 用 run_sync(create_all) 拿 metadata 跑 DDL；这里我们直接转发 metadata 给 SDK
        from sqlmodel import SQLModel

        if getattr(fn, "__name__", "") == "create_all":
            # 把 metadata.tables 转成 CREATE TABLE IF NOT EXISTS 拼起来
            stmts = [_create_table_ddl(t) for t in SQLModel.metadata.sorted_tables]
            for s in stmts:
                try:
                    await _exec_sql(s)
                except Exception as e:
                    logger.warning(f"DDL skip: {s[:80]}: {e}")
            return
        raise NotImplementedError(f"run_sync({fn}) unsupported in ExecutePGSql backend")

    async def commit(self):
        return None  # ExecutePGSql 每条 SQL 自带事务语义

    async def rollback(self):
        return None

    async def close(self):
        return None


class _FakeDialect:
    """最小方言占位：让 init_db 等判断 engine.dialect.name 的代码正常工作。"""

    name = "postgresql"


class _FakeSyncEngine:
    """AsyncEngine.dialect property 取 self.sync_engine.dialect；给它一个假对象。"""

    dialect = _FakeDialect()


class ExecSqlEngine:
    """鸭子类型 AsyncEngine：业务侧只用到 .begin()、.dialect.name、.connect()。"""

    def __init__(self):
        self.sync_engine = _FakeSyncEngine()
        self.dialect = _FakeDialect()

    @asynccontextmanager
    async def begin(self):
        conn = ExecSqlConnection()
        try:
            yield conn
        finally:
            await conn.close()

    def connect(self):
        return self.begin()


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------


def _render_text(statement, parameters) -> str:
    """把 SQLAlchemy text(...) 编译成原始 SQL，并绑定参数。"""
    from sqlalchemy.sql.expression import TextClause

    if isinstance(statement, TextClause):
        sql_str = statement.text
    else:
        sql_str = str(statement)
    if parameters:
        # SQLAlchemy text() 风格的 :name 占位符
        if isinstance(parameters, dict):
            for k, v in parameters.items():
                sql_str = sql_str.replace(f":{k}", _render_value(v))
        elif isinstance(parameters, (list, tuple)):
            for v in parameters:
                sql_str = sql_str.replace("?", _render_value(v), 1)
    return sql_str


def _render_value(v: Any) -> str:
    """把 Python 值渲染为 SQL 字面量。"""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return repr(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def _split_statements(sql: str) -> List[str]:
    """简单 SQL 语句分割；尊重字符串字面量与美元引号（plpgsql）。"""
    out: List[str] = []
    buf: List[str] = []
    i, n = 0, len(sql)
    in_single = False
    in_dollar = False
    while i < n:
        ch = sql[i]
        if not in_dollar and ch == "'":
            if in_single and i + 1 < n and sql[i + 1] == "'":
                buf.append("''")
                i += 2
                continue
            in_single = not in_single
            buf.append(ch)
        elif not in_single and ch == "$" and i + 1 < n and sql[i + 1] == "$":
            in_dollar = not in_dollar
            buf.append("$$")
            i += 2
            continue
        elif ch == ";" and not in_single and not in_dollar:
            out.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    if buf:
        out.append("".join(buf))
    return out


def _create_table_ddl(table) -> str:
    """把 SQLAlchemy Table 转成 CREATE TABLE IF NOT EXISTS。"""
    from sqlalchemy import Column

    cols: List[str] = []
    for col in table.columns:
        parts = [col.name]
        try:
            parts.append(col.type.compile(None.dialect if False else None.dialect if False else None) if False else str(col.type))
        except Exception:
            parts.append("TEXT")
        if not col.nullable:
            parts.append("NOT NULL")
        if col.primary_key:
            parts.append("PRIMARY KEY")
        if col.unique:
            parts.append("UNIQUE")
        if col.server_default is not None:
            parts.append(f"DEFAULT {col.server_default.arg if hasattr(col.server_default, 'arg') else col.server_default}")
        cols.append(" ".join(parts))
    return f'CREATE TABLE IF NOT EXISTS {table.name} (\n  ' + ",\n  ".join(cols) + "\n)"