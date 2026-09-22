"""Try common CloudBase PG connection combos and report which works.

Usage: python scripts/pg_probe.py <password>
"""
from __future__ import annotations

import asyncio
import sys
import socket
from urllib.parse import quote

import asyncpg


HOSTS = [
    "pgdb-3t1gu52r-1251162119.tencentcloud.com",
    "pgdb-3t1gu52r.tencentcloud.com",
    "pgdb-3t1gu52r.pg.tencentcloud.com",
    "pgdb-3t1gu52r.pgsql.tencentcloud.com",
    "29.105.107.171",
]
USERS = ["postgres", "cloudbase", "root"]
DBNAMES = ["postgres", "pgdb-3t1gu52r", "cloudbase", "public"]
PORTS = [5432, 50283]


async def try_one(host: str, port: int, user: str, dbname: str, password: str, timeout: float = 5.0) -> str:
    # TCP probe first
    try:
        with socket.create_connection((host, port), timeout=timeout):
            pass
    except Exception as e:
        return f"TCP_FAIL: {type(e).__name__}: {e}"
    # asyncpg try
    try:
        conn = await asyncio.wait_for(
            asyncpg.connect(host=host, port=port, user=user, database=dbname, password=password, timeout=timeout),
            timeout=timeout + 1,
        )
        v = await conn.fetchval("SELECT version()")
        await conn.close()
        return f"OK: {v}"
    except Exception as e:
        msg = str(e).replace("\n", " ")[:200]
        return f"PG_FAIL: {type(e).__name__}: {msg}"


async def main() -> int:
    if len(sys.argv) < 2:
        print("usage: pg_probe.py <password>")
        return 2
    password = sys.argv[1]
    found = False
    for host in HOSTS:
        for port in PORTS:
            for user in USERS:
                for dbname in DBNAMES:
                    r = await try_one(host, port, user, dbname, password)
                    tag = f"{host}:{port} {user}@{dbname}"
                    print(f"[{r[:30]}] {tag}")
                    if r.startswith("OK"):
                        print(f"\n*** WINNER: {tag} ***")
                        found = True
                        return 0
    if not found:
        print("\n*** NONE WORKED ***")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
