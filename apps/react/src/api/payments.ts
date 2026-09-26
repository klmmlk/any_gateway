import client from './client'

export interface PaymentSettings {
  id: string
  gateway_base_url: string
  api_key: string
  callback_secret: string
  public_base_url: string
  enabled_channels: string // JSON 数组字符串，如 '["wechat","alipay"]'
  enabled_channels_list?: string[]
  enabled: boolean
  created_at: string
  updated_at: string | null
}

export interface PaymentSettingsUpdate {
  gateway_base_url?: string
  api_key?: string // 空/缺省 = 保持原值
  callback_secret?: string // 空/缺省 = 保持原值
  public_base_url?: string
  enabled_channels?: string[]
  enabled?: boolean
}

export interface PaymentPackage {
  id: string
  label: string
  amount_cny_cents: number
  credit_usd: number
  duration_days: number | null
  group_id: string | null
  enabled: boolean
  sort_order: number
  created_at: string
}

export interface PaymentPackagePayload {
  label: string
  amount_cny_cents: number
  credit_usd: number
  duration_days?: number | null
  group_id?: string | null
  enabled?: boolean
  sort_order?: number
}

export interface PaymentOrder {
  id: string
  biz_order_id: string
  package_id: string | null
  package_label: string
  credit_usd: number
  duration_days: number | null
  group_id: string | null
  channel: string
  username: string | null
  amount_cny_cents: number
  pay_amount_cny_cents: number | null
  status: 'pending' | 'paid' | 'expired' | 'failed'
  gateway_order_id: string | null
  token_id: string | null
  paid_at: string | null
  credited_at: string | null
  created_at: string
  key?: string | null
}

export interface PaymentOrdersQuery {
  page?: number
  page_size?: number
  status?: string
  username?: string
}

// 设置
export const getPaymentSettings = () =>
  client.get('/admin/payment/settings')

export const updatePaymentSettings = (data: PaymentSettingsUpdate) =>
  client.put('/admin/payment/settings', data)

// 套餐
export const getPaymentPackages = () =>
  client.get('/admin/payment/packages')

export const createPaymentPackage = (data: PaymentPackagePayload) =>
  client.post('/admin/payment/packages', data)

export const updatePaymentPackage = (id: string, data: Partial<PaymentPackagePayload>) =>
  client.patch(`/admin/payment/packages/${id}`, data)

export const deletePaymentPackage = (id: string) =>
  client.delete(`/admin/payment/packages/${id}`)

// 订单
export const getPaymentOrders = (params: PaymentOrdersQuery) =>
  client.get('/admin/payment/orders', { params })

export const getPaymentOrder = (bizOrderId: string) =>
  client.get(`/admin/payment/orders/${bizOrderId}`)

export const markPaymentOrderPaid = (bizOrderId: string) =>
  client.post(`/admin/payment/orders/${bizOrderId}/mark-paid`)
