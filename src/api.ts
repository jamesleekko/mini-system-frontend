export type UserRole = 'REQUESTER' | 'AGENT' | 'ADMIN'
export type TicketStatus = 'PENDING' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'
export type TicketCategory = 'BUG' | 'FEATURE' | 'OTHER'
export type TicketPriority = 'LOW' | 'NORMAL' | 'HIGH'

export interface User {
  id: number
  username: string
  displayName: string
  role: UserRole
  merchant: (Organization & {
    role: 'MEMBER' | 'MERCHANT_ADMIN'
    defaultSupportGroupId: string | null
  }) | null
  supportGroups: (Organization & { role: 'AGENT' | 'LEAD' })[]
}

export interface Organization {
  id: string
  code: string
  name: string
}

export interface AgentCandidate {
  id: number
  username: string
  displayName: string
  role: UserRole
}

export interface Ticket {
  id: string
  number: string
  title: string
  description: string
  category: TicketCategory
  priority: TicketPriority
  status: TicketStatus
  requester: { id: string; displayName: string }
  assignee: { id: string; displayName: string } | null
  merchant: Organization
  supportGroup: Organization
  allowedActions: ('comment' | WorkflowAction)[]
  version: number
  createdAt: string
  updatedAt: string
}

export interface TicketPage {
  items: Ticket[]
  total: number
  page: number
  pageSize: number
}

export interface CreateTicketInput {
  title: string
  description: string
  category: TicketCategory
  priority: TicketPriority
}

export type WorkflowAction = 'assignment' | 'reassignment' | 'resolve' | 'reject' | 'close'

export interface TimelineItem {
  id: string
  sequence: string
  type: 'CREATED' | 'ASSIGNED' | 'REASSIGNED' | 'RESOLVED' | 'REJECTED' | 'CLOSED' | 'COMMENT'
  actor: { id: string; displayName: string }
  message: string | null
  fromStatus: TicketStatus | null
  toStatus: TicketStatus | null
  fromAssignee: Ticket['assignee']
  toAssignee: Ticket['assignee']
  createdAt: string
}

export interface TimelinePage {
  items: TimelineItem[]
  nextBefore: string | null
}

export class ApiError extends Error {
  status: number
  code: string
  fields: Record<string, string>

  constructor(
    status: number,
    code: string,
    message: string,
    fields: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.fields = fields
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  const body = await response.json()
  if (!response.ok) {
    throw new ApiError(response.status, body.code, body.message, body.fields)
  }
  return body.data as T
}

export const authApi = {
  me: () => request<User>('/auth/me'),
  login: (username: string, password: string) => request<User>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
}

export const ticketApi = {
  list: (parameters: URLSearchParams) => request<TicketPage>(`/tickets?${parameters.toString()}`),
  detail: (id: string) => request<Ticket>(`/tickets/${encodeURIComponent(id)}`),
  create: (input: CreateTicketInput) => request<Ticket>('/tickets', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  agents: (groupId: string) => request<AgentCandidate[]>(`/users/agents?groupId=${encodeURIComponent(groupId)}`),
  assign: (id: string, version: number, assigneeId: number) => request<Ticket>(`/tickets/${id}/assignment`, {
    method: 'POST', body: JSON.stringify({ version, assigneeId }),
  }),
  reassign: (id: string, version: number, assigneeId: number, reason: string) => request<Ticket>(`/tickets/${id}/reassignment`, {
    method: 'POST', body: JSON.stringify({ version, assigneeId, reason }),
  }),
  resolve: (id: string, version: number, resolution: string) => request<Ticket>(`/tickets/${id}/resolve`, {
    method: 'POST', body: JSON.stringify({ version, resolution }),
  }),
  reject: (id: string, version: number, reason: string) => request<Ticket>(`/tickets/${id}/reject`, {
    method: 'POST', body: JSON.stringify({ version, reason }),
  }),
  close: (id: string, version: number) => request<Ticket>(`/tickets/${id}/close`, {
    method: 'POST', body: JSON.stringify({ version }),
  }),
  comment: (id: string, body: string) => request<Ticket>(`/tickets/${id}/comments`, {
    method: 'POST', body: JSON.stringify({ body }),
  }),
  timeline: (id: string, before?: string) => request<TimelinePage>(
    `/tickets/${id}/timeline${before ? `?before=${encodeURIComponent(before)}` : ''}`,
  ),
}
