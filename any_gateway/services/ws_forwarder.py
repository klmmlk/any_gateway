"""
WebSocket 双向透传转发器。

网关对外是 FastAPI WebSocket 端点，对内是任意 wss:// 上游。
本模块只做"字节级双向 pump + 鉴权头注入 + 第一帧 meta 钩子"，不解析任何
业务协议（如 DashScope ASR 的 start/continue/stop 帧），由客户端自行负责。

设计要点：
- 客户端 → 上游 与 上游 → 客户端 用 asyncio.gather 并发，互相阻塞。
- 任意一端断开，立刻取消另一端的 task，关闭两侧连接。
- 第一个客户端文本帧若可解析为 JSON，调用 on_meta(meta) 钩子，
  约定字段 `audio_duration_seconds` 用于 ASR 类按音频时长计费。
- 上游鉴权头以 `Authorization: Bearer {api_key}` 注入。
- 整体超时由外层 WS 端点控制（与 TIMEOUT_BOUND=600s 对齐），本模块不重复设置。
"""
from __future__ import annotations

import asyncio
import json
import ssl
import time
from typing import Any, Awaitable, Callable, Optional

import websockets
from fastapi import WebSocket
from loguru import logger
from websockets.exceptions import WebSocketException


# Meta 钩子：第一个客户端文本帧为 JSON 且含 audio_duration_seconds 时触发。
# 约定：该帧是网关级计费声明，由网关**消费**（不转发上游——DashScope 等真实上游
# 只认 run-task 开头，多余 JSON 会触发 task-failed）。
# 接受 dict,返回 None（hook 内部就地修改调用方传入的容器即可）。
OnMetaHook = Optional[Callable[[dict], Awaitable[None]]]

# meta 帧的保留键；真实业务帧不会在顶层带这个键
_META_KEY = "audio_duration_seconds"


async def _client_to_upstream(
    client_ws: WebSocket,
    upstream: websockets.WebSocketClientProtocol,
    on_meta: OnMetaHook,
    meta_seen: dict,
    counters: dict,
) -> None:
    """客户端 → 上游：逐条 receive，按类型原样 send。

    首条文本消息若是 JSON 且含 META_KEY，视为网关计费声明：消费（不转发）并调
    on_meta(meta) 一次。其余消息透传，不修改内容。
    """
    while True:
        msg = await client_ws.receive()
        # FastAPI WebSocket 的消息结构：{"type": "websocket.receive", "text"|"bytes": ..., "client": ...}
        mtype = msg.get("type")
        if mtype == "websocket.disconnect":
            # 客户端主动断开，主动 close 上游
            await upstream.close()
            return
        if "text" in msg and msg["text"] is not None:
            text = msg["text"]
            if not meta_seen.get("done") and on_meta is not None:
                meta_seen["done"] = True
                try:
                    meta = json.loads(text)
                except (ValueError, TypeError):
                    meta = None
                if isinstance(meta, dict) and _META_KEY in meta:
                    meta_seen["payload"] = meta
                    try:
                        await on_meta(meta)
                    except Exception:  # noqa: BLE001
                        logger.exception("on_meta 钩子异常")
                    counters["client_text"] += 1
                    continue  # 消费掉，不转发上游
            await upstream.send(text)
            counters["client_text"] += 1
        elif "bytes" in msg and msg["bytes"] is not None:
            await upstream.send(msg["bytes"])
            counters["client_bytes"] += 1


async def _upstream_to_client(
    upstream: websockets.WebSocketClientProtocol,
    client_ws: WebSocket,
    counters: dict,
    capture: Optional[dict] = None,
) -> None:
    """上游 → 客户端：按上游消息类型原样 send。

    capture 非空时，把上游文本帧原样收集到 capture["texts"]，
    直到剩余预算 capture["budget"] 用尽（置 truncated 标记，不再捕获）。
    只存原始帧、不解析协议，供会话结束后离线提取（如 ASR 转写文本）。
    """
    async for raw in upstream:
        if isinstance(raw, str):
            await client_ws.send_text(raw)
            counters["upstream_text"] += 1
            if capture is not None:
                if len(raw) <= capture["budget"]:
                    capture["budget"] -= len(raw)
                    capture["texts"].append(raw)
                else:
                    capture["truncated"] = True
        else:
            # websockets>=12 的消息对象同时支持 str/bytes；raw 也可能是 Iterable[bytes]
            data = bytes(raw) if not isinstance(raw, (bytes, bytearray)) else raw
            await client_ws.send_bytes(data)
            counters["upstream_bytes"] += 1


async def forward_ws_session(
    *,
    client_ws: WebSocket,
    upstream_url: str,
    api_key: str,
    extra_headers: Optional[dict] = None,
    proxy_url: Optional[str] = None,
    disable_ssl: bool = False,
    subprotocols: Optional[list[str]] = None,
    on_meta: OnMetaHook = None,
    open_timeout: float = 30.0,
    capture_upstream_text: int = 0,
) -> dict:
    """建立上游 wss 连接，并在客户端与上游之间做双向 pump。

    capture_upstream_text > 0 时，捕获上游文本帧原文（总字符数不超过该值），
    用于会话结束后落日志/离线解析；0 表示不捕获。

    Returns: dict，包含
        - duration_seconds: float，WS 会话墙钟时长
        - meta: dict，第一帧客户端 JSON 文本的解析结果（若有）
        - counters: dict，{client_text, client_bytes, upstream_text, upstream_bytes}
        - upstream_texts: list[str]，捕获的上游文本帧原文（可能截断）
        - upstream_texts_truncated: bool，是否因预算用尽而截断
        - upstream_subprotocol: str | None，上游选定的子协议

    Raises:
        WebSocketException：上游连接失败 / 协议错误
        asyncio.TimeoutError：open_timeout 内未连上
    """
    headers = {"Authorization": f"Bearer {api_key}"}
    if extra_headers:
        headers.update(extra_headers)

    # SSL 策略（websockets>=14 对参数校验很严）：
    #   wss:// + disable_ssl → 自签名上下文；wss:// 正常 → True（默认上下文）；
    #   ws:// → 必须不传 ssl（显式 None 对 wss:// 会抛 ValueError）
    ssl_arg: ssl.SSLContext | bool | None = None
    url_lower = upstream_url.lower()
    if url_lower.startswith("wss://"):
        if disable_ssl:
            insecure_ctx = ssl.create_default_context()
            insecure_ctx.check_hostname = False
            insecure_ctx.verify_mode = ssl.CERT_NONE
            ssl_arg = insecure_ctx
        else:
            ssl_arg = True  # 默认证书校验

    started = time.monotonic()
    meta_seen: dict = {"done": False, "payload": None}
    counters: dict = {
        "client_text": 0,
        "client_bytes": 0,
        "upstream_text": 0,
        "upstream_bytes": 0,
    }
    capture: Optional[dict] = (
        {"budget": capture_upstream_text, "texts": [], "truncated": False}
        if capture_upstream_text > 0 else None
    )

    # websockets>=12 的 connect 是 async context manager。
    # 这里我们手工管理连接生命周期，便于在 gather 异常时显式 close。
    upstream = await websockets.connect(
        upstream_url,
        additional_headers=headers,
        subprotocols=subprotocols,
        ssl=ssl_arg,
        proxy=proxy_url,
        open_timeout=open_timeout,
        max_size=None,  # 音频流可能很大；让外层 uvicorn --ws-max-size 控制
    )

    try:
        # gather 任一端异常即取消另一端，关闭两侧
        client_task = asyncio.create_task(
            _client_to_upstream(client_ws, upstream, on_meta, meta_seen, counters)
        )
        upstream_task = asyncio.create_task(
            _upstream_to_client(upstream, client_ws, counters, capture)
        )
        done, pending = await asyncio.wait(
            {client_task, upstream_task},
            return_when=asyncio.FIRST_EXCEPTION,
        )
        for t in pending:
            t.cancel()
        # 等待被取消的 task 真正结束
        for t in pending:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        # 收集已结束 task 的异常
        for t in done:
            exc = t.exception()
            if exc is not None and not isinstance(exc, (WebSocketException, ConnectionError)):
                # WebSocketException / ConnectionError 视为正常关闭
                raise exc
    finally:
        try:
            await upstream.close()
        except Exception:  # noqa: BLE001
            pass

    return {
        "duration_seconds": time.monotonic() - started,
        "meta": meta_seen.get("payload"),
        "counters": counters,
        "upstream_texts": capture["texts"] if capture else [],
        "upstream_texts_truncated": capture["truncated"] if capture else False,
        "upstream_subprotocol": upstream.subprotocol,
    }
