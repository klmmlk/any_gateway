"""伪 AsyncSession：把 SQLAlchemy ORM 语句编译成 SQL，走 ExecutePGSql。

业务代码原本 `async with AsyncSession(engine) as session: session.execute(...)`，
这里提供同接口的 ExecSession，内部用 postgresql dialect 将 ORM 语句编译为
原生 SQL（literal_binds），再交给 exec_sql_backend 发往 TCB.ExecutePGSql。

支持:
- session.execute(select/update/delete/text(...))
- session.add(orm_obj)         -> INSERT
- session.get(Model, pk)       -> SELECT by primary key
- session.refresh(obj)         -> no-op（对象在内存中已是全字段）
- session.commit()/rollback()  -> no-op（每条 SQL 单事务；多语句用 BEGIN..COMMIT 包装）
- 事务性写（原子扣费/计数）由调用方用单条 SQL 完成（BEGIN;...COMMIT; 一次发送）
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import delete as sa_delete
from sqlalchemy import insert as sa_insert
from sqlalchemy import select as sa_select
from sqlalchemy import text as sa_text
from sqlalchemy.dialects import postgresql
from sqlalchemy.sql.expression import TextClause

from db.exec_sql_backend import ExecSqlConnection


def compile_sql(statement, params: Optional[Dict[str, Any]] = None) -> str:
    """把 ORM/text 语句编译成 PG 原生 SQL，参数内联。"""
    if isinstance(statement, TextClause):
        sql_str = statement.text
        bind_map = dict(statement._bindparams) if hasattr(statement, "_bindparams") else {}
        if params:
            bind_map.update(params)
        for k, v in bind_map.items():
            val = v.get("callable", v) if isinstance(v, dict) else v
            sql_str = sql_str.replace(f":{k}", _render_literal(val))
        return sql_str
    compiled = statement.compile(
        dialect=postgresql.dialect(),
        compile_kwargs={"literal_binds": True},
    )
    return str(compiled)


def _render_literal(v: Any) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return repr(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def _obj_to_insert(obj, table) -> str:
    """把 ORM 对象转成 INSERT 语句（只包含非 None 字段）。"""
    values = {c: getattr(obj, c) for c in table.columns.keys()}
    values = {k: v for k, v in values.items() if v is not None}
    if not values:
        raise ValueError(f"cannot INSERT empty row for {table.name}")
    cols = ", ".join(values.keys())
    placeholders = ", ".join(_render_literal(v) for v in values.values())
    returning = ", ".join(table.primary_key.columns.keys())
    return (
        f"INSERT INTO {table.name} ({cols}) VALUES ({placeholders}) "
        f"RETURNING {returning}"
    )


class ExecSession:
    """兼容 `async with AsyncSession(engine) as session` 用法的最小子集。"""

    def __init__(self, *args, **kwargs):
        self._conn = ExecSqlConnection()
        self._pending_adds: List[Any] = []
        self._autoflush_enabled = kwargs.get("autoflush", True)

    # ---- 入口 ----
    async def execute(self, statement, params: Optional[Dict[str, Any]] = None, **kw):
        sql = compile_sql(statement, params)
        res = await self._conn.execute(sa_text(sql))
        # ORM 实体查询（select(Model)）：scalars() 应返回整行 dict 而非第一列标量
        is_orm = False
        try:
            descs = getattr(statement, "column_descriptions", None)
            is_orm = bool(descs and descs[0].get("entity") is not None)
        except Exception:
            is_orm = False
        res._orm_mode = is_orm
        return res

    async def get(self, model, ident, **kw):
        pk_cols = list(model.__table__.primary_key.columns.keys())
        stmt = sa_select(model).where(getattr(model, pk_cols[0]) == ident)
        res = await self.execute(stmt)
        rows = res.all()
        if not rows:
            return None
        return rows[0]

    async def refresh(self, instance, **kw):
        # 对象已在内存，字段完整（除非延迟加载）；no-op
        return instance

    async def commit(self):
        if self._pending_adds:
            await self.flush()
        return None

    async def rollback(self):
        self._pending_adds.clear()
        return None

    async def flush(self):
        for obj in self._pending_adds:
            sql = _obj_to_insert(obj, obj.__table__)
            await self._conn.execute(sa_text(sql))
        self._pending_adds.clear()

    async def close(self):
        await self._conn.close()

    def add(self, instance):
        self._pending_adds.append(instance)

    def add_all(self, instances: Sequence[Any]):
        self._pending_adds.extend(instances)

    async def delete(self, instance):
        """按主键 DELETE"""
        table = instance.__table__
        pk_cols = list(table.primary_key.columns.keys())
        conds = " AND ".join(
            f"{c} = {_render_literal(getattr(instance, c))}" for c in pk_cols
        )
        sql = f"DELETE FROM {table.name} WHERE {conds}"
        await self._conn.execute(sa_text(sql))

    # ---- 便利 ----
    async def scalar(self, statement, **kw):
        res = await self.execute(statement, **kw)
        rows = res.all()
        if not rows or not res._columns:
            return None
        return rows[0].get(res._columns[0])

    async def scalars(self, statement, **kw):
        res = await self.execute(statement, **kw)
        return res.scalars()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        await self.close()
        return False
