import { request, type UserRole } from './api'

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface AdminUser {
  id: string; username: string; displayName: string; role: UserRole
  enabled: boolean; version: number; createdAt: string
}
export interface AdminGroup { id: string; code: string; name: string; enabled: boolean; version: number }
export interface AdminMerchant extends AdminGroup { defaultSupportGroupId: string | null }
export interface AdminMember {
  id: string; userId: string; username: string; displayName: string
  role: 'MEMBER' | 'MERCHANT_ADMIN' | 'AGENT' | 'LEAD'; enabled: boolean; userEnabled: boolean; version: number
}
export interface AdminAudit {
  id: string; actorType: string; actorName: string; action: string; targetType: string; targetId: string
  reason: string; beforeValue: string | null; afterValue: string | null; createdAt: string
}
export type Resource = 'users' | 'merchants' | 'support-groups'
export type OrganizationResource = Exclude<Resource, 'users'>
export type ListQuery = Record<string, string | number | boolean | null | undefined>
function query(values: ListQuery) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  return params.toString()
}
const post = <T>(path: string, data: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(data) })
export const adminApi = {
  users: (values: ListQuery) => request<Page<AdminUser>>(`/admin/users?${query(values)}`),
  merchants: (values: ListQuery) => request<Page<AdminMerchant>>(`/admin/merchants?${query(values)}`),
  groups: (values: ListQuery) => request<Page<AdminGroup>>(`/admin/support-groups?${query(values)}`),
  audits: (values: ListQuery) => request<Page<AdminAudit>>(`/admin/audits?${query(values)}`),
  create: (resource: Resource, data: unknown) => post(`/admin/${resource}`, data),
  update: (resource: Resource, id: string, action: string, data: unknown) => post(`/admin/${resource}/${encodeURIComponent(id)}/${action}`, data),
  members: (resource: OrganizationResource, id: string) => request<AdminMember[]>(`/admin/${resource}/${encodeURIComponent(id)}/members`),
  addMember: (resource: OrganizationResource, id: string, data: unknown) => post(`/admin/${resource}/${encodeURIComponent(id)}/members`, data),
  updateMember: (resource: OrganizationResource, id: string, userId: string, data: unknown) => post(`/admin/${resource}/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/update`, data),
  changePassword: (currentPassword: string, newPassword: string) => post('/auth/password', { currentPassword, newPassword }),
}

export function passwordProblem(value: string): string {
  if ([...value].length < 12) return '密码至少需要 12 个字符'
  if (new TextEncoder().encode(value).length > 72) return '密码不能超过 72 个 UTF-8 字节（中文字符通常占 3 字节）'
  return ''
}
