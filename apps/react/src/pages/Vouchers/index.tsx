import React, { useState, useEffect, useCallback } from 'react'
import {
  Table, Button, Modal, Form, InputNumber, DatePicker,
  Popconfirm, Message, Typography, Tag,
} from '@arco-design/web-react'
import { IconPlus } from '@arco-design/web-react/icon'
import { getVouchers, createVoucher, deleteVoucher } from '../../api/vouchers'

const Vouchers: React.FC = () => {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()
  const [resultCodes, setResultCodes] = useState<string[]>([])
  const [resultVisible, setResultVisible] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getVouchers()
      const raw = res.data?.data ?? res.data
      setData(Array.isArray(raw) ? raw : [])
    } catch {
      Message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const handleSubmit = async (values: any) => {
    setSubmitting(true)
    try {
      const payload: any = {
        amount_usd: values.amount_usd,
        count: values.count ?? 1,
      }
      if (values.duration_days) {
        payload.duration_days = values.duration_days
      }
      if (values.expires_at) {
        payload.expires_at = values.expires_at
      }
      const res = await createVoucher(payload)
      const data = res.data
      const codes: string[] = data?.vouchers
        ? data.vouchers.map((v: any) => v.code).filter(Boolean)
        : [data?.code ?? data?.data?.code].filter(Boolean)
      if (codes.length > 0) {
        setResultCodes(codes)
        setResultVisible(true)
        Message.success(`已生成 ${codes.length} 张消费券`)
      } else {
        Message.success('创建成功（券码见列表）')
      }
      setVisible(false)
      form.resetFields()
      fetchData()
    } catch {
      Message.error('创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteVoucher(id)
      Message.success('已删除')
      fetchData()
    } catch {
      Message.error('删除失败')
    }
  }

  const downloadTxt = () => {
    const blob = new Blob([resultCodes.join('\n')], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `vouchers-${new Date().toISOString().slice(0, 10)}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const columns = [
    {
      title: '券码',
      dataIndex: 'code',
      render: (v: string) => (
        <Typography.Text copyable style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ag-primary)', fontWeight: 600 }}>{v}</Typography.Text>
      ),
    },
    {
      title: '金额 (USD)',
      dataIndex: 'amount_usd',
      render: (v: number) => v === 0
        ? <strong style={{ fontFamily: 'monospace' }}>∞</strong>
        : <strong style={{ fontFamily: 'monospace' }}>${v.toFixed(2)}</strong>,
    },
    {
      title: '过期时间',
      dataIndex: 'expires_at',
      render: (v: string) => v
        ? <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--ag-outline)' }}>{v.slice(0, 10)}</span>
        : <Tag color="gray">永不过期</Tag>,
    },
    {
      title: 'Key 有效期',
      dataIndex: 'duration_days',
      render: (v: number | null) => v
        ? <Tag color="arcoblue">{v} 天</Tag>
        : <span style={{ color: 'var(--ag-outline)' }}>充值型</span>,
    },
    {
      title: '状态',
      dataIndex: 'used',
      render: (v: boolean) => (
        <Tag color={v ? 'gray' : 'green'}>{v ? '已使用' : '未使用'}</Tag>
      ),
    },
    {
      title: '使用人',
      dataIndex: 'used_by',
      render: (v: string) => v
        ? <span style={{ fontWeight: 700 }}>{v}</span>
        : <span style={{ color: 'var(--ag-outline)' }}>—</span>,
    },
    {
      title: '操作',
      render: (_: any, row: any) => (
        row.used ? null : (
          <Popconfirm title="确认删除此消费券？" onOk={() => handleDelete(row.id)}>
            <Button size="mini" type="text" status="danger">删除</Button>
          </Popconfirm>
        )
      ),
    },
  ]

  return (
    <div className="ag-page ag-workbench-page">
      <div className="ag-page-header">
        <div>
          <p className="ag-page-eyebrow">Credit Grants</p>
          <h1 className="ag-page-title">Vouchers</h1>
          <p className="ag-page-description">生成和管理消费券，用于为账号充值或发放额度。</p>
        </div>
        <div className="ag-header-actions">
          <Button type="primary" icon={<IconPlus />} onClick={() => { form.resetFields(); setVisible(true) }}>
            生成消费券
          </Button>
        </div>
      </div>

      <div className="ag-data-panel ag-workbench-panel ag-table-panel">
        <div className="ag-panel-header">
          <div>
            <h2 className="ag-panel-title">消费券列表</h2>
            <p className="ag-panel-subtitle">追踪额度发放、领取状态和过期时间</p>
          </div>
        </div>

        <Table columns={columns} data={data} loading={loading} rowKey="id" />
      </div>

      <Modal
        title="生成消费券"
        visible={visible}
        onCancel={() => setVisible(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        unmountOnExit
      >
        <Form form={form} onSubmit={handleSubmit} layout="vertical">
          <Form.Item field="amount_usd" label="金额 (USD)" extra="0 = 无限额度（配合 Key 有效天数使用，兑出的 key 不限量）" rules={[{ required: true }]}>
            <InputNumber min={0} step={1} precision={2} style={{ width: '100%' }} placeholder="0 为无限额度" />
          </Form.Item>
          <Form.Item field="count" label="数量" initialValue={1} rules={[{ required: true }]}>
            <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="duration_days" label="Key 有效天数（选填）" extra="填写后此券为兑卡型：在 /voucher 页匿名兑换直接发放 API key；不填则为充值型，登录后兑换进余额">
            <InputNumber min={1} max={3650} precision={0} style={{ width: '100%' }} placeholder="如 7 / 30 / 365" />
          </Form.Item>
          <Form.Item field="expires_at" label="过期时间（选填）">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`已生成 ${resultCodes.length} 张消费券`}
        visible={resultVisible}
        onCancel={() => setResultVisible(false)}
        footer={
          <>
            <Button onClick={() => setResultVisible(false)}>关闭</Button>
            <Button type="primary" onClick={downloadTxt}>下载 TXT</Button>
          </>
        }
        unmountOnExit
      >
        <p style={{ color: 'var(--ag-outline)', fontSize: 12, margin: '0 0 8px' }}>
          每行一个券码，请妥善保管。兑换入口：/voucher（兑卡型）或登录后 Dashboard 兑换（充值型）
        </p>
        <pre style={{
          background: 'rgba(127,127,127,.08)',
          border: '1px solid rgba(127,127,127,.25)',
          borderRadius: 8,
          padding: 12,
          fontSize: 13,
          fontFamily: 'ui-monospace, monospace',
          whiteSpace: 'pre',
          margin: 0,
          maxHeight: 240,
          overflow: 'auto',
        }}>
          {resultCodes.join('\n')}
        </pre>
      </Modal>
    </div>
  )
}

export default Vouchers
