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
}

const PROVIDER_OPTIONS = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'Gemini', value: 'gemini' },
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
  const mappingCount = parseMappingKeys(model_mapping).length
  let modelsCount = 0
  try {
    modelsCount = JSON.parse(models || '[]').length
  } catch {
    // noop
  }
  return mappingCount + modelsCount
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
    form.setFieldsValue({ weight: 1, enabled: true, provider: 'openai', disable_ssl: false, disable_compression: false })
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
    setSelectedModels(parseModelIds(channel.models, channel.model_mapping))
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

  const handleSaveModels = async () => {
    if (!managingChannel) return
    const ids = Array.from(new Set(selectedModels.map((s) => s.trim()).filter(Boolean)))
    setSavingModels(true)
    try {
      // 同步清理 model_mapping 中已不在选中集内的 key（沿用原删除语义）
      let mappingObj: Record<string, string> = {}
      try {
        mappingObj = JSON.parse(managingChannel.model_mapping || '{}')
      } catch {
        // noop
      }
      parseMappingKeys(managingChannel.model_mapping).forEach((key) => {
        if (!ids.includes(key)) delete mappingObj[key]
      })

      await updateChannel(managingChannel.id, {
        models: JSON.stringify(ids),
        model_mapping: JSON.stringify(mappingObj),
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
                    onClick={() => toggleModel(id, !selectedModels.includes(id))}
                  >
                    <Checkbox checked={selectedModels.includes(id)} />
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
                  </div>
                )
              })}
            </>
          )}
        </div>
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

            {mappings.length === 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                无映射规则，点击"添加映射"来配置模型名称转换
              </Typography.Text>
            )}

            {mappings.map((mapping, index) => (
              <Row key={index} gutter={8} style={{ marginBottom: 8 }} align="center">
                <Col flex={1}>
                  <Input
                    placeholder="from（原模型名）"
                    value={mapping.from}
                    onChange={(v) => updateMapping(index, 'from', v)}
                  />
                </Col>
                <Col style={{ padding: '0 4px', color: '#999' }}>→</Col>
                <Col flex={1}>
                  <Input
                    placeholder="to（目标模型名）"
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
