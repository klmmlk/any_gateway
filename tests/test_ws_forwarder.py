"""
WebSocket 转发器单元测试。

策略：直接调 forward_ws_session，传一个 stub WebSocket + 本地 upstream，
所有 IO 都在同一个 event loop 中（避免 TestClient 跨线程模型的事件循环冲突）。

覆盖场景：
  1. 客户端 → 上游 文本 / 二进制 透传 + meta 钩子
  2. 上游 → 客户端 透传（自定义 handler 发回文本/二进制）
  3. meta 钩子对非 JSON 文本不触发，对首个 JSON 文本触发一次
  4. 客户端断开后 upstream 跟着关闭
  5. 上游连不上时抛 WebSocketException
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest

_REPO_ROOT = Path(__file__).parent.parent
_AG_PATH = _REPO_ROOT / "any_gateway"
if str(_AG_PATH) not in sys.path:
    sys.path.insert(0, str(_AG_PATH))

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import websockets
from services.ws_forwarder import forward_ws_session


# ============================================================
# Stub WebSocket：模拟 FastAPI WebSocket 的最小子集
# ============================================================
class StubWebSocket:
    def __init__(self) -> None:
        self._in_queue: asyncio.Queue[dict] = asyncio.Queue()
        self.sent_text: list[str] = []
        self.sent_bytes: list[bytes] = []
        self._disconnected = False

    async def receive(self) -> dict:
        if self._disconnected and self._in_queue.empty():
            return {"type": "websocket.disconnect", "code": 1000}
        return await self._in_queue.get()

    async def send_text(self, data: str) -> None:
        self.sent_text.append(data)

    async def send_bytes(self, data: bytes) -> None:
        self.sent_bytes.append(data)

    def feed_text(self, text: str) -> None:
        self._in_queue.put_nowait({"type": "websocket.receive", "text": text, "bytes": None})

    def feed_bytes(self, data: bytes) -> None:
        self._in_queue.put_nowait({"type": "websocket.receive", "text": None, "bytes": data})

    def trigger_disconnect(self) -> None:
        self._disconnected = True


# ============================================================
# 上游 fixture：默认只 receive 不 echo（避免 echo 反压问题）
# ============================================================
class UpstreamSink:
    """只接收消息不 echo，便于测试客户端→上游的单向透传。"""

    def __init__(self) -> None:
        self.received: list[Any] = []
        self.server = None
        self.port: int = 0
        self.closed_event = asyncio.Event()
        self._connections: list[Any] = []

    async def handler(self, ws):
        self._connections.append(ws)
        try:
            async for msg in ws:
                self.received.append(msg)
        except websockets.ConnectionClosed:
            pass
        finally:
            self.closed_event.set()

    async def start(self) -> None:
        self.server = await websockets.serve(self.handler, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        self.server.close()
        await self.server.wait_closed()

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"


@pytest.fixture
async def upstream():
    srv = UpstreamSink()
    await srv.start()
    try:
        yield srv
    finally:
        await srv.stop()


# ============================================================
# Test 1: 客户端 → 上游 文本 / 二进制 透传；meta 帧被消费不转发
# ============================================================
@pytest.mark.asyncio
async def test_client_to_upstream_passthrough(upstream):
    ws = StubWebSocket()
    ws.feed_text(json.dumps({"audio_duration_seconds": 5.0}))  # meta：网关消费
    ws.feed_text("hello-upstream")
    ws.feed_bytes(b"\xde\xad\xbe\xef")
    ws.trigger_disconnect()

    meta_seen: list[dict] = []

    async def on_meta(meta: dict) -> None:
        meta_seen.append(meta)

    result = await forward_ws_session(
        client_ws=ws,
        upstream_url=upstream.url,
        api_key="test-key",
        on_meta=on_meta,
    )

    # 上游只收到 2 条（meta 被网关消费，不转发）
    assert len(upstream.received) == 2
    assert upstream.received[0] == "hello-upstream"
    assert upstream.received[1] == b"\xde\xad\xbe\xef"

    # meta 钩子触发 1 次
    assert len(meta_seen) == 1
    assert meta_seen[0] == {"audio_duration_seconds": 5.0}

    assert result["duration_seconds"] >= 0
    # counters：客户端发出 2 文本(含被消费的 meta) + 1 bytes；上游没回包
    assert result["counters"]["client_text"] == 2
    assert result["counters"]["client_bytes"] == 1
    assert result["counters"]["upstream_text"] == 0
    assert result["counters"]["upstream_bytes"] == 0


# ============================================================
# Test 2: meta 钩子只认首个含保留键的 JSON 帧
# ============================================================
@pytest.mark.asyncio
async def test_meta_hook_only_fires_once_on_json(upstream):
    ws = StubWebSocket()
    # run-task 形态的首帧（无 audio_duration_seconds 键）→ 照常转发，meta 窗口关闭
    ws.feed_text(json.dumps({"header": {"action": "run-task"}}))
    ws.feed_text(json.dumps({"audio_duration_seconds": 99.0}))  # 晚了，不再当 meta
    ws.trigger_disconnect()

    meta_seen: list[dict] = []

    async def on_meta(meta: dict) -> None:
        meta_seen.append(meta)

    await forward_ws_session(
        client_ws=ws,
        upstream_url=upstream.url,
        api_key="test-key",
        on_meta=on_meta,
    )

    # 首帧不是 meta（无保留键）→ 钩子不触发，后续帧也不再检查
    assert len(meta_seen) == 0
    # 两帧都原样到达上游
    assert len(upstream.received) == 2
    assert json.loads(upstream.received[0]) == {"header": {"action": "run-task"}}


# ============================================================
# Test 3: 上游 → 客户端 透传（自定义 handler 主动推消息）
# ============================================================
@pytest.mark.asyncio
async def test_upstream_to_client_passthrough():
    """客户端发 1 条后断开；上游主动推 2 条文本 + 1 条二进制。"""

    # 自定义 handler：发回 3 条消息后保持连接（客户端会断开）
    async def push_handler(ws):
        await ws.send("result-text-1")
        await ws.send("result-text-2")
        await ws.send(b"\xab\xcd\xef")
        # 等客户端断开
        try:
            await ws.recv()
        except websockets.ConnectionClosed:
            pass

    server = await websockets.serve(push_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    url = f"ws://127.0.0.1:{port}"

    try:
        ws = StubWebSocket()
        ws.feed_text("ping")
        ws.trigger_disconnect()

        await forward_ws_session(
            client_ws=ws,
            upstream_url=url,
            api_key="test-key",
        )

        # 客户端收到 2 文本 + 1 二进制
        assert len(ws.sent_text) == 2
        assert ws.sent_text == ["result-text-1", "result-text-2"]
        assert len(ws.sent_bytes) == 1
        assert ws.sent_bytes[0] == b"\xab\xcd\xef"
    finally:
        server.close()
        await server.wait_closed()


# ============================================================
# Test 4: 客户端断开后 upstream 跟着关闭
# ============================================================
@pytest.mark.asyncio
async def test_client_disconnect_closes_upstream(upstream):
    ws = StubWebSocket()
    ws.feed_text("ping")
    ws.trigger_disconnect()

    result = await forward_ws_session(
        client_ws=ws,
        upstream_url=upstream.url,
        api_key="test-key",
    )

    # forward_ws_session 正常返回
    assert result["duration_seconds"] >= 0
    # 上游 handler 已感知到关闭
    assert upstream.closed_event.is_set()


# ============================================================
# Test 5: 上游连不上时抛 WebSocketException
# ============================================================
@pytest.mark.asyncio
async def test_upstream_unreachable_raises():
    ws = StubWebSocket()
    # 不 feed 任何消息；forwarder 会在 open_timeout 后失败
    with pytest.raises((OSError, websockets.WebSocketException, asyncio.TimeoutError, ConnectionRefusedError)):
        await forward_ws_session(
            client_ws=ws,
            upstream_url="ws://127.0.0.1:1",  # 一定连不上
            api_key="x",
            open_timeout=1.0,
        )


# ============================================================
# Test 6: disable_ssl 参数生效（连接 ws:// 不需要）
# ============================================================
@pytest.mark.asyncio
async def test_disable_ssl_ignored_for_ws(upstream):
    """disable_ssl=True 用于 wss:// 上游，对 ws:// 应无副作用。"""
    ws = StubWebSocket()
    ws.feed_text("ping")
    ws.trigger_disconnect()

    result = await forward_ws_session(
        client_ws=ws,
        upstream_url=upstream.url,  # ws://
        api_key="test-key",
        disable_ssl=True,  # 应被忽略
    )
    assert result["duration_seconds"] >= 0


# ============================================================
# Test 7: capture_upstream_text 捕获上游文本帧（预算内收集、超限截断）
# ============================================================
@pytest.mark.asyncio
async def test_capture_upstream_text_budget():
    """上游推 3 条文本 + 1 条二进制：预算内全收，预算耗尽标记 truncated。"""

    frames = [
        json.dumps({"header": {"event": "result-generated"}}),
        json.dumps({"header": {"event": "task-finished"}}),
        "plain-text-frame",
    ]

    async def push_handler(ws):
        for f in frames:
            await ws.send(f)
        await ws.send(b"\x01\x02")
        try:
            await ws.recv()
        except websockets.ConnectionClosed:
            pass

    server = await websockets.serve(push_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    url = f"ws://127.0.0.1:{port}"

    try:
        ws = StubWebSocket()
        ws.feed_text("ping")
        ws.trigger_disconnect()

        # 预算充足：全部文本帧捕获，二进制不参与捕获
        result = await forward_ws_session(
            client_ws=ws,
            upstream_url=url,
            api_key="test-key",
            capture_upstream_text=4096,
        )
        assert result["upstream_texts"] == frames
        assert result["upstream_texts_truncated"] is False
        assert len(ws.sent_text) == 3
        assert len(ws.sent_bytes) == 1
    finally:
        server.close()
        await server.wait_closed()

    # 预算只够第一帧：后续文本帧丢弃并置 truncated
    server2 = await websockets.serve(push_handler, "127.0.0.1", 0)
    port2 = server2.sockets[0].getsockname()[1]
    try:
        ws2 = StubWebSocket()
        ws2.feed_text("ping")
        ws2.trigger_disconnect()

        result2 = await forward_ws_session(
            client_ws=ws2,
            upstream_url=f"ws://127.0.0.1:{port2}",
            api_key="test-key",
            capture_upstream_text=len(frames[0]),
        )
        assert result2["upstream_texts"] == [frames[0]]
        assert result2["upstream_texts_truncated"] is True
        # 透传不受捕获截断影响
        assert len(ws2.sent_text) == 3
    finally:
        server2.close()
        await server2.wait_closed()


@pytest.mark.asyncio
async def test_capture_off_by_default(upstream):
    """不传 capture_upstream_text 时返回空列表、不截断。"""
    ws = StubWebSocket()
    ws.feed_text("ping")
    ws.trigger_disconnect()

    result = await forward_ws_session(
        client_ws=ws,
        upstream_url=upstream.url,
        api_key="test-key",
    )
    assert result["upstream_texts"] == []
    assert result["upstream_texts_truncated"] is False
