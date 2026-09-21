import client from './client'

export interface Voucher {
  id: string
  code: string
  amount_usd: number
  expires_at: string | null
  duration_days: number | null
  group_id: string | null
  used: boolean
  used_by: string | null
  used_at: string | null
  created_at: string
}

export interface VoucherCreate {
  amount_usd: number
  count?: number
  duration_days?: number
  group_id?: string
  expires_at?: string
}

// Admin endpoints
export const getVouchers = () =>
  client.get('/admin/vouchers')

export const createVoucher = (data: VoucherCreate) =>
  client.post('/admin/vouchers', data)

export const deleteVoucher = (id: string) =>
  client.delete(`/admin/vouchers/${id}`)

export const batchDeleteVouchers = (ids: string[]) =>
  client.post('/admin/vouchers/batch-delete', { ids })

// User endpoints
export const redeemVoucher = (code: string) =>
  client.post('/user/vouchers/redeem', { code })
