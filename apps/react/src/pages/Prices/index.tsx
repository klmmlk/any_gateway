import React, { useState, useEffect, useCallback } from 'react'
import {
  Table, Button, Modal, Form, Input, InputNumber,
  Radio, Popconfirm, Message, Space, Tag, Select,
} from '@arco-design/web-react'
import { IconPlus } from '@arco-design/web-react/icon'
import { getPrices, createPrice, updatePrice, deletePrice } from '../../api/prices'
import { getChannels } from '../../api/channels'

interface PriceRow {
  id: string
  model_name: string
  unit: string
  price_per_unit: number
  context_length?: number
  vendor?: string
  stability?: string
}

interface ModelGroup {
  model_name: string
  vendor?: string
  context_length?: number
  stability?: string
  input_token?: number
  output_token?: number
  cache_read_token?: number
  cache_write_token?: number
  extra_context_token?: number
  request?: number
  /** ASR 类按音频时长（秒）计费的单价（USD/秒）。 */
  audio_second?: number
  /** TTS 类按字符计费的单价（USD/百万字符）。 */
  character?: number
  rows: PriceRow[]
}

function groupByModel(data: PriceRow[]): ModelGroup[] {
  const map = new Map<string, ModelGroup>()
  for (const row of data) {
    let g = map.get(row.model_name)
    if (!g) {
      g = { model_name: row.model_name, rows: [] }
      map.set(row.model_name, g)
    }
    g.rows.push(row)
    if (row.vendor) g.vendor = row.vendor
    if (row.context_length) g.context_length = row.context_length
    if (row.stability) g.stability = row.stability
    const unit = row.unit as keyof ModelGroup
    if (['input_token', 'output_token', 'cache_read_token', 'cache_write_token', 'extra_context_token', 'request', 'audio_second', 'character'].includes(row.unit)) {
      ;(g as any)[unit] = row.price_per_unit
    }
  }
  return Array.from(map.values()).sort((a, b) => a.model_name.localeCompare(b.model_name))
}

function formatCtx(n?: number) {
  if (!n) return '-'
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

function formatPrice(v?: number) {
  if (v == null) return '-'
  return `$${v.toFixed(2)}`
}

const VENDOR_OPTIONS = ['DeepSeek', 'Anthropic', 'OpenAI', 'Google', 'Alibaba', 'Volcengine', 'Zhipu AI', 'Other']

// 计价模式 → 该模式下的 unit 集合；一个模型只保留一种模式，
// 切换模式时删除其他模式的价目行（calculate_cost 按 request > audio_second > character > token 取优先级，残留旧行会错账）
type PriceMode = 'token' | 'request' | 'audio_second' | 'character'
const MODE_UNITS: Record<PriceMode, string[]> = {
  token: ['input_token', 'output_token', 'cache_read_token', 'cache_write_token', 'extra_context_token'],
  request: ['request'],
  audio_second: ['audio_second'],
  character: ['character'],
}

const Prices: React.FC = () => {
  const [data, setData] = useState<PriceRow[]>([])
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(false)
  const [editing, setEditing] = useState<ModelGroup | null>(null)
  const [priceMode, setPriceMode] = useState<PriceMode>('token')
  // 模型名候选：从渠道已配置的模型（含映射别名）拉取，也允许手输尚未建渠道的模型
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [form] = Form.useForm()
  const [searchText, setSearchText] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getPrices()
      const raw = res.data?.data ?? res.data
      setData(Array.isArray(raw) ? raw : [])
    } catch {
      Message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  useEffect(() => {
    getChannels()
      .then((res) => {
        const raw = res.data?.data ?? res.data ?? []
        const names = new Set<string>()
        for (const ch of raw) {
          try {
            for (const m of JSON.parse(ch.models || '[]')) {
              if (typeof m === 'string') names.add(m)
              else if (m && typeof m === 'object' && m.id) names.add(String(m.id))
            }
          } catch { /* noop */ }
          try {
            for (const alias of Object.keys(JSON.parse(ch.model_mapping || '{}'))) names.add(alias)
          } catch { /* noop */ }
        }
        setModelOptions(Array.from(names).sort())
      })
      .catch(() => { /* 候选拉取失败不阻塞表单，仍可手输 */ })
  }, [])

  const groups = groupByModel(data)
  const filtered = searchText
    ? groups.filter(g => g.model_name.toLowerCase().includes(searchText.toLowerCase()))
    : groups

  const handleOpen = (group?: ModelGroup) => {
    setEditing(group || null)
    if (group) {
      // 模式从已有行推断，与 calculate_cost 的优先级一致：request > audio_second > character > token
      const hasUnit = (u: string) => group.rows.some((r) => r.unit === u)
      const mode: PriceMode = hasUnit('request')
        ? 'request'
        : hasUnit('audio_second')
          ? 'audio_second'
          : hasUnit('character')
            ? 'character'
            : 'token'
      setPriceMode(mode)
      form.setFieldsValue({
        model_name: group.model_name,
        vendor: group.vendor || undefined,
        context_length: group.context_length || undefined,
        stability: group.stability || undefined,
        input_price: group.input_token,
        output_price: group.output_token,
        cache_read_price: group.cache_read_token,
        cache_write_price: group.cache_write_token,
        extra_context_price: group.extra_context_token,
        request_price: group.request,
        audio_price: group.audio_second,
        char_price: group.character,
      })
    } else {
      setPriceMode('token')
      form.resetFields()
    }
    setVisible(true)
  }

  const handleSubmit = async (values: any) => {
    try {
      const meta = {
        context_length: values.context_length || undefined,
        vendor: values.vendor || undefined,
        stability: values.stability || undefined,
      }
      // 当前模式的字段 → unit 价格
      const modePrices: Record<PriceMode, Record<string, number | undefined>> = {
        token: {
          input_token: values.input_price,
          output_token: values.output_price,
          cache_read_token: values.cache_read_price,
          cache_write_token: values.cache_write_price,
          extra_context_token: values.extra_context_price,
        },
        request: { request: values.request_price },
        audio_second: { audio_second: values.audio_price },
        character: { character: values.char_price },
      }

      if (editing) {
        // 切换模式时删除其他模式的价目行，保证一个模型只有一种计费模式
        const staleUnits = new Set(
          Object.values(MODE_UNITS).flat().filter((u) => !MODE_UNITS[priceMode].includes(u)),
        )
        for (const row of editing.rows) {
          if (staleUnits.has(row.unit)) {
            await deletePrice(row.id)
          }
        }
        // 当前模式：已有行更新价格，缺的行按填写值补建
        const rowsByUnit = new Map(editing.rows.map((r) => [r.unit, r]))
        for (const [unit, price] of Object.entries(modePrices[priceMode])) {
          const existing = rowsByUnit.get(unit)
          if (existing) {
            await updatePrice(existing.id, { price_per_unit: price ?? existing.price_per_unit, ...meta })
          } else if (price != null && price > 0) {
            await createPrice({ model_name: editing.model_name, unit, price_per_unit: price, ...meta })
          }
        }
        Message.success('已更新')
      } else {
        const creates: Array<{ unit: string; price: number }> = []
        for (const [unit, price] of Object.entries(modePrices[priceMode])) {
          if (price != null && price > 0) creates.push({ unit, price })
        }
        if (creates.length === 0) {
          Message.warning('请至少填写一项单价')
          return
        }
        await Promise.all(
          creates.map((c) => createPrice({
            model_name: values.model_name,
            unit: c.unit,
            price_per_unit: c.price,
            ...meta,
          })),
        )
        Message.success('已创建')
      }
      setVisible(false)
      fetchData()
    } catch {
      Message.error('操作失败')
    }
  }

  const handleDeleteModel = async (group: ModelGroup) => {
    try {
      await Promise.all(group.rows.map(r => deletePrice(r.id)))
      Message.success('已删除')
      fetchData()
    } catch {
      Message.error('删除失败')
    }
  }

  const columns = [
    {
      title: '模型名称',
      dataIndex: 'model_name',
      width: 200,
      render: (v: string) => <span style={{ fontWeight: 700 }}>{v}</span>,
    },
    {
      title: '来源',
      dataIndex: 'vendor',
      width: 110,
      render: (v?: string) => v ? <Tag color="arcoblue">{v}</Tag> : <span style={{ color: '#c0c0c0' }}>-</span>,
    },
    {
      title: '上下文',
      dataIndex: 'context_length',
      width: 90,
      render: (v?: number) => <span style={{ fontFamily: 'monospace' }}>{formatCtx(v)}</span>,
    },
    {
      title: '输入 (/1M)',
      dataIndex: 'input_token',
      width: 110,
      render: (v?: number) => <strong style={{ fontFamily: 'monospace', fontSize: 12 }}>{formatPrice(v)}</strong>,
    },
    {
      title: '输出 (/1M)',
      dataIndex: 'output_token',
      width: 110,
      render: (v?: number) => <strong style={{ fontFamily: 'monospace', fontSize: 12 }}>{formatPrice(v)}</strong>,
    },
    {
      title: '缓存读 (/1M)',
      dataIndex: 'cache_read_token',
      width: 110,
      render: (v?: number) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{formatPrice(v)}</span>,
    },
    {
      title: '缓存写 (/1M)',
      dataIndex: 'cache_write_token',
      width: 110,
      render: (v?: number) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{formatPrice(v)}</span>,
    },
    {
      title: '音频秒 (USD/s)',
      dataIndex: 'audio_second',
      width: 130,
      render: (v?: number) => v != null
        ? <Tag color="orange"><span style={{ fontFamily: 'monospace' }}>${v.toFixed(4)}</span></Tag>
        : <span style={{ color: '#c0c0c0' }}>-</span>,
    },
    {
      title: '字符 (/1M)',
      dataIndex: 'character',
      width: 110,
      render: (v?: number) => v != null
        ? <Tag color="purple"><span style={{ fontFamily: 'monospace' }}>${v.toFixed(4)}</span></Tag>
        : <span style={{ color: '#c0c0c0' }}>-</span>,
    },
    {
      title: '稳定性',
      dataIndex: 'stability',
      width: 90,
      render: (v?: string) => {
        if (!v) return <span style={{ color: '#c0c0c0' }}>-</span>
        const colorMap: Record<string, string> = {
          '稳定': 'green', 'stable': 'green',
          'beta': 'orange', 'Beta': 'orange', '测试': 'orange',
          '下线': 'red', 'deprecated': 'red',
        }
        return <Tag color={colorMap[v] || 'gray'}>{v}</Tag>
      },
    },
    {
      title: '操作',
      width: 120,
      render: (_: any, row: ModelGroup) => (
        <Space>
          <Button size="mini" type="text" onClick={() => handleOpen(row)}>编辑</Button>
          <Popconfirm title={`删除 ${row.model_name} 的所有价格？`} onOk={() => handleDeleteModel(row)}>
            <Button size="mini" type="text" status="danger">删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className="ag-page ag-workbench-page">
      <div className="ag-page-header">
        <div>
          <p className="ag-page-eyebrow">Billing</p>
          <h1 className="ag-page-title">Prices</h1>
          <p className="ag-page-description">配置模型与请求计价，影响成本统计与扣费计算。</p>
        </div>
        <Space className="ag-header-actions">
          <Input
            placeholder="搜索模型名"
            value={searchText}
            onChange={setSearchText}
            allowClear
            style={{ width: 200 }}
          />
          <Button type="primary" icon={<IconPlus />} onClick={() => handleOpen()}>新增模型</Button>
        </Space>
      </div>

      <div className="ag-data-panel ag-workbench-panel ag-table-panel">
        <div className="ag-panel-header">
          <div>
            <h2 className="ag-panel-title">价格配置</h2>
            <p className="ag-panel-subtitle">每行代表一个模型，展示各维度价格</p>
          </div>
        </div>

        <Table
          columns={columns}
          data={filtered}
          loading={loading}
          rowKey="model_name"
          scroll={{ x: 1100 }}
          pagination={{ pageSize: 20, showTotal: true }}
        />
      </div>

      <Modal
        title={editing ? `编辑 ${editing.model_name}` : '新增模型价格'}
        visible={visible}
        onCancel={() => setVisible(false)}
        onOk={() => form.submit()}
        unmountOnExit
        style={{ width: 520 }}
      >
        <Form form={form} onSubmit={handleSubmit} layout="vertical">
          <Form.Item label="计价模式" extra="一个模型只按一种模式计费；编辑时切换模式会清除其他模式的单价">
            <Radio.Group
              value={priceMode}
              onChange={(v: PriceMode) => setPriceMode(v)}
            >
              <Radio value="token">按 Token</Radio>
              <Radio value="request">按请求次数</Radio>
              <Radio value="audio_second">按音频秒</Radio>
              <Radio value="character">按字符</Radio>
            </Radio.Group>
          </Form.Item>

          {!editing && (
            <Form.Item
              field="model_name"
              label="模型名称"
              rules={[{ required: true }]}
            >
              <Select
                placeholder="从已配置模型中选择，或输入新名称"
                allowCreate
                allowClear
                showSearch
              >
                {modelOptions.map((m) => (
                  <Select.Option key={m} value={m}>{m}</Select.Option>
                ))}
              </Select>
            </Form.Item>
          )}

          <Form.Item field="vendor" label="模型来源">
            <Select placeholder="选择或输入" allowCreate allowClear>
              {VENDOR_OPTIONS.map(v => (
                <Select.Option key={v} value={v}>{v}</Select.Option>
              ))}
            </Select>
          </Form.Item>

          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item field="context_length" label="上下文长度" style={{ flex: 1 }}>
              <InputNumber min={0} step={1000} placeholder="如 128000" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item field="stability" label="稳定性" style={{ flex: 1 }}>
              <Input placeholder="如 稳定、Beta、测试" />
            </Form.Item>
          </div>

          {priceMode === 'token' && (
            <>
              <div style={{ display: 'flex', gap: 12 }}>
                <Form.Item field="input_price" label="输入 (/1M USD)" rules={editing ? [] : [{ required: true }]} style={{ flex: 1 }}>
                  <InputNumber min={0} step={0.01} precision={6} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item field="output_price" label="输出 (/1M USD)" rules={editing ? [] : [{ required: true }]} style={{ flex: 1 }}>
                  <InputNumber min={0} step={0.01} precision={6} style={{ width: '100%' }} />
                </Form.Item>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <Form.Item field="cache_read_price" label="缓存读 (/1M)" style={{ flex: 1 }}>
                  <InputNumber min={0} step={0.01} precision={6} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item field="cache_write_price" label="缓存写 (/1M)" style={{ flex: 1 }}>
                  <InputNumber min={0} step={0.01} precision={6} style={{ width: '100%' }} />
                </Form.Item>
              </div>
              <Form.Item field="extra_context_price" label="Extra Context (/1M，选填)">
                <InputNumber min={0} step={0.01} precision={6} style={{ width: '100%' }} />
              </Form.Item>
            </>
          )}

          {priceMode === 'request' && (
            <Form.Item field="request_price" label="每次请求单价 (USD)" rules={[{ required: true }]}>
              <InputNumber min={0} step={0.001} precision={6} style={{ width: '100%' }} />
            </Form.Item>
          )}

          {priceMode === 'audio_second' && (
            <Form.Item
              field="audio_price"
              label="音频秒单价 (USD/秒)"
              rules={[{ required: true }]}
              extra="ASR 实时语音识别按音频时长计费（客户端声明或墙钟时长）"
            >
              <InputNumber min={0} step={0.0001} precision={6} style={{ width: '100%' }} />
            </Form.Item>
          )}

          {priceMode === 'character' && (
            <Form.Item
              field="char_price"
              label="字符单价 (USD/百万字符)"
              rules={[{ required: true }]}
              extra="TTS 语音合成按字符计费（用量取自上游任务结束帧 usage）"
            >
              <InputNumber min={0} step={0.01} precision={6} style={{ width: '100%' }} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  )
}

export default Prices
