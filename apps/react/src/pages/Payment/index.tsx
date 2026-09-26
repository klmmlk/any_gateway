import React, { useState, useEffect, useCallback } from 'react'
import {
  Table, Button, Modal, Form, Input, InputNumber, Switch, Tabs,
  Popconfirm, Message, Typography, Tag, Select, Checkbox,
} from '@arco-design/web-react'
import { IconPlus, IconRefresh, IconSave } from '@arco-design/web-react/icon'
import {
  getPaymentSettings, updatePaymentSettings,
  getPaymentPackages, createPaymentPackage, updatePaymentPackage, deletePaymentPackage,
  getPaymentOrders, markPaymentOrderPaid,
} from '../../api/payments'
import type { PaymentPackage, PaymentPackagePayload } from '../../api/payments'
import { getGroups } from '../../api/groups'

const { TabPane } = Tabs
const FormItem = Form.Item

const CHANNEL_OPTIONS = [
  { label: '微信', value: 'wechat' },
  { label: '支付宝', value: 'alipay' },
]
const CHANNEL_LABEL: Record<string, string> = { wechat: '微信', alipay: '支付宝' }
const ORDER_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: '待支付', color: 'orange' },
  paid: { label: '已支付', color: 'green' },
  expired: { label: '已过期', color: 'gray' },
  failed: { label: '支付异常', color: 'red' },
}

const fmtYuan = (cents: number | null | undefined) =>
  cents != null ? `¥${(cents / 100).toFixed(2)}` : '—'
const fmtTime = (s: string | null | undefined) =>
  s ? s.slice(0, 16).replace('T', ' ') : '—'

function useGroups() {
  const [groups, setGroups] = useState<any[]>([])
  useEffect(() => {
    getGroups()
      .then((res) => {
        const raw = res.data?.data ?? res.data
        setGroups(Array.isArray(raw) ? raw : [])
      })
      .catch(() => { /* 组列表加载失败时仅影响展示，不阻塞页面 */ })
  }, [])
  const groupName = useCallback(
    (id: string | null | undefined) => {
      if (!id) return 'default'
      return groups.find((g) => g.id === id)?.name ?? id.slice(0, 8)
    },
    [groups],
  )
  return { groups, groupName }
}

// ========================
// Tab 1：渠道配置
// ========================
const SettingsTab: React.FC = () => {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publicBase, setPublicBase] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getPaymentSettings()
      const s = res.data?.data ?? res.data
      form.setFieldsValue({
        enabled: !!s?.enabled,
        gateway_base_url: s?.gateway_base_url ?? '',
        public_base_url: s?.public_base_url ?? '',
        enabled_channels: s?.enabled_channels_list ?? [],
        api_key: '',
        callback_secret: '',
      })
      setPublicBase(s?.public_base_url ?? '')
    } catch {
      Message.error('加载支付配置失败')
    } finally {
      setLoading(false)
    }
  }, [form])

  useEffect(() => { fetchData() }, [fetchData])

  const handleSubmit = async (values: Record<string, any>) => {
    setSaving(true)
    try {
      const payload: Record<string, any> = {
        enabled: !!values.enabled,
        gateway_base_url: (values.gateway_base_url ?? '').trim(),
        public_base_url: (values.public_base_url ?? '').trim(),
        enabled_channels: values.enabled_channels ?? [],
      }
      // 密钥留空 = 保持原值（后端约定）
      if (values.api_key) payload.api_key = values.api_key.trim()
      if (values.callback_secret) payload.callback_secret = values.callback_secret.trim()
      await updatePaymentSettings(payload)
      Message.success('支付配置已保存')
      form.setFieldsValue({ api_key: '', callback_secret: '' })
    } catch {
      Message.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const notifyPreview = publicBase ? `${publicBase.replace(/\/+$/, '')}/payment/notify` : '（未配置）'

  return (
    <div className="ag-data-panel ag-table-panel">
      <div className="ag-panel-header">
        <div>
          <h2 className="ag-panel-title">支付渠道配置</h2>
          <p className="ag-panel-subtitle">对接聚合支付网关：下单 API Key 与回调验签密钥</p>
        </div>
        <Button icon={<IconRefresh />} onClick={fetchData} loading={loading}>
          刷新
        </Button>
      </div>
      <Form
        form={form}
        onSubmit={handleSubmit}
        layout="vertical"
        style={{ maxWidth: 640, padding: '0 4px' }}
      >
        <FormItem label="启用支付" field="enabled" triggerPropName="checked" extra="关闭后所有下单接口返回 400">
          <Switch />
        </FormItem>
        <FormItem
          label="网关地址"
          field="gateway_base_url"
          extra="聚合支付网关的 base url，创建订单时调用 {地址}/api/v1/orders"
          rules={[{ required: true, message: '请输入网关地址' }]}
        >
          <Input placeholder="https://pay.jokerin.icu" allowClear />
        </FormItem>
        <FormItem
          label="API Key"
          field="api_key"
          extra={<>请求头 X-API-Key；<b>留空则保留原有 Key</b></>}
        >
          <Input.Password placeholder="（留空保持不变）" />
        </FormItem>
        <FormItem
          label="回调验签密钥 (Callback Secret)"
          field="callback_secret"
          extra={<>用于校验回调 X-Signature（HMAC-SHA256）；<b>留空则保留原有密钥</b></>}
        >
          <Input.Password placeholder="（留空保持不变）" />
        </FormItem>
        <FormItem
          label="站点公网地址"
          field="public_base_url"
          extra={`回调地址 = 公网地址 + /payment/notify（必须是支付网关可访问的 https 公网地址）：${notifyPreview}`}
          rules={[{ required: true, message: '请输入站点公网地址' }]}
        >
          <Input
            placeholder="https://your-gateway.example.com"
            allowClear
            onChange={(v) => setPublicBase(v)}
          />
        </FormItem>
        <FormItem label="启用的支付方式" field="enabled_channels">
          <Checkbox.Group options={CHANNEL_OPTIONS} />
        </FormItem>
        <div style={{ marginTop: 8 }}>
          <Button type="primary" htmlType="submit" icon={<IconSave />} loading={saving}>
            保存配置
          </Button>
        </div>
      </Form>
    </div>
  )
}

// ========================
// Tab 2：套餐管理
// ========================
const PackagesTab: React.FC = () => {
  const [data, setData] = useState<PaymentPackage[]>([])
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [editing, setEditing] = useState<PaymentPackage | null>(null)
  const [form] = Form.useForm()
  const { groups, groupName } = useGroups()

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getPaymentPackages()
      const raw = res.data?.data ?? res.data
      setData(Array.isArray(raw) ? raw : [])
    } catch {
      Message.error('加载套餐失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ enabled: true, sort_order: 0 })
    setVisible(true)
  }

  const openEdit = (row: PaymentPackage) => {
    setEditing(row)
    form.resetFields()
    form.setFieldsValue({
      label: row.label,
      amount_yuan: row.amount_cny_cents / 100,
      credit_usd: row.credit_usd,
      duration_days: row.duration_days,
      group_id: row.group_id,
      sort_order: row.sort_order,
      enabled: row.enabled,
    })
    setVisible(true)
  }

  const handleSubmit = async (values: Record<string, any>) => {
    setSubmitting(true)
    try {
      const payload: PaymentPackagePayload = {
        label: values.label,
        amount_cny_cents: Math.round((values.amount_yuan ?? 0) * 100),
        credit_usd: values.credit_usd ?? 0,
        duration_days: values.duration_days ?? null,
        group_id: values.group_id ?? null,
        sort_order: values.sort_order ?? 0,
        enabled: values.enabled ?? true,
      }
      if (editing) {
        await updatePaymentPackage(editing.id, payload)
        Message.success('套餐已更新')
      } else {
        await createPaymentPackage(payload)
        Message.success('套餐已创建')
      }
      setVisible(false)
      fetchData()
    } catch {
      Message.error(editing ? '更新失败' : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggle = async (row: PaymentPackage, checked: boolean) => {
    try {
      await updatePaymentPackage(row.id, { enabled: checked })
      fetchData()
    } catch {
      Message.error('操作失败')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deletePaymentPackage(id)
      Message.success('已删除')
      fetchData()
    } catch {
      Message.error('删除失败')
    }
  }

  const columns = [
    {
      title: '名称',
      dataIndex: 'label',
      render: (v: string) => <strong>{v}</strong>,
    },
    {
      title: '支付金额',
      dataIndex: 'amount_cny_cents',
      render: (v: number) => (
        <strong style={{ fontFamily: 'monospace', color: 'rgb(var(--orange-6))' }}>
          {fmtYuan(v)}
        </strong>
      ),
    },
    {
      title: 'Key 额度',
      dataIndex: 'credit_usd',
      render: (v: number) => (
        <strong style={{ fontFamily: 'monospace' }}>
          {v === 0 ? '∞' : `$${v.toFixed(2)}`}
        </strong>
      ),
    },
    {
      title: 'Key 有效期',
      dataIndex: 'duration_days',
      render: (v: number | null) =>
        v ? <Tag color="arcoblue">{v} 天</Tag> : <span style={{ color: 'var(--ag-outline)' }}>不限时</span>,
    },
    {
      title: '分组',
      dataIndex: 'group_id',
      render: (v: string | null) =>
        v ? <Tag color="cyan">{groupName(v)}</Tag> : <span style={{ color: 'var(--ag-outline)' }}>default</span>,
    },
    { title: '排序', dataIndex: 'sort_order' },
    {
      title: '上架',
      dataIndex: 'enabled',
      render: (v: boolean, row: PaymentPackage) => (
        <Switch size="small" checked={v} onChange={(checked) => handleToggle(row, checked)} />
      ),
    },
    {
      title: '操作',
      render: (_: any, row: PaymentPackage) => (
        <>
          <Button size="mini" type="text" onClick={() => openEdit(row)}>编辑</Button>
          <Popconfirm title="确认删除此套餐？已有订单不受影响" onOk={() => handleDelete(row.id)}>
            <Button size="mini" type="text" status="danger">删除</Button>
          </Popconfirm>
        </>
      ),
    },
  ]

  return (
    <div className="ag-data-panel ag-table-panel">
      <div className="ag-panel-header">
        <div>
          <h2 className="ag-panel-title">套餐列表</h2>
          <p className="ag-panel-subtitle">用户支付套餐金额，支付成功后自动发放对应额度的 API key</p>
        </div>
        <Button type="primary" icon={<IconPlus />} onClick={openCreate}>
          新建套餐
        </Button>
      </div>
      <Table columns={columns} data={data} loading={loading} rowKey="id" pagination={false} />
      <Modal
        title={editing ? '编辑套餐' : '新建套餐'}
        visible={visible}
        onCancel={() => setVisible(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        unmountOnExit
      >
        <Form form={form} onSubmit={handleSubmit} layout="vertical">
          <FormItem label="套餐名称" field="label" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：入门包 / 周卡 / 月卡" allowClear />
          </FormItem>
          <Form.Item label="支付金额（元）" field="amount_yuan" rules={[{ required: true, message: '请输入金额' }]}>
            <InputNumber min={0.01} step={1} precision={2} style={{ width: '100%' }} placeholder="如 9.9" />
          </Form.Item>
          <Form.Item
            label="Key 额度 (USD)"
            field="credit_usd"
            extra="支付成功后发放 key 的用量额度；0 = 无限额度（配合有效期使用）"
            rules={[{ required: true, message: '请输入额度' }]}
          >
            <InputNumber min={0} step={1} precision={2} style={{ width: '100%' }} placeholder="如 1 / 5 / 20" />
          </Form.Item>
          <Form.Item label="Key 有效天数（选填）" field="duration_days" extra="不填则发放的 key 不限时，仅受额度约束">
            <InputNumber min={1} max={3650} precision={0} style={{ width: '100%' }} placeholder="如 7 / 30 / 365" />
          </Form.Item>
          <Form.Item
            label="绑定用户组（选填）"
            field="group_id"
            extra="发放的 key 将加入该分组（决定可用渠道、限流与计价倍率）；不填则加入 default 组"
          >
            <Select
              allowClear
              placeholder="default（默认）"
              options={groups.map((g) => ({ label: g.name, value: g.id }))}
            />
          </Form.Item>
          <Form.Item label="排序（小者在前）" field="sort_order" initialValue={0}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <FormItem label="上架" field="enabled" triggerPropName="checked" initialValue={true}>
            <Switch />
          </FormItem>
        </Form>
      </Modal>
    </div>
  )
}

// ========================
// Tab 3：支付订单
// ========================
const OrdersTab: React.FC = () => {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  const [status, setStatus] = useState<string>('')
  const [statusDraft, setStatusDraft] = useState<string>('')
  const [username, setUsername] = useState('')
  const [usernameDraft, setUsernameDraft] = useState('')
  const [markResult, setMarkResult] = useState<{ visible: boolean; key: string; orderId: string }>({
    visible: false, key: '', orderId: '',
  })
  const { groupName } = useGroups()

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getPaymentOrders({
        page: pagination.current,
        page_size: pagination.pageSize,
        status: status || undefined,
        username: username || undefined,
      })
      const d = res.data
      setData(Array.isArray(d?.data) ? d.data : [])
      setPagination((p) => ({
        current: d?.page ?? p.current,
        pageSize: d?.page_size ?? p.pageSize,
        total: d?.total ?? 0,
      }))
    } catch {
      Message.error('加载订单失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagination.current, pagination.pageSize, status, username])

  useEffect(() => { fetchData() }, [fetchData])

  const applyFilter = (nextStatus?: string, nextUsername?: string) => {
    if (nextStatus !== undefined) setStatus(nextStatus)
    if (nextUsername !== undefined) setUsername(nextUsername)
    setPagination((p) => ({ ...p, current: 1 }))
  }

  const handleMarkPaid = async (row: any) => {
    try {
      const res = await markPaymentOrderPaid(row.biz_order_id)
      Message.success('补单成功，已发货')
      setMarkResult({
        visible: true,
        key: res.data?.key ?? '',
        orderId: row.biz_order_id,
      })
      fetchData()
    } catch {
      Message.error('补单失败')
    }
  }

  const columns = [
    {
      title: '订单号',
      dataIndex: 'biz_order_id',
      render: (v: string) => (
        <Typography.Text copyable style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ag-primary)', fontWeight: 600 }}>
          {v}
        </Typography.Text>
      ),
    },
    { title: '套餐', dataIndex: 'package_label' },
    {
      title: '金额',
      dataIndex: 'amount_cny_cents',
      render: (v: number) => <span style={{ fontFamily: 'monospace' }}>{fmtYuan(v)}</span>,
    },
    {
      title: '实付',
      dataIndex: 'pay_amount_cny_cents',
      render: (v: number | null) => (
        <span style={{ fontFamily: 'monospace' }}>{fmtYuan(v)}</span>
      ),
    },
    {
      title: 'Key 额度',
      dataIndex: 'credit_usd',
      render: (v: number) => (
        <strong style={{ fontFamily: 'monospace' }}>{v === 0 ? '∞' : `$${v.toFixed(2)}`}</strong>
      ),
    },
    {
      title: '分组',
      dataIndex: 'group_id',
      render: (v: string | null) =>
        v ? <Tag color="cyan">{groupName(v)}</Tag> : <span style={{ color: 'var(--ag-outline)' }}>default</span>,
    },
    {
      title: '渠道',
      dataIndex: 'channel',
      render: (v: string) => (v ? <Tag color={v === 'wechat' ? 'green' : 'arcoblue'}>{CHANNEL_LABEL[v] ?? v}</Tag> : '—'),
    },
    {
      title: '购买者',
      dataIndex: 'username',
      render: (v: string | null) => v ? <span style={{ fontWeight: 700 }}>{v}</span> : <span style={{ color: 'var(--ag-outline)' }}>—</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (v: string) => {
        const meta = ORDER_STATUS[v] ?? { label: v, color: 'gray' }
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      title: '下单时间',
      dataIndex: 'created_at',
      render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--ag-outline)' }}>{fmtTime(v)}</span>,
    },
    {
      title: '支付时间',
      dataIndex: 'paid_at',
      render: (v: string | null) => <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--ag-outline)' }}>{fmtTime(v)}</span>,
    },
    {
      title: '操作',
      render: (_: any, row: any) =>
        row.credited_at ? null : (
          <Popconfirm
            title="确认已线下收到款？补单将立即发放 API key"
            onOk={() => handleMarkPaid(row)}
          >
            <Button size="mini" type="text" status="warning">手动补单</Button>
          </Popconfirm>
        ),
    },
  ]

  return (
    <div className="ag-data-panel ag-table-panel">
      <div className="ag-panel-header">
        <div>
          <h2 className="ag-panel-title">支付订单</h2>
          <p className="ag-panel-subtitle">订单按网关过期时间（约 5 分钟）自动标记过期；回调丢失时可用手动补单发货</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input
            size="small"
            style={{ width: 160 }}
            placeholder="购买者用户名"
            value={usernameDraft}
            onChange={setUsernameDraft}
            onPressEnter={() => applyFilter(undefined, usernameDraft.trim())}
            allowClear
          />
          <Select
            size="small"
            style={{ width: 120 }}
            placeholder="全部状态"
            value={statusDraft || undefined}
            onChange={(v) => { setStatusDraft(v ?? ''); applyFilter(v ?? '', undefined) }}
            options={[
              { label: '全部状态', value: '' },
              { label: '待支付', value: 'pending' },
              { label: '已支付', value: 'paid' },
              { label: '已过期', value: 'expired' },
              { label: '支付异常', value: 'failed' },
            ]}
          />
          <Button size="small" icon={<IconRefresh />} onClick={() => fetchData()}>
            查询
          </Button>
        </div>
      </div>
      <Table
        columns={columns}
        data={data}
        loading={loading}
        rowKey="id"
        size="small"
        pagination={{
          current: pagination.current,
          pageSize: pagination.pageSize,
          total: pagination.total,
          showTotal: true,
          sizeCanChange: true,
          onChange: (current: number, pageSize: number) =>
            setPagination((p) => ({ ...p, current, pageSize })),
        }}
        noDataElement={<span style={{ color: '#999' }}>暂无订单</span>}
      />
      <Modal
        title={`补单发货成功：${markResult.orderId}`}
        visible={markResult.visible}
        onCancel={() => setMarkResult((r) => ({ ...r, visible: false }))}
        footer={<Button type="primary" onClick={() => setMarkResult((r) => ({ ...r, visible: false }))}>关闭</Button>}
        unmountOnExit
      >
        <p style={{ color: 'var(--ag-outline)', fontSize: 12, margin: '0 0 8px' }}>发放的 API key（请交付给购买者）：</p>
        <Typography.Text
          copyable
          style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: 'var(--ag-primary)' }}
        >
          {markResult.key || '（未取到 key，请检查日志）'}
        </Typography.Text>
      </Modal>
    </div>
  )
}

// ========================
// 页面：三 Tab 组装
// ========================
const Payment: React.FC = () => {
  return (
    <div className="ag-page ag-workbench-page">
      <div className="ag-page-header">
        <div>
          <p className="ag-page-eyebrow">Monetization</p>
          <h1 className="ag-page-title">Payment</h1>
          <p className="ag-page-description">配置支付渠道、定义套餐并跟踪支付订单，支付成功自动发放 API key。</p>
        </div>
      </div>

      <Tabs defaultActiveTab="settings" className="ag-users-tabs">
        <TabPane key="settings" title="渠道配置">
          <SettingsTab />
        </TabPane>
        <TabPane key="packages" title="套餐管理">
          <PackagesTab />
        </TabPane>
        <TabPane key="orders" title="支付订单">
          <OrdersTab />
        </TabPane>
      </Tabs>
    </div>
  )
}

export default Payment
