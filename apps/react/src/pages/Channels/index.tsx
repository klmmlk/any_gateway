import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Table,
  Button,
  Drawer,
  Form,
  Input,
  Select,
  Switch,
  InputNumber,
  Tag,
  Message,
  Space,
  Popconfirm,
  Typography,
  Grid,
  Modal,
  Checkbox,
  Spin,
  Radio,
} from '@arco-design/web-react'
import { IconPlus, IconDelete, IconRefresh, IconSettings, IconSearch } from '@arco-design/web-react/icon'
import type { ColumnProps } from '@arco-design/web-react/es/Table'
import {
  getChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  getUpstreamModels,
  type Channel,
} from '../../api/channels'

const { Row, Col } = Grid
const FormItem = Form.Item

const PROVIDER_COLORS: Record<string, string> = {
  openai: 'arcoblue',
  anthropic: 'purple',
  gemini: 'green',
  'dashscope-asr': 'orange',
}

const PROVIDER_OPTIONS = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'Gemini', value: 'gemini' },
  { label: 'DashScope ASR (wss)', value: 'dashscope-asr' },
]

interface Mapping {
  from: string
  to: string
}

function parseMappingKeys(model_mapping: string | null): string[] {
  try {
    return Object.keys(JSON.parse(model_mapping || '{}'))
  } catch {
    return []
  }
}

function parseModelsCount(models: string | null, model_mapping: string | null): number {
  // 与弹窗列表、后端路由一致：models ∪ 映射键 去重计数
  return parseModelIds(models, model_mapping).length
}

function parseModelIds(models: string | null, model_mapping: string | null): string[] {
  const result = new Set<string>(parseMappingKeys(model_mapping))
  try {
    const list = JSON.parse(models || '[]')
    // 支持对象数组（{id: ...}）和字符串数组两种格式
    for (const m of list) {
      const id = m && typeof m === 'object' && 'id' in m ? String((m as { id: unknown }).id) : String(m)
      result.add(id)
    }
  } catch {
    // noop
  }
  return Array.from(result)
}

function parseMappings(model_mapping: string | null): Mapping[] {
  try {
    const obj = JSON.parse(model_mapping || '{}')
    return Object.entries(obj).map(([from, to]) => ({ from, to: to as string }))
  } catch {
    return []
  }
}

interface VoiceEntry {
  voice: string
  info: string
  trial_url?: string
}

// 解析 models JSON：返回原始条目（保留未知扩展字段）+ 各模型音色（键存在 = 标记为 TTS）。
// 兼容旧格式：voices 元素为纯字符串时转成 {voice, info: ''}；旧键 desc 视同 info。
function parseModelsDetail(models: string | null): {
  entries: Array<string | Record<string, unknown>>
  voices: Record<string, VoiceEntry[]>
} {
  let entries: Array<string | Record<string, unknown>> = []
  try {
    const list = JSON.parse(models || '[]')
    if (Array.isArray(list)) entries = list
  } catch {
    // noop
  }
  const voices: Record<string, VoiceEntry[]> = {}
  for (const e of entries) {
    if (e && typeof e === 'object' && Array.isArray((e as { voices?: unknown }).voices)) {
      const id = String((e as { id?: unknown }).id ?? (e as { name?: unknown }).name ?? '')
      if (!id) continue
      voices[id] = (e as { voices: unknown[] }).voices
        .map((v) => {
          if (typeof v === 'string') return { voice: v, info: '' }
          const o = v as { voice?: unknown; info?: unknown; desc?: unknown; trial_url?: unknown }
          const entry: VoiceEntry = {
            voice: String(o.voice ?? ''),
            info: String(o.info ?? o.desc ?? ''),
          }
          if (typeof o.trial_url === 'string' && o.trial_url) entry.trial_url = o.trial_url
          return entry
        })
        .filter((v) => v.voice)
    }
  }
  return { entries, voices }
}

// —— 音色编辑框用 TOML 子集：[音色名] 小节 + info / trial_url 两个字符串键 ——
// 宽松解析：小节名允许裸中文/斜杠/冒号，也可加引号；值为单双引号字符串，支持行尾 # 注释。
const TOML_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' }

function readTomlString(line: string, start: number, lineNo: number): [string, number] {
  const quote = line[start]
  if (quote !== '"' && quote !== "'") throw new Error(`第 ${lineNo} 行：值必须是带引号的字符串`)
  let out = ''
  let i = start + 1
  while (i < line.length) {
    const ch = line[i]
    if (quote === "'") {
      if (ch === "'") return [out, i + 1]
      out += ch
      i++
      continue
    }
    if (ch === '\\') {
      const nxt = line[i + 1]
      if (!nxt || !(nxt in TOML_ESCAPES)) throw new Error(`第 ${lineNo} 行：非法转义 \\${nxt ?? ''}`)
      out += TOML_ESCAPES[nxt]
      i += 2
      continue
    }
    if (ch === '"') return [out, i + 1]
    out += ch
    i++
  }
  throw new Error(`第 ${lineNo} 行：字符串未闭合`)
}

function checkTomlTail(line: string, i: number, lineNo: number, what: string) {
  const rest = line.slice(i).trim()
  if (rest && !rest.startsWith('#')) throw new Error(`第 ${lineNo} 行：${what}后有多余内容 "${rest}"`)
}

function parseTomlHeader(line: string, lineNo: number): string {
  let i = 1
  while (i < line.length && line[i] === ' ') i++
  let name: string
  if (line[i] === '"' || line[i] === "'") {
    const [v, end] = readTomlString(line, i, lineNo)
    name = v
    i = end
  } else {
    const close = line.indexOf(']', i)
    if (close < 0) throw new Error(`第 ${lineNo} 行：小节头缺少 ]`)
    name = line.slice(i, close).trim()
    i = close
  }
  while (i < line.length && line[i] === ' ') i++
  if (line[i] !== ']') throw new Error(`第 ${lineNo} 行：小节头缺少 ]`)
  i++
  checkTomlTail(line, i, lineNo, '小节头')
  return name
}

const parseVoicesToml = (text: string): VoiceEntry[] | string => {
  const byName = new Map<string, VoiceEntry>()
  let current: VoiceEntry | null = null
  const lines = text.split(/\r?\n/)
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1
    const line = lines[idx].trim()
    if (!line || line.startsWith('#')) continue
    try {
      if (line.startsWith('[')) {
        const name = parseTomlHeader(line, lineNo)
        if (!name) return `第 ${lineNo} 行：音色名为空`
        if (byName.has(name)) return `第 ${lineNo} 行：音色 "${name}" 重复`
        current = { voice: name, info: '' }
        byName.set(name, current)
        continue
      }
      const eq = line.indexOf('=')
      if (eq < 0) throw new Error('无法识别的行（应为 [音色名] 或 key = "值"）')
      const [key, keyEnd] = (() => {
        const raw = line.slice(0, eq)
        const s = raw.trim()
        if (s.startsWith('"') || s.startsWith("'")) return readTomlString(raw, raw.indexOf(s[0]), lineNo)
        return [s, raw.length] as [string, number]
      })()
      checkTomlTail(line.slice(0, eq), keyEnd, lineNo, '键')
      if (!current) throw new Error(`${key} 出现在任何 [音色名] 小节之前`)
      if (key !== 'info' && key !== 'trial_url') throw new Error(`不支持的键 "${key}"（只支持 info / trial_url）`)
      const rest = line.slice(eq + 1)
      const [val, end] = readTomlString(rest, rest.search(/["']/), lineNo)
      checkTomlTail(rest, end, lineNo, '值')
      if (key === 'info') current.info = val.trim()
      else if (val.trim()) current.trial_url = val.trim()
    } catch (e) {
      return `第 ${lineNo} 行：` + (e instanceof Error ? e.message : String(e))
    }
  }
  return Array.from(byName.values())
}

const quoteTomlName = (name: string) =>
  /^[A-Za-z0-9_-]+$/.test(name) ? `[${name}]` : `[${JSON.stringify(name)}]`

const voicesToToml = (voices: VoiceEntry[]): string => {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  return voices
    .map((v) => {
      const lines = [quoteTomlName(v.voice)]
      if (v.info) lines.push(`info = "${esc(v.info)}"`)
      if (v.trial_url) lines.push(`trial_url = "${esc(v.trial_url)}"`)
      return lines.join('\n')
    })
    .join('\n\n')
}

// 存储条目：空 info 不落库，未配置的 trial_url 不落库（下游就收不到该字段）
const toStorageVoice = (v: VoiceEntry) => ({
  voice: v.voice,
  ...(v.info ? { info: v.info } : {}),
  ...(v.trial_url ? { trial_url: v.trial_url } : {}),
})

const Channels: React.FC = () => {
  const [data, setData] = useState<Channel[]>([])
  const [loading, setLoading] = useState(false)
  const [drawerVisible, setDrawerVisible] = useState(false)
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [mappings, setMappings] = useState<Mapping[]>([])
  // 管理模型弹窗：选中项 + 上游候选（null = 尚未加载）
  const [managingChannel, setManagingChannel] = useState<Channel | null>(null)
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [upstreamIds, setUpstreamIds] = useState<string[] | null>(null)
  const [loadingUpstream, setLoadingUpstream] = useState(false)
  const [savingModels, setSavingModels] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [manualModel, setManualModel] = useState('')
  // 每渠道缓存上游候选：打开弹窗直接复用，仅 ⟳ 按钮强制重新拉取
  const [upstreamCache, setUpstreamCache] = useState<Record<string, string[]>>({})
  const upstreamFetchSeq = useRef(0)
  // TTS 音色草稿：键存在 = 标记为 TTS；值 = 音色列表（允许空数组 = 标记了还没配音色）
  const [modelVoices, setModelVoices] = useState<Record<string, VoiceEntry[]>>({})
  // 打开弹窗时的原始 models 条目，保存时未标记 TTS 的条目原样保留（不丢未知扩展字段）
  const [originalEntries, setOriginalEntries] = useState<Array<string | Record<string, unknown>>>([])
  // 音色编辑二级弹窗（单个 TOML 输入框）
  const [voiceEditorModel, setVoiceEditorModel] = useState<string | null>(null)
  const [voiceDraftText, setVoiceDraftText] = useState('')

  // 弹窗内派生值：候选 / 自定义（不在候选中的已选，含映射别名）/ 搜索过滤结果
  const upstreamList = upstreamIds ?? []
  const mappingKeySet = new Set(parseMappingKeys(managingChannel?.model_mapping ?? null))
  const modelKeyword = modelSearch.trim().toLowerCase()
  const matchKeyword = (id: string) => !modelKeyword || id.toLowerCase().includes(modelKeyword)
  const customIds = selectedModels.filter((id) => !upstreamList.includes(id))
  const visibleCustom = customIds.filter(matchKeyword)
  const visibleUpstream = upstreamList.filter(matchKeyword)

  const [form] = Form.useForm()

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getChannels()
      setData(res.data?.data ?? res.data ?? [])
    } catch {
      Message.error('获取 Channel 列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const openCreate = () => {
    setEditingChannel(null)
    setMappings([])
    form.resetFields()
    form.setFieldsValue({
      weight: 1,
      enabled: true,
      provider: 'openai',
      disable_ssl: false,
      disable_compression: false,
      protocol: 'http',
    })
    setDrawerVisible(true)
  }

  const openEdit = (channel: Channel) => {
    setEditingChannel(channel)
    setMappings(parseMappings(channel.model_mapping))
    form.resetFields()
    form.setFieldsValue({
      name: channel.name,
      provider: channel.provider,
      base_url: channel.base_url,
      api_key: '',
      weight: channel.weight,
      enabled: channel.enabled,
      proxy_url: channel.proxy_url ?? '',
      disable_ssl: channel.disable_ssl ?? false,
      disable_compression: channel.disable_compression ?? false,
      protocol: channel.protocol ?? 'http',
      ws_path: channel.ws_path ?? '',
      ws_subprotocols: channel.ws_subprotocols ?? '',
    })
    setDrawerVisible(true)
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validate()

      // 校验 mapping 规则完整性
      for (const m of mappings) {
        if (!m.from.trim() || !m.to.trim()) {
          Message.error('映射规则的 from 和 to 均不能为空')
          return
        }
      }
      const froms = mappings.map((m) => m.from.trim())
      if (new Set(froms).size !== froms.length) {
        Message.error('映射规则中存在重复的 from 模型名')
        return
      }

      setSubmitting(true)

      // 构建 model_mapping JSON
      const mappingObj: Record<string, string> = {}
      mappings.forEach((m) => {
        mappingObj[m.from.trim()] = m.to.trim()
      })
      const model_mapping = JSON.stringify(mappingObj)

      // proxy_url 空串归一为 null（表示不配置渠道级代理）
      const proxy_url = (values.proxy_url || '').trim() || null

      // WS 字段：仅在 protocol=wss 时携带；空串归一为 null
      const protocol = values.protocol || 'http'
      const ws_path = ((values.ws_path || '').trim() || null) as string | null
      const ws_subprotocols = ((values.ws_subprotocols || '').trim() || null) as string | null

      if (editingChannel) {
        const payload: Record<string, unknown> = {
          name: values.name,
          provider: values.provider,
          base_url: values.base_url,
          weight: values.weight,
          enabled: values.enabled,
          model_mapping,
          proxy_url,
          disable_ssl: !!values.disable_ssl,
          disable_compression: !!values.disable_compression,
          protocol,
          ws_path,
          ws_subprotocols,
        }
        // 仅当用户填写了新 API Key 才更新
        if (values.api_key) {
          payload.api_key = values.api_key
        }
        await updateChannel(editingChannel.id, payload)
        Message.success('Channel 更新成功')
      } else {
        await createChannel({
          name: values.name,
          provider: values.provider,
          base_url: values.base_url,
          api_key: values.api_key,
          weight: values.weight,
          enabled: values.enabled,
          model_mapping,
          proxy_url,
          disable_ssl: !!values.disable_ssl,
          disable_compression: !!values.disable_compression,
          protocol,
          ws_path,
          ws_subprotocols,
        })
        Message.success('Channel 创建成功')
      }

      setDrawerVisible(false)
      fetchData()
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errors' in err) {
        // Form validation error — already shown by Arco
        return
      }
      Message.error('操作失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteChannel(id)
      Message.success('删除成功')
      fetchData()
    } catch {
      Message.error('删除失败')
    }
  }

  // ------ 管理模型弹窗 ------------------------------------------------------

  const openManageModels = (channel: Channel) => {
    setManagingChannel(channel)
    // 仅勾选真实模型条目；映射别名只在编辑抽屉管理，不进弹窗、不写回 models
    setSelectedModels(parseModelIds(channel.models, null))
    const detail = parseModelsDetail(channel.models)
    setOriginalEntries(detail.entries)
    setModelVoices(detail.voices)
    setModelSearch('')
    setManualModel('')
    const cached = upstreamCache[channel.id]
    if (cached) {
      setUpstreamIds(cached)
    } else {
      setUpstreamIds(null)
      void loadUpstreamModels(channel.id)
    }
  }

  const loadUpstreamModels = async (id: string, force = false) => {
    if (!force && upstreamCache[id]) {
      setUpstreamIds(upstreamCache[id])
      return
    }
    const seq = ++upstreamFetchSeq.current
    setLoadingUpstream(true)
    try {
      const res = await getUpstreamModels(id)
      if (seq !== upstreamFetchSeq.current) return // 已切换到其他渠道/更新请求，丢弃过期响应
      const ids: string[] = res.data?.models ?? []
      setUpstreamCache((prev) => ({ ...prev, [id]: ids }))
      setUpstreamIds(ids)
    } catch {
      if (seq !== upstreamFetchSeq.current) return
      // 拉取失败不阻塞：弹窗仍可通过手动添加编辑；失败结果不写缓存，下次打开自动重试
      setUpstreamIds([])
      Message.warning('上游模型列表获取失败，可手动添加模型名')
    } finally {
      if (seq === upstreamFetchSeq.current) setLoadingUpstream(false)
    }
  }

  const toggleModel = (id: string, checked: boolean) => {
    setSelectedModels((prev) =>
      checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id),
    )
  }

  const selectAllVisible = () => {
    setSelectedModels((prev) => Array.from(new Set([...prev, ...visibleCustom, ...visibleUpstream])))
  }

  const addManualModel = () => {
    const id = manualModel.trim()
    if (!id) return
    if (selectedModels.includes(id)) {
      Message.info('该模型已在列表中')
      return
    }
    setSelectedModels((prev) => [...prev, id])
    setManualModel('')
  }

  // TTS 勾选即 voices 键的存在性：勾选创建（允许空数组），取消删除（有数据时二次确认）
  const toggleTtsModel = (id: string, checked: boolean) => {
    if (checked) {
      setModelVoices((prev) => (prev[id] ? prev : { ...prev, [id]: [] }))
      return
    }
    const count = modelVoices[id]?.length ?? 0
    const remove = () => {
      setModelVoices((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
    if (count > 0) {
      Modal.confirm({
        title: '取消 TTS 标记',
        content: `该模型已配置 ${count} 个音色，取消勾选将一并删除，确定？`,
        okText: '删除',
        cancelText: '取消',
        onOk: remove,
      })
    } else {
      remove()
    }
  }

  const openVoiceEditor = (id: string) => {
    setVoiceEditorModel(id)
    setVoiceDraftText(voicesToEditorText(modelVoices[id] ?? []))
  }

  // 编辑框用 TOML：一个音色一个小节，info 说明 + trial_url 试听地址（选填）；
  // 存储与 /v1/models 仍是 voices 数组（{voice, info, trial_url?}），trial_url 未配置就不下发。
  const voicesToEditorText = voicesToToml

  const saveVoiceEditor = () => {
    if (!voiceEditorModel) return
    const parsed = parseVoicesToml(voiceDraftText)
    if (typeof parsed === 'string') {
      Message.error(parsed)
      return
    }
    setModelVoices((prev) => ({ ...prev, [voiceEditorModel]: parsed }))
    setVoiceEditorModel(null)
  }

  const handleSaveModels = async () => {
    if (!managingChannel) return
    const ids = Array.from(new Set(selectedModels.map((s) => s.trim()).filter(Boolean)))
    setSavingModels(true)
    try {
      // 条目重建：标记了 TTS 的模型存 {id, voices}（空数组也保留标记），其余条目原样保留。
      // model_mapping 不在本弹窗触碰——别名只在编辑抽屉里增删。
      const entryById = new Map<string, string | Record<string, unknown>>()
      for (const e of originalEntries) {
        const eid =
          typeof e === 'string'
            ? e
            : String((e as { id?: unknown }).id ?? (e as { name?: unknown }).name ?? '')
        if (eid) entryById.set(eid, e)
      }
      const modelsPayload = ids.map((id) => {
        const original = entryById.get(id)
        if (!(id in modelVoices)) {
          return original ?? id
        }
        return {
          ...(original && typeof original === 'object' ? original : {}),
          id,
          voices: modelVoices[id].map(toStorageVoice),
        }
      })

      await updateChannel(managingChannel.id, {
        models: JSON.stringify(modelsPayload),
      })
      Message.success(`已保存 ${ids.length} 个模型`)
      setManagingChannel(null)
      fetchData()
    } catch {
      Message.error('保存失败')
    } finally {
      setSavingModels(false)
    }
  }

  const addMapping = () => {
    setMappings((prev) => [...prev, { from: '', to: '' }])
  }

  const updateMapping = (index: number, field: 'from' | 'to', value: string) => {
    setMappings((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], [field]: value }
      return next
    })
  }

  const removeMapping = (index: number) => {
    setMappings((prev) => prev.filter((_, i) => i !== index))
  }

  const columns: ColumnProps<Channel>[] = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 160,
      render: (name: string) => <span style={{ fontWeight: 700 }}>{name}</span>,
    },
    {
      title: 'Provider',
      dataIndex: 'provider',
      key: 'provider',
      width: 120,
      render: (provider: string) => (
        <Tag color={PROVIDER_COLORS[provider] ?? 'gray'}>{provider}</Tag>
      ),
    },
    {
      title: 'Base URL',
      dataIndex: 'base_url',
      key: 'base_url',
      width: 240,
      ellipsis: true,
      render: (url: string) => (
        <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--ag-outline)' }}>{url}</span>
      ),
    },
    {
      title: 'Weight',
      dataIndex: 'weight',
      key: 'weight',
      width: 80,
      align: 'center',
      render: (w: number) => <strong>{w}</strong>,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 90,
      align: 'center',
      render: (enabled: boolean) => (
        <Tag color={enabled ? 'green' : 'red'}>{enabled ? 'Enabled' : 'Disabled'}</Tag>
      ),
    },
    {
      title: '模型数',
      dataIndex: 'models',
      key: 'models',
      width: 80,
      align: 'center',
      render: (models: string | null, record: Channel) => {
        const count = parseModelsCount(models, record.model_mapping)
        return (
          <Tag
            color={count === 0 ? 'gray' : 'arcoblue'}
            style={{ cursor: 'pointer' }}
            onClick={() => openManageModels(record)}
          >
            {count}
          </Tag>
        )
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_: unknown, record: Channel) => (
        <Space>
          <Button size="small" type="text" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Button
            size="small"
            type="text"
            icon={<IconSettings />}
            onClick={() => openManageModels(record)}
          >
            管理模型
          </Button>
          <Popconfirm
            title="确定要删除此 Channel 吗？"
            onOk={() => handleDelete(record.id)}
            okText="删除"
            cancelText="取消"
          >
            <Button size="small" type="text" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className="ag-page ag-workbench-page">
      <div className="ag-page-header">
        <div>
          <p className="ag-page-eyebrow">Routing</p>
          <h1 className="ag-page-title">Channels</h1>
          <p className="ag-page-description">配置上游渠道、模型映射、权重与启用状态。</p>
        </div>
        <div className="ag-header-actions">
          <Button type="primary" icon={<IconPlus />} onClick={openCreate}>
            新建 Channel
          </Button>
        </div>
      </div>

      <div className="ag-data-panel ag-workbench-panel ag-table-panel">
        <div className="ag-panel-header">
          <div>
            <h2 className="ag-panel-title">渠道路由</h2>
            <p className="ag-panel-subtitle">维护上游 Provider、模型列表、权重和模型别名映射</p>
          </div>
        </div>

        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          data={data}
          pagination={{ pageSize: 20, showTotal: true }}
          scroll={{ x: true }}
        />
      </div>

      {/* 管理模型 Modal：上游候选勾选列表 + 搜索 + 手动添加 */}
      <Modal
        title={`${managingChannel?.name ?? ''} — 管理模型`}
        visible={!!managingChannel}
        onCancel={() => setManagingChannel(null)}
        footer={
          <Space>
            <Button onClick={() => setManagingChannel(null)}>取消</Button>
            <Button type="primary" loading={savingModels} onClick={handleSaveModels}>
              保存 ({selectedModels.length})
            </Button>
          </Space>
        }
        style={{ width: 640, maxWidth: '92vw' }}
      >
        {/* 搜索 + 手动添加（阿里云等无 /models 端点的渠道靠手动添加） */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Input
            style={{ flex: 1 }}
            allowClear
            prefix={<IconSearch />}
            placeholder="搜索模型…"
            value={modelSearch}
            onChange={setModelSearch}
          />
          <Input
            style={{ width: 220 }}
            allowClear
            placeholder="手动添加模型名，回车确认"
            value={manualModel}
            onChange={setManualModel}
            onPressEnter={addManualModel}
          />
          <Button icon={<IconPlus />} onClick={addManualModel} />
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 4,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {upstreamIds === null
              ? '正在从上游获取候选…'
              : `上游候选 ${upstreamList.length} · 显示 ${visibleCustom.length + visibleUpstream.length} · 已选 ${selectedModels.length}`}
          </Typography.Text>
          <Space size="small">
            <Button
              size="mini"
              type="text"
              disabled={visibleCustom.length + visibleUpstream.length === 0}
              onClick={selectAllVisible}
            >
              全选
            </Button>
            <Button
              size="mini"
              type="text"
              status="danger"
              disabled={selectedModels.length === 0}
              onClick={() => setSelectedModels([])}
            >
              清空勾选
            </Button>
            <Button
              size="mini"
              type="text"
              icon={<IconRefresh />}
              loading={loadingUpstream}
              onClick={() => managingChannel && loadUpstreamModels(managingChannel.id, true)}
            />
          </Space>
        </div>

        <div
          style={{
            border: '1px solid var(--color-border-2)',
            borderRadius: 4,
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          {upstreamIds === null && loadingUpstream ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
              <Spin />
            </div>
          ) : visibleCustom.length + visibleUpstream.length === 0 ? (
            <Typography.Text
              type="secondary"
              style={{ display: 'block', textAlign: 'center', padding: '32px 0', fontSize: 12 }}
            >
              {upstreamList.length === 0 && customIds.length === 0
                ? '上游无候选，可在上方手动添加模型名'
                : '无匹配模型'}
            </Typography.Text>
          ) : (
            <>
              {[...visibleCustom, ...visibleUpstream].map((id) => {
                const isCustom = customIds.includes(id)
                const isSelected = selectedModels.includes(id)
                const isTts = id in modelVoices
                const voiceCount = modelVoices[id]?.length ?? 0
                return (
                  <div
                    key={id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '5px 12px',
                      cursor: 'pointer',
                    }}
                    onClick={() => toggleModel(id, !isSelected)}
                  >
                    <Checkbox checked={isSelected} />
                    <span
                      style={{
                        flex: 1,
                        fontFamily: 'monospace',
                        fontSize: 12,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {id}
                    </span>
                    {mappingKeySet.has(id) && (
                      <Tag color="orange" style={{ fontSize: 11, marginBottom: 0 }}>
                        映射
                      </Tag>
                    )}
                    {isCustom && !mappingKeySet.has(id) && (
                      <Tag color="gray" style={{ fontSize: 11, marginBottom: 0 }}>
                        手动
                      </Tag>
                    )}
                    {isSelected && (
                      <span
                        style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox checked={isTts} onChange={(checked) => toggleTtsModel(id, checked)} />
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          TTS
                        </Typography.Text>
                        {isTts && (
                          <>
                            <Tag color={voiceCount > 0 ? 'green' : 'gray'} style={{ fontSize: 11, marginBottom: 0 }}>
                              {voiceCount > 0 ? `音色 ×${voiceCount}` : '未配音色'}
                            </Tag>
                            <Button size="mini" type="text" onClick={() => openVoiceEditor(id)}>
                              配置
                            </Button>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
      </Modal>

      {/* 音色编辑二级弹窗 */}
      <Modal
        title={`${voiceEditorModel ?? ''} — 音色配置`}
        visible={!!voiceEditorModel}
        onCancel={() => setVoiceEditorModel(null)}
        footer={
          <Space>
            <Button onClick={() => setVoiceEditorModel(null)}>取消</Button>
            <Button type="primary" onClick={saveVoiceEditor}>
              确定
            </Button>
          </Space>
        }
        style={{ width: 600, maxWidth: '92vw' }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          每个音色一个小节，小节名为音色名（以渠道上游文档为准，需完整格式，如 FunAudioLLM/CosyVoice2-0.5B:anna）。
          info 为说明（选填）；trial_url 为试听音频地址（选填，不填则不返回给客户端）。
          整体随 /v1/models 的 voices 字段透传给下游；只写小节头表示标记为 TTS 但暂不下发音色。
        </Typography.Text>
        <Input.TextArea
          value={voiceDraftText}
          onChange={setVoiceDraftText}
          rows={12}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
          placeholder={
            '["FunAudioLLM/CosyVoice2-0.5B:anna"]\ninfo = "沉稳知性女声（女性）"\ntrial_url = "https://example.com/anna.mp3"\n\n["FunAudioLLM/CosyVoice2-0.5B:bella"]\ninfo = "甜美活泼女声（女性）"'
          }
        />
      </Modal>

      <Drawer
        title={editingChannel ? '编辑 Channel' : '新建 Channel'}
        visible={drawerVisible}
        width={520}
        onCancel={() => setDrawerVisible(false)}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setDrawerVisible(false)}>取消</Button>
              <Button type="primary" loading={submitting} onClick={handleSubmit}>
                保存
              </Button>
            </Space>
          </div>
        }
        unmountOnExit
      >
        <Form form={form} layout="vertical" autoComplete="off">
          <FormItem
            label="名称"
            field="name"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="Channel 名称" />
          </FormItem>

          <FormItem
            label="Provider"
            field="provider"
            rules={[{ required: true, message: '请选择 Provider' }]}
          >
            <Select options={PROVIDER_OPTIONS} placeholder="选择 Provider" />
          </FormItem>

          <FormItem
            label="Base URL"
            field="base_url"
            rules={[{ required: true, message: '请输入 Base URL' }]}
          >
            <Input placeholder="https://api.openai.com/v1" />
          </FormItem>

          <FormItem
            label="API Key"
            field="api_key"
            rules={
              editingChannel
                ? []
                : [{ required: true, message: '请输入 API Key' }]
            }
            extra={editingChannel ? '留空则保留原有 API Key' : undefined}
          >
            <Input.Password
              placeholder={editingChannel ? '（留空保持不变）' : '请输入 API Key'}
            />
          </FormItem>

          <Row gutter={16}>
            <Col span={12}>
              <FormItem label="Weight" field="weight">
                <InputNumber min={0} step={1} style={{ width: '100%' }} />
              </FormItem>
            </Col>
            <Col span={12}>
              <FormItem label="启用" field="enabled" triggerPropName="checked">
                <Switch />
              </FormItem>
            </Col>
          </Row>

          <FormItem
            label="代理地址 (Proxy URL)"
            field="proxy_url"
            extra="留空则不走渠道级代理；填写后该渠道请求强制经此代理，如 http://127.0.0.1:7890"
          >
            <Input placeholder="http://127.0.0.1:7890（可选）" allowClear />
          </FormItem>

          <Row gutter={16}>
            <Col span={12}>
              <FormItem
                label="禁用 SSL 校验"
                field="disable_ssl"
                triggerPropName="checked"
                extra="跳过该渠道上游证书校验"
              >
                <Switch />
              </FormItem>
            </Col>
            <Col span={12}>
              <FormItem
                label="禁用压缩"
                field="disable_compression"
                triggerPropName="checked"
                extra="兼容压缩却不回传 Content-Encoding 的上游，开启后强制 identity"
              >
                <Switch />
              </FormItem>
            </Col>
          </Row>

          <FormItem
            label="上游协议"
            field="protocol"
            extra="wss 表示该渠道是 WebSocket 上游（用于 DashScope 实时 ASR 等场景）"
          >
            <Radio.Group>
              <Radio value="http">HTTP</Radio>
              <Radio value="wss">WSS（WebSocket）</Radio>
            </Radio.Group>
          </FormItem>

          {/* WS-only fields：仅当 protocol=wss 时显示（Arco 函数 children 签名：(formData, form)） */}
          <FormItem shouldUpdate={(prev, next) => prev.protocol !== next.protocol} noStyle>
            {(formData) =>
              formData?.protocol === 'wss' ? (
                <>
                  <FormItem
                    label="WSS 路径"
                    field="ws_path"
                    extra="上游 WebSocket 路径，如 /api-ws/v1/inference（默认阿里 DashScope 实时 ASR 端点）"
                  >
                    <Input placeholder="/api-ws/v1/inference（可选，留空使用默认值）" allowClear />
                  </FormItem>
                  <FormItem
                    label="WSS 子协议"
                    field="ws_subprotocols"
                    extra="可选，JSON 数组字符串，如 [&quot;binary&quot;]"
                  >
                    <Input placeholder='["binary"]（可选）' allowClear />
                  </FormItem>
                </>
              ) : null
            }
          </FormItem>

          {/* model_mapping 编辑器 */}
          <div style={{ marginBottom: 8 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <Typography.Text style={{ fontWeight: 500 }}>Model Mapping</Typography.Text>
              <Button
                size="small"
                type="dashed"
                icon={<IconPlus />}
                onClick={addMapping}
              >
                添加映射
              </Button>
            </div>

            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
              客户端请求的模型名 → 实际发给上游的模型名（两端名称一致时无需配置）
            </Typography.Text>

            {mappings.length === 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                无映射规则，点击"添加映射"来配置模型名称转换
              </Typography.Text>
            )}

            {mappings.map((mapping, index) => (
              <Row key={index} gutter={8} style={{ marginBottom: 8 }} align="center">
                <Col flex={1}>
                  <Input
                    placeholder="from（客户端请求的模型名）"
                    value={mapping.from}
                    onChange={(v) => updateMapping(index, 'from', v)}
                  />
                </Col>
                <Col style={{ padding: '0 4px', color: '#999' }}>→</Col>
                <Col flex={1}>
                  <Input
                    placeholder="to（发给上游的模型名）"
                    value={mapping.to}
                    onChange={(v) => updateMapping(index, 'to', v)}
                  />
                </Col>
                <Col>
                  <Button
                    size="small"
                    type="text"
                    status="danger"
                    icon={<IconDelete />}
                    onClick={() => removeMapping(index)}
                  />
                </Col>
              </Row>
            ))}
          </div>
        </Form>
      </Drawer>
    </div>
  )
}

export default Channels
