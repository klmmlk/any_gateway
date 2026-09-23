"""
WebSocket ASR 端点集成测试。

策略：在独立线程里跑 uvicorn server（端口随机），用真正的 websockets 客户端
直连，覆盖：
  1. 鉴权失败 → 1008 close
  2. 缺 model 参数 → 1008 close
  3. 找到 wss 渠道 → 端到端透传成功
  4. 找不到 wss 渠道（只有 http 渠道）→ 1008 close
  5. 配额超限 → 1008 close
  6. 透传过程中 meta 钩子被调用，UsageLog.audio_seconds 被正确写入
  7. meta 缺失时按 WS 墙钟时长兜底计费

为什么不用 TestClient.websocket_connect：starlette TestClient 在主线程跑 asyncio，
与 fixture 里启动 mock upstream 用的 asyncio.run() 会卡死。
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path
from uuid import uuid4

import pytest
import uvicorn
import websockets
from sqlalchemy.ext.asyncio import AsyncSession

_REPO_ROOT = Path(__file__).parent.parent
_AG_PATH = _REPO_ROOT / "any_gateway"
if str(_AG_PATH) not in sys.path:
    sys.path.insert(0, str(_AG_PATH))

# 关键：在 import any_gateway.* 之前锁定 env 与 DB 文件路径
# 任何后续的 db.database.engine 创建都会指向这个文件，
# 否则 gateway.py 初次 import 时会捕获到 in-memory engine，后续 fixture 改不到。
_TEST_DB_PATH = os.path.join(tempfile.gettempdir(), f"asr_endpoint_test_{uuid4().hex[:8]}.db")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_TEST_DB_PATH}"
os.environ.setdefault("ADMIN_KEY", "test-admin-secret")
os.environ.setdefault("ADMIN_FALLBACK_KEY", "fallback-key")

from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import SQLModel, select

# 与 db.database.engine 完全一致（同一 URL + connect_args）
TEST_ENGINE = create_async_engine(
    f"sqlite+aiosqlite:///{_TEST_DB_PATH}",
    connect_args={"check_same_thread": False},
)


# ============================================================
# 上游 mock
# ============================================================
class UpstreamEcho:
    def __init__(self) -> None:
        self.received: list = []
        self.server = None
        self.port: int = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None

    async def handler(self, ws):
        async for msg in ws:
            self.received.append(msg)
            await ws.send(msg)

    def start_in_thread(self) -> None:
        """在独立线程里跑 event loop + websockets.serve。"""
        self._loop = asyncio.new_event_loop()

        def _runner():
            asyncio.set_event_loop(self._loop)
            self._loop.run_until_complete(self._start_on_loop())
            self._loop.run_forever()

        self._thread = threading.Thread(target=_runner, daemon=True)
        self._thread.start()
        # 等 server 起来
        for _ in range(50):
            if self.server is not None:
                break
            time.sleep(0.05)

    async def _start_on_loop(self) -> None:
        self.server = await websockets.serve(self.handler, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    def stop(self) -> None:
        if self._loop and self.server:
            server_ref = self.server  # 提前取出，stop 完成后 self.server 可能被清理
            try:
                asyncio.run_coroutine_threadsafe(server_ref.close(), self._loop).result(timeout=5)
            except Exception:
                pass
            self._loop.call_soon_threadsafe(self._loop.stop)

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"


# ============================================================
# uvicorn server fixture
# ============================================================
def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server_url():
    """在独立线程跑 uvicorn server，返回 http://host:port。

    全量测试套件中其他模块可能先 import 了 db.database（engine 绑到 :memory:），
    所以这里显式替换所有持有 engine 引用的模块全局，不依赖 env var 的 import 顺序。
    """
    import db.database as _db
    import db.models  # noqa
    import gateway as _gw
    import middleware.auth as _auth
    import services.quota as _quota

    # 在启动 uvicorn 之前确保表已建好
    async def _ensure_schema():
        async with TEST_ENGINE.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)

    asyncio.run(_ensure_schema())

    # 显式替换各模块的 engine 引用（from db.database import engine 在 import 时已绑定）
    _db.engine = TEST_ENGINE
    _gw.engine = TEST_ENGINE
    _quota.engine = TEST_ENGINE
    _auth.engine = TEST_ENGINE

    port = _free_port()
    config = uvicorn.Config(
        _gw.app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        loop="asyncio",
    )
    server = uvicorn.Server(config)

    def _run():
        server.run()

    t = threading.Thread(target=_run, daemon=True)
    t.start()

    # 等 server ready
    base_url = f"http://127.0.0.1:{port}"
    ws_url = f"ws://127.0.0.1:{port}"
    for _ in range(100):
        try:
            import urllib.request
            urllib.request.urlopen(f"{base_url}/health", timeout=0.2).read()
            break
        except Exception:
            time.sleep(0.05)

    yield {"base": base_url, "ws": ws_url}

    server.should_exit = True
    t.join(timeout=5)


@pytest.fixture(scope="module", autouse=True)
def setup_db():
    import db.models  # noqa

    async def _create():
        async with TEST_ENGINE.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)

    asyncio.run(_create())
    yield
    # 清理临时文件
    try:
        os.unlink(_TEST_DB_PATH)
    except OSError:
        pass
    asyncio.run(TEST_ENGINE.dispose())


# ============================================================
# helper
# ============================================================
async def _seed_channel_and_token(
    protocol: str = "wss",
    base_url: str = "ws://placeholder",
    api_key: str | None = None,
    upstream_key: str = "test-upstream-key",
    quota_usd: float = 100.0,
    used_usd: float = 0.0,
) -> tuple[str, str]:
    from db.models import Channel, GroupChannel, Token, User, UserGroup

    unique = uuid4().hex[:8]
    username = f"asrtest-{unique}"
    api_key = api_key or f"sk-as{unique}"

    async with AsyncSession(TEST_ENGINE, expire_on_commit=False) as session:
        user = User(
            id=uuid4().hex, username=username, quota_usd=quota_usd, used_usd=used_usd
        )
        session.add(user)
        grp = UserGroup(id=uuid4().hex, name=f"grp-{unique}", all_visible=False)
        session.add(grp)
        await session.flush()
        ch = Channel(
            id=uuid4().hex,
            name=f"dashscope-asr-{unique}",
            provider="dashscope-asr",
            base_url=base_url,
            api_key=upstream_key,
            weight=1,
            enabled=True,
            models=json.dumps(["qwen-audio-3.0-asr-flash-streaming"]),
            model_mapping=None,
            protocol=protocol,
            ws_path="/api-ws/v1/inference",
            ws_subprotocols=None,
        )
        session.add(ch)
        await session.flush()
        # 渠道挂到分组（find_backend_for_model 策略 1 按 GroupChannel join 查）
        session.add(GroupChannel(group_id=grp.id, channel_id=ch.id))
        tok = Token(
            id=uuid4().hex,
            key=api_key,
            name=f"asr-test-{unique}",
            username=username,
            group_id=grp.id,
            quota_usd=quota_usd,
            used_usd=used_usd,
            expires_at=None,
            frozen=False,
        )
        session.add(tok)
        await session.commit()
        return ch.id, api_key


async def _patch_channel_base_url(ch_id: str, base_url: str) -> None:
    import db.models
    async with AsyncSession(TEST_ENGINE, expire_on_commit=False) as session:
        ch = (await session.execute(
            select(db.models.Channel).where(db.models.Channel.id == ch_id)
        )).scalar_one()
        ch.base_url = base_url
        await session.commit()


async def _latest_usage_log():
    import db.models
    async with AsyncSession(TEST_ENGINE, expire_on_commit=False) as session:
        result = await session.execute(
            select(db.models.UsageLog).order_by(db.models.UsageLog.created_at.desc())
        )
        return result.scalars().first()


# ============================================================
# Tests
# ============================================================
@pytest.mark.asyncio
async def test_invalid_api_key_closes_with_1008(server_url):
    with pytest.raises(Exception):
        async with websockets.connect(
            f"{server_url['ws']}/v1/audio/asr/stream?model=qwen-audio-3.0-asr-flash-streaming&api_key=bad"
        ) as ws:
            await ws.recv()


@pytest.mark.asyncio
async def test_missing_model_closes_with_1008(server_url):
    _, api_key = await _seed_channel_and_token(api_key="sk-asmode0001")
    with pytest.raises(Exception):
        async with websockets.connect(
            f"{server_url['ws']}/v1/audio/asr/stream?api_key={api_key}"
        ) as ws:
            await ws.recv()


@pytest.mark.asyncio
async def test_http_channel_rejected(server_url):
    await _seed_channel_and_token(protocol="http", api_key="sk-ashttp0001")
    with pytest.raises(Exception):
        async with websockets.connect(
            f"{server_url['ws']}/v1/audio/asr/stream?model=qwen-audio-3.0-asr-flash-streaming&api_key=sk-ashttp0001"
        ) as ws:
            await ws.recv()


@pytest.mark.asyncio
async def test_quota_exceeded_closes_with_1008(server_url):
    await _seed_channel_and_token(
        api_key="sk-asquota0001", quota_usd=10.0, used_usd=10.0
    )
    with pytest.raises(Exception):
        async with websockets.connect(
            f"{server_url['ws']}/v1/audio/asr/stream?model=qwen-audio-3.0-asr-flash-streaming&api_key=sk-asquota0001"
        ) as ws:
            await ws.recv()


@pytest.mark.asyncio
async def test_end_to_end_passthrough_with_billing(server_url):
    ch_id, api_key = await _seed_channel_and_token(api_key="sk-ase2e00001")
    upstream = UpstreamEcho()
    upstream.start_in_thread()
    await _patch_channel_base_url(ch_id, upstream.url)

    try:
        async with websockets.connect(
            f"{server_url['ws']}/v1/audio/asr/stream?model=qwen-audio-3.0-asr-flash-streaming&api_key={api_key}"
        ) as ws:
            # 1. JSON meta（网关消费，不转发上游）
            await ws.send(json.dumps({"audio_duration_seconds": 7.5}))
            # 2. 普通文本
            await ws.send("frame-1")
            # 3. 二进制
            await ws.send(b"\x01\x02binary")
            # 4. 文本
            await ws.send("frame-3")

            # 接收 3 条 echo（meta 被消费）
            got: list = []
            for _ in range(3):
                msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                got.append(msg)

        assert len(got) == 3
        assert got[0] == "frame-1"
        assert got[1] == b"\x01\x02binary"
        assert got[2] == "frame-3"

        # 等待 fire-and-forget _finalize_asr_usage 完成
        await asyncio.sleep(0.5)
        log = await _latest_usage_log()
        assert log is not None
        assert log.audio_seconds == 7.5
        assert log.model == "qwen-audio-3.0-asr-flash-streaming"
        assert log.channel_id == ch_id
    finally:
        upstream.stop()


@pytest.mark.asyncio
async def test_no_meta_falls_back_to_wall_clock(server_url):
    ch_id, api_key = await _seed_channel_and_token(api_key="sk-asfall00001")
    upstream = UpstreamEcho()
    upstream.start_in_thread()
    await _patch_channel_base_url(ch_id, upstream.url)

    try:
        async with websockets.connect(
            f"{server_url['ws']}/v1/audio/asr/stream?model=qwen-audio-3.0-asr-flash-streaming&api_key={api_key}"
        ) as ws:
            await ws.send("hello")
            msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
            assert msg == "hello"
            # 保持连接 ~200ms，让 wall duration > 0
            await asyncio.sleep(0.2)

        # 等待 finalize
        await asyncio.sleep(0.5)
        log = await _latest_usage_log()
        assert log is not None
        assert log.audio_seconds > 0
    finally:
        upstream.stop()
