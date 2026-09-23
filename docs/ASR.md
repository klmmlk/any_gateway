# 实时 ASR(WebSocket)中转接入文档

网关支持把 DashScope(阿里云百炼)的**实时流式语音识别**模型通过 WebSocket 中转给客户端。适用模型:`qwen-audio-3.0-asr-flash-streaming`、`paraformer-realtime-v2` 等(完整清单见 `any_gateway/services/asr_catalog.py`)。

## 一、工作原理

```
客户端(WS) ⇄ 网关 ws://…/v1/audio/asr/stream ⇄ 上游 wss://…/api-ws/v1/inference
```

- 网关做**字节级双向透传**,不解析 DashScope 的帧协议(start-task/continue-task/finish-task 控制帧与二进制音频帧由客户端自行组包)。
- 网关负责:鉴权、配额检查、按模型路由到渠道、会话结束后计费。
- 客户端协议与直连 DashScope 完全一致,唯一区别是连接 URL 和鉴权方式。

## 二、管理端配置

### 1. 建渠道

在「渠道管理」新建:

| 字段 | 值 |
|---|---|
| Provider | `DashScope ASR (wss)` |
| Base URL | `https://llm-xxxxx.cn-beijing.maas.aliyuncs.com`(按 https 填,网关运行时自动替换为 wss://) |
| API Key | DashScope API Key |
| 上游协议 | `WSS(WebSocket)` |
| WSS 路径 | `/api-ws/v1/inference`(留空即用此默认值) |

> DashScope 的 wss 主机名因账号/region 而异,以控制台「模型推理 API → WebSocket 调用」页给出的地址为准。

「管理模型」里点"搜索上游"会返回内置白名单(`services/asr_catalog.py`),勾选即可;新增模型可手动添加或改白名单文件。

### 2. 配价格

「价格管理」编辑对应模型,填写**音频秒单价 (USD/秒)**。计费公式:`费用 = 音频秒数 × 单价 × 分组倍率`。

### 3. 迁移(已有生产库时)

新库无需任何操作(`init_db()` 幂等自动加列)。已有库二选一:

- 直接重启:启动时 `init_db()` 会自动 `ALTER TABLE` 加列;
- 或手动执行 `migrations/add_channel_ws_fields.sql` 和 `migrations/add_usage_log_audio_seconds.sql`。

## 三、客户端接入

### 连接地址

```
ws://<网关>/v1/audio/asr/stream?model=<模型名>&api_key=<网关key sk-…>
```

HTTPS 网关对应 `wss://`。鉴权走 query 参数(浏览器 WebSocket 无法自定义 header)。

### 协议约定(2026-09-23 实测校准)

1. 连接后按 DashScope 双工协议收发。**实测帧格式**:
   - run-task:`{"header":{"action":"run-task","task_id":"<id>","streaming":"duplex"},"payload":{"task_group":"audio","task":"asr","function":"recognition","model":"<模型>","input":{},"parameters":{"format":"mp3","sample_rate":16000}}}`
     - `payload.input` 必填(可为空对象),漏了报 `Missing required parameter 'payload.input'`
     - `sample_rate` 必填,漏了报 `resample audio from 0 to 16000 failed`
   - 音频:二进制帧直发(建议 ~100ms 一片,支持快于实时)
   - finish-task:`{"header":{"action":"finish-task","task_id":"<id>","streaming":"duplex"},"payload":{"input":{}}}`
   - 结果事件:`task-started` → `result-generated`(payload.output.sentence.text,partial 逐步增长,新句以空 text 开头)→ `task-finished` / `task-failed`
2. **计费约定**(可选):若客户端第一个**文本**帧是 JSON 且含 `audio_duration_seconds` 字段,网关以该值计费,**该帧由网关消费、不会转发到上游**;否则按 WS 连接墙钟时长计费。
3. 错误关闭码:`1008` 鉴权失败/配额超限/模型未找到/渠道非 wss;`1011` 上游连接失败。

### Python 示例(裸 websockets,帧格式已实测校准)

```python
import asyncio, json, wave, websockets

MODEL = "qwen-audio-3.0-asr-flash-streaming"
KEY = "sk-…"  # 网关 key
TASK_ID = "my-task-001"  # 每个会话自定一个唯一 id

async def main():
    url = f"ws://127.0.0.1:8003/v1/audio/asr/stream?model={MODEL}&api_key={KEY}"
    async with websockets.connect(url, max_size=None) as ws:
        # (可选)计费声明:已知音频总时长时发,网关消费不转发
        # await ws.send(json.dumps({"audio_duration_seconds": 41.0}))

        # 1. run-task —— payload.input 与 parameters.sample_rate 均必填
        await ws.send(json.dumps({
            "header": {"action": "run-task", "task_id": TASK_ID, "streaming": "duplex"},
            "payload": {
                "task_group": "audio", "task": "asr", "function": "recognition",
                "model": MODEL, "input": {},
                "parameters": {"format": "wav", "sample_rate": 16000},
            },
        }))

        # 2. 音频二进制帧(16kHz 16bit wav,100ms=3200B 一片,边收边发也行)
        with wave.open("audio.wav", "rb") as f:
            pcm = f.readframes(f.getnframes())
        for i in range(0, len(pcm), 3200):
            await ws.send(pcm[i:i + 3200])
            await asyncio.sleep(0.1)  # 实时上行;实测快于实时也接受

        # 3. finish-task —— payload.input 同样必填
        await ws.send(json.dumps({
            "header": {"action": "finish-task", "task_id": TASK_ID, "streaming": "duplex"},
            "payload": {"input": {}},
        }))

        # 4. 收结果:partial 逐步增长,新句以空 text 开头;task-finished 结束
        async for msg in ws:
            data = json.loads(msg)
            event = data["header"]["event"]
            if event == "result-generated":
                s = data["payload"]["output"]["sentence"]
                print(f"[{s.get('begin_time')}-{s.get('end_time')}ms] {s.get('text')}")
            elif event == "task-finished":
                break
            elif event == "task-failed":
                print("失败:", data["header"].get("error_message"))
                break

asyncio.run(main())
```

### 浏览器 JS 示例(麦克风实时识别)

```javascript
const MODEL = "qwen-audio-3.0-asr-flash-streaming";
const KEY = "sk-…";
const TASK_ID = crypto.randomUUID();

const ws = new WebSocket(
  `wss://你的网关/v1/audio/asr/stream?model=${MODEL}&api_key=${KEY}`
);
ws.binaryType = "arraybuffer";

ws.onopen = async () => {
  ws.send(JSON.stringify({
    header: { action: "run-task", task_id: TASK_ID, streaming: "duplex" },
    payload: {
      task_group: "audio", task: "asr", function: "recognition",
      model: MODEL, input: {},
      parameters: { format: "pcm", sample_rate: 16000 },
    },
  }));
  const stream = await navigator.mediaDevices.getUserMedia({ audio: {
    sampleRate: 16000, channelCount: 1, echoCancellation: true,
  }});
  const ctx = new AudioContext({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(3200, 1, 1); // ~100ms
  source.connect(processor);
  processor.connect(ctx.destination);
  processor.onaudioprocess = (e) => {
    // Float32 → Int16 PCM
    const f32 = e.inputBuffer.getChannelData(0);
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(i16.buffer);
  };
  // 停止时:先断开录音,再发 finish-task
};

ws.onmessage = (ev) => {
  const data = JSON.parse(ev.data);
  const event = data.header?.event;
  if (event === "result-generated") {
    const s = data.payload?.output?.sentence;
    if (s?.text) console.log(`[${s.begin_time}-${s.end_time}ms]`, s.text);
  } else if (event === "task-failed") {
    console.error("识别失败:", data.header?.error_message);
  }
};

// 停止识别:ws.send(JSON.stringify({
//   header: { action: "finish-task", task_id: TASK_ID, streaming: "duplex" },
//   payload: { input: {} },
// }))
```

### 使用 DashScope SDK 指向网关

官方 SDK 支持改 websocket 基址:

```python
import dashscope
dashscope.base_websocket_api_url = "ws://<网关>:8003/v1/audio/asr/stream"  # SDK 会拼其余路径
```

> SDK 鉴权用 `Authorization: Bearer <DASHSCOPE_API_KEY>` header,而网关 WS 端点要求 query 参数。两种做法:
> 1. 把网关 key 填进 `dashscope.api_key`,并给 SDK 传 `?api_key=`(部分版本支持 extra query);
> 2. 不改 SDK,按上面的裸 websockets 示例自行组帧(推荐,帧协议很简单)。

## 四、部署注意

- **Docker(Uvicorn)原生支持 WebSocket**,现有 `Dockerfile`/`docker-compose.yml` 无需改动;
- 若网关前面有 Nginx 反代,需加:
  ```nginx
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 600s;
  ```
- 大音频帧场景可给 uvicorn 加 `--ws-max-size`(默认 16MB,一般足够);
- 会话级超时:`TIMEOUT_BOUND=600s` 风格,WS 空闲超过该量级由 uvicorn/客户端自行断开。

## 五、计费与用量

- 用量记录写入 `usage_logs`,新增 `audio_seconds` 字段,`model` 为客户端请求的模型名,`channel_id` 记录实际命中的渠道;
- 与 token 计费互斥:ASR 会话只产生 audio_seconds,不产生 input/output tokens;
- 价格查表顺序与现有逻辑一致:Group 自定义价优先 → 全局价兜底;`request` 固定价(若配置)仍最高优先。

## 六、验证

```bash
# 单元 + 集成测试
uv run pytest tests/test_ws_forwarder.py tests/test_asr_endpoint.py -v

# 手动链路压测(模拟帧)
uv run bench_asr_ws.py official   # 直连上游
uv run bench_asr_ws.py gateway    # 走网关
```
