# TTS 语音合成(WebSocket)接入文档

网关支持把阿里云百炼的**语音合成**模型通过 WebSocket 中转给客户端。当前可用模型:`TTS-Model`。

## 一、工作原理

```
客户端(WS) ⇄ 网关 ws://…/v1/audio/tts/stream ⇄ 上游 wss://…/api-ws/v1/inference
```

- 网关做**字节级双向透传**,不解析 DashScope 的帧协议(控制帧与二进制音频帧由客户端按 DashScope 任务协议自行组包)。
- 网关负责:鉴权、配额检查、按模型路由到渠道、会话结束后按价格配置计费。
- 客户端协议与直连 DashScope 完全一致,唯一区别是连接 URL 和鉴权方式。

## 二、准备工作

### 1. 拿到网关 Key

向管理员申请 `sk-…` 格式的 API Key(需绑定到含 TTS 模型的分组)。

### 2. 查询模型音色列表

模型音色列表**无需鉴权**,直接 GET:

```bash
curl http://<网关>/v1/models/TTS-Model
```

响应示例(节选):

```json
{
  "id": "TTS-Model",
  "object": "model",
  "owned_by": "dashscope",
  "voices": [
    {
      "voice": "longanfengyue",
      "info": "自然亲切音（30岁女，中英）",
      "trial_url": "https://…/03_longanfengyue.wav"
    }
  ]
}
```

- `voices[].voice` 就是合成时要传的 `voice` 参数,**请原样复制,不要自己拼写**;
- `info` 为音色说明(特质/年龄/性别/语言);
- `trial_url` 为试听音频地址(管理员未配置的音色没有该字段)。

**建议把音色列表做成动态获取**(每次启动或定期拉取),不要写死——管理员可能增删音色。

## 三、调用协议(2026-10-19 实测校准)

### 连接地址

```
ws://<网关>/v1/audio/tts/stream?model=<模型名>&api_key=<网关key sk-…>
```

HTTPS 网关对应 `wss://`。鉴权走 query 参数(浏览器 WebSocket 无法自定义 header)。

### 帧流程(一次合成三步)

以 `TTS-Model` 为例,该模型为 `streaming: "out"` 单向输出模式:

1. **run-task**(待合成文本直接放在 `payload.input.text`):

   ```json
   {
     "header": {"action": "run-task", "task_id": "<自定义唯一id>", "streaming": "out"},
     "payload": {
       "task_group": "audio",
       "task": "tts",
       "function": "SpeechSynthesizer",
       "model": "TTS-Model",
       "parameters": {"voice": "longanfengyue", "format": "wav", "sample_rate": 24000},
       "input": {"text": "要合成的完整文本"}
     }
   }
   ```

   ⚠️ **不要发 continue-task**:该模型不支持流式送文本,发了会收到
   `InvalidParameter: continue-task not allowed for current streaming mode`。
   长文本直接整段放进 `input.text` 即可。

2. **finish-task**(通知上游文本结束):

   ```json
   {"header": {"action": "finish-task", "task_id": "<同上>", "streaming": "out"}, "payload": {"input": {}}}
   ```

3. **收结果**:

   - `task-started`:任务已受理;
   - **二进制帧 = 音频数据**(依次拼接即为完整音频文件);
   - `result-generated`:合成进度事件;
   - `task-finished`:合成结束,`payload.usage.characters` 为本次计费字符数;
   - `task-failed`:失败,`header.error_code` / `header.error_message` 给出原因。

实测输出:24kHz 单声道 16bit WAV 流(`format: "wav"`),按顺序拼接二进制帧后即为可播放的 .wav 文件。

### 错误关闭码(网关侧)

WS 连接被网关关闭时:`1008` 鉴权失败 / 配额超限 / 模型未找到;`1011` 上游连接失败。协议内错误(如参数错)以上游 `task-failed` 帧返回。


## 七、常见问题

| 现象 | 原因与处理 |
|---|---|
| 连接即被关闭,code=1008 | api_key 缺失/错误、key 被冻结或过期、分组未挂载该模型 → 检查 key 与分组 |
| 连接即被关闭,code=1011 | 网关连不上上游 → 稍后重试,持续失败联系管理员 |
| `task-failed: continue-task not allowed` | 该模型不支持流式送文本 → 文本放 run-task 的 `input.text`(见上) |
| `task-failed: InvalidParameter` 带 voice 相关信息 | voice 参数拼写错误 → 从 `/v1/models` 的 voices 里原样复制 |
| 收到的音频播放不了 | 确认按顺序拼接了**全部**二进制帧,且 `format` 参数与播放器匹配(默认 wav) |
