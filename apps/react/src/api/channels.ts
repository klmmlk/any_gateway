import client from './client'

export interface Channel {
  id: string
  name: string
  provider: string
  base_url: string
  api_key: string
  weight: number
  enabled: boolean
  models: string | null
  model_mapping: string | null
  proxy_url: string | null
  disable_ssl: boolean
  disable_compression: boolean
  /** "http" | "wss"。wss 表示该渠道是 WebSocket 上游（用于实时 ASR 等场景）。 */
  protocol?: string
  /** wss 模式下上游 WS 路径，如 /api-ws/v1/inference */
  ws_path?: string | null
  /** wss 子协议，JSON 数组字符串，如 '["binary"]' */
  ws_subprotocols?: string | null
  created_at: string
}

export interface ChannelCreate {
  name: string
  provider: string
  base_url: string
  api_key: string
  weight?: number
  enabled?: boolean
  models?: string | null
  model_mapping?: string | null
  proxy_url?: string | null
  disable_ssl?: boolean
  disable_compression?: boolean
  protocol?: string
  ws_path?: string | null
  ws_subprotocols?: string | null
}

export const getChannels = (params?: Record<string, unknown>) =>
  client.get('/admin/channels', { params })

export const createChannel = (data: ChannelCreate) =>
  client.post('/admin/channels', data)

export const updateChannel = (id: string, data: Partial<ChannelCreate>) =>
  client.patch(`/admin/channels/${id}`, data)

export const deleteChannel = (id: string) =>
  client.delete(`/admin/channels/${id}`)

export const getUpstreamModels = (id: string) =>
  client.get(`/admin/channels/${id}/upstream-models`)
