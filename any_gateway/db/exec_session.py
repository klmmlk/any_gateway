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


def _obj_to_update(obj, table) -> str:
    """把 ORM 对象转成 UPDATE 语句（按主键定位，更新所有非主键字段）。
    标 _was_loaded 的对象走这条路径（exec_sql_backend.attach_orm_class 注入）。"""
    pk_cols = list(table.primary_key.columns.keys())
    sets = []
    for col in table.columns.keys():
        if col in pk_cols:
            continue
        v = getattr(obj, col, None)
        sets.append(f"{col} = {_render_literal(v)}")
    conds = " AND ".join(f"{c} = {_render_literal(getattr(obj, c))}" for c in pk_cols)
    return f"UPDATE {table.name} SET {', '.join(sets)} WHERE {conds}"


class ExecSession:
    """兼容 `async with AsyncSession(engine) as session` 用法的最小子集。"""

    def __init__(self, *args, **kwargs):
        self._conn = ExecSqlConnection()
        self._pending_adds: List[Any] = []
        self._autoflush_enabled = kwargs.get("autoflush", True)

    # ---- 入口 ----
    async def execute(self, statement, params: Optional[Dict[str, Any]] = None, **kw):
        # ORM 实体查询必须在编译成 text 前判定；text() 自身没有 column_descriptions，
        # 但 sqlalchemy.sql.expression.Select/Update/Delete 有，按 ORM 模式跑出整行
        # 才能让 scalar_one_or_none() 返回 dict 行而不是首列标量。
        orm_cls = None
        try:
            descs = getattr(statement, "column_descriptions", None)
            if descs and isinstance(descs, list):
                for d in descs:
                    if d and d.get("entity") is not None:
                        orm_cls = d["entity"]
                        break
        except Exception:
            orm_cls = None
        sql = compile_sql(statement, params)
        res = await self._conn.execute(sa_text(sql))
        res._orm_mode = orm_cls is not None
        res._orm_class = orm_cls
        if orm_cls is not None:
            res.attach_orm_class(orm_cls)
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
            # attach_orm_class 注入的"已持久化"标记：有 _was_loaded 视为 UPDATE 目标
            if getattr(obj, "_was_loaded", False):
                sql = _obj_to_update(obj, obj.__table__)
            else:
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
