"""
DashScope 实时 ASR 模型白名单。

阿里达摩院的实时语音识别 API 走 WebSocket(wss://...maas.aliyuncs.com/api-ws/v1/inference)，
没有标准的 /v1/models 端点（与 OpenAI 协议不兼容），admin 拉模型列表时直接返回本表
由用户手动选择。

各模型 wss base_url 因 region 而异，本表只给模型 ID，URL 由用户填到渠道的 base_url。
详见 https://help.aliyun.com/zh/model-studio/developer-reference/real-time-speech-recognition-api
"""
from __future__ import annotations

# 阿里云 Model Studio（DashScope）实时 ASR / TTS / 翻译等实时流式模型。
# 字段保持与 OpenAI /models 响应中的 data 项结构一致（id / object / created / owned_by），
# 这样 admin 拉模型列表的前端组件可以无差别渲染。
DASHSCOPE_ASR_MODELS: list[dict] = [
    {
        "id": "qwen-audio-3.0-asr-flash-streaming",
        "object": "model",
        "created": 0,
        "owned_by": "dashscope",
    },
    {
        "id": "paraformer-realtime-v2",
        "object": "model",
        "created": 0,
        "owned_by": "dashscope",
    },
    {
        "id": "paraformer-8k-v1",
        "object": "model",
        "created": 0,
        "owned_by": "dashscope",
    },
    {
        "id": "paraformer-mtl-v1",
        "object": "model",
        "created": 0,
        "owned_by": "dashscope",
    },
    {
        "id": "sensevoice-v1",
        "object": "model",
        "created": 0,
        "owned_by": "dashscope",
    },
]


def is_dashscope_asr_model(model_id: str) -> bool:
    return any(m["id"] == model_id for m in DASHSCOPE_ASR_MODELS)
