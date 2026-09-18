<script setup lang="ts">
import {
  computed,
  onMounted,
  ref,
} from 'vue';

import {
  NAlert,
  NButton,
  NCard,
  NConfigProvider,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NPagination,
  NSelect,
  NSpace,
  NSpin,
  NTable,
  NTag,
  NText,
} from 'naive-ui';

import type {
  CreateTicketInput,
  Ticket,
  TicketCategory,
  TicketPriority,
  TicketStatus,
  User,
} from './api';
import {
  ApiError,
  authApi,
  ticketApi,
} from './api';
import TicketWorkflow from './components/TicketWorkflow.vue'

const user = ref<User | null>(null)
const logoutPending = ref(readLogoutPending())
const initialized = ref(false)
const view = ref<'list' | 'create' | 'detail'>('list')
const username = ref('')
const password = ref('')
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const fields = ref<Record<string, string>>({})
const tickets = ref<Ticket[]>([])
const selectedTicket = ref<Ticket | null>(null)
let requestGeneration = 0
const total = ref(0)
const page = ref(1)
const keyword = ref('')
const status = ref('')
const category = ref('')
const priority = ref('')
const assigneeId = ref('')
const form = ref<CreateTicketInput>({
  title: '',
  description: '',
  category: 'BUG',
  priority: 'NORMAL',
})

const roleNames = { REQUESTER: '商户成员', AGENT: '客服', ADMIN: '平台管理员' }
const hasAccess = computed(() => user.value?.role === 'ADMIN'
  || (user.value?.role === 'REQUESTER' && !!user.value.merchant)
  || (user.value?.role === 'AGENT' && user.value.supportGroups.length > 0))
const canCreate = computed(() => user.value?.role === 'REQUESTER' && !!user.value.merchant)
const identityLabel = computed(() => user.value?.merchant?.role === 'MERCHANT_ADMIN'
  ? '商户管理员' : user.value ? roleNames[user.value.role] : '')
const scopeLabel = computed(() => user.value?.merchant?.name
  ?? (user.value?.role === 'ADMIN' ? '平台管理'
    : user.value?.supportGroups.map(group => group.name).join('、') || '暂未配置访问范围'))
const statusNames: Record<TicketStatus, string> = {
  PENDING: '待分配',
  IN_PROGRESS: '处理中',
  RESOLVED: '已解决',
  CLOSED: '已关闭',
}
const categoryNames: Record<TicketCategory, string> = {
  BUG: '问题反馈',
  FEATURE: '功能建议',
  OTHER: '其他',
}
const priorityNames: Record<TicketPriority, string> = {
  LOW: '低',
  NORMAL: '普通',
  HIGH: '高',
}
const listTitle = computed(() =>
  user.value?.role === 'ADMIN'
    ? '全部工单'
    : user.value?.role === 'AGENT'
    ? '分配给我的工单'
    : user.value?.merchant?.role === 'MERCHANT_ADMIN'
    ? '本商户工单'
    : '我提交的工单',
)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / 20)))
const selectOptions = {
  status: [
    { label: '全部状态', value: '' },
    ...Object.entries(statusNames).map(([value, label]) => ({ label, value })),
  ],
  category: [
    { label: '全部分类', value: '' },
    ...Object.entries(categoryNames).map(([value, label]) => ({
      label,
      value,
    })),
  ],
  priority: [
    { label: '全部优先级', value: '' },
    ...Object.entries(priorityNames).map(([value, label]) => ({
      label,
      value,
    })),
  ],
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function resetFilters() {
  page.value = 1
  keyword.value = ''
  status.value = ''
  category.value = ''
  priority.value = ''
  assigneeId.value = ''
}

function clearProtectedData() {
  tickets.value = []
  selectedTicket.value = null
  total.value = 0
  notice.value = ''
  fields.value = {}
}

function clearWorkspace() {
  requestGeneration++
  clearProtectedData()
  resetFilters()
  form.value = { title: '', description: '', category: 'BUG', priority: 'NORMAL' }
  view.value = 'list'
  loading.value = false
  busy.value = false
}

function identityScope(identity: User | null) {
  return JSON.stringify(identity && [identity.id, identity.role, identity.merchant, identity.supportGroups])
}

function readLogoutPending() {
  try {
    return sessionStorage.getItem('ticket-desk.logout-pending') === '1'
  } catch {
    return false
  }
}

function setLogoutPending(pending: boolean) {
  logoutPending.value = pending
  try {
    if (pending) sessionStorage.setItem('ticket-desk.logout-pending', '1')
    else sessionStorage.removeItem('ticket-desk.logout-pending')
  } catch {
    // Restricted storage must not prevent clearing the in-memory workspace.
  }
}

async function refreshIdentity(generation: number) {
  const identity = await authApi.me()
  if (generation !== requestGeneration) return false
  if (identityScope(user.value) !== identityScope(identity)) {
    clearProtectedData()
    resetFilters()
    form.value = { title: '', description: '', category: 'BUG', priority: 'NORMAL' }
  }
  user.value = identity
  if (!hasAccess.value) view.value = 'list'
  return hasAccess.value
}

function showError(cause: unknown) {
  fields.value = cause instanceof ApiError ? cause.fields : {}
  if (cause instanceof ApiError && cause.status === 401) {
    clearWorkspace()
    user.value = null
    error.value = cause.code === 'INVALID_CREDENTIALS' ? '账号或密码错误' : '登录已失效，请重新登录'
  } else if (cause instanceof ApiError && (cause.status === 404 || cause.status === 403)) {
    clearWorkspace()
    error.value = cause.status === 404
      ? '工单不存在或不可访问，已清除原工单内容，请刷新工作台'
      : '当前访问权限不可用，请刷新工作台；如仍无法访问，请联系管理员'
  } else if (cause instanceof ApiError && cause.code === 'MERCHANT_ROUTE_UNAVAILABLE') {
    error.value = '商户尚未配置可用的客服组，请联系管理员配置后再提交；已保留填写内容'
  } else if (cause instanceof ApiError && cause.code === 'ASSIGNEE_UNAVAILABLE') {
    error.value = '当前处理人已不可用，请等待客服交接；你仍可通过评论补充问题'
  } else if (cause instanceof ApiError) {
    error.value = cause.message
  } else {
    error.value = '网络连接失败，请核对操作结果后再重试'
  }
}

async function loadTickets() {
  if (busy.value || logoutPending.value) return
  const generation = ++requestGeneration
  clearProtectedData()
  view.value = 'list'
  loading.value = true
  error.value = ''
  try {
    if (!await refreshIdentity(generation) || generation !== requestGeneration) return
    const parameters = new URLSearchParams({ page: String(page.value), pageSize: '20' })
    for (const [key, value] of Object.entries({
      keyword: keyword.value.trim(), status: status.value,
      category: category.value, priority: priority.value,
      assigneeId: user.value?.role === 'ADMIN' ? assigneeId.value : '',
    })) {
      if (value) parameters.set(key, value)
    }
    const result = await ticketApi.list(parameters)
    if (generation !== requestGeneration) return
    tickets.value = result.items
    total.value = result.total
  } catch (cause) {
    if (generation === requestGeneration) showError(cause)
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

async function login() {
  if (busy.value || logoutPending.value) return
  const generation = ++requestGeneration
  busy.value = true
  error.value = ''
  try {
    const identity = await authApi.login(username.value.trim(), password.value)
    if (generation !== requestGeneration) return
    user.value = identity
    password.value = ''
    resetFilters()
    busy.value = false
    await loadTickets()
  } catch (cause) {
    if (generation === requestGeneration) showError(cause)
  } finally {
    if (generation === requestGeneration) busy.value = false
  }
}

async function logout() {
  if (busy.value) return
  clearWorkspace()
  const generation = requestGeneration
  busy.value = true
  user.value = null
  password.value = ''
  setLogoutPending(true)
  error.value = ''
  try {
    await authApi.logout()
    if (generation === requestGeneration) setLogoutPending(false)
  } catch {
    if (generation === requestGeneration) {
      error.value = '退出尚未完成，服务器未确认会话已注销。工单内容已隐藏，请重试退出。'
    }
  } finally {
    if (generation === requestGeneration) busy.value = false
  }
}

async function filterTickets() {
  page.value = 1
  await loadTickets()
}

async function changePage(nextPage: number) {
  page.value = nextPage
  await loadTickets()
}

async function openTicket(id: string) {
  if (busy.value) return
  const generation = ++requestGeneration
  clearProtectedData()
  view.value = 'detail'
  loading.value = true
  error.value = ''
  try {
    if (!await refreshIdentity(generation) || generation !== requestGeneration) return
    const ticket = await ticketApi.detail(id)
    if (generation !== requestGeneration) return
    selectedTicket.value = ticket
  } catch (cause) {
    if (generation === requestGeneration) showError(cause)
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

function openCreate() {
  if (busy.value || loading.value || !canCreate.value) return
  requestGeneration++
  clearProtectedData()
  form.value = { title: '', description: '', category: 'BUG', priority: 'NORMAL' }
  view.value = 'create'
  error.value = ''
}

async function backToList() {
  await loadTickets()
}

async function createTicket() {
  if (busy.value || !canCreate.value) return
  const generation = ++requestGeneration
  busy.value = true
  error.value = ''
  fields.value = {}
  try {
    const ticket = await ticketApi.create(form.value)
    if (generation !== requestGeneration) return
    selectedTicket.value = ticket
    view.value = 'detail'
    notice.value = '工单 ' + ticket.number + ' 已提交'
    form.value = { title: '', description: '', category: 'BUG', priority: 'NORMAL' }
  } catch (cause) {
    if (generation === requestGeneration) showError(cause)
  } finally {
    if (generation === requestGeneration) busy.value = false
  }
}

function renderStatus(ticketStatus: TicketStatus) {
  const type: 'warning' | 'info' | 'success' | 'default' =
    ticketStatus === 'PENDING'
      ? 'warning'
      : ticketStatus === 'IN_PROGRESS'
      ? 'info'
      : ticketStatus === 'RESOLVED'
      ? 'success'
      : 'default'
  return { label: statusNames[ticketStatus], type }
}

function handleInaccessible(cause: unknown) {
  selectedTicket.value = null
  showError(cause)
}

onMounted(async () => {
  if (logoutPending.value) {
    initialized.value = true
    await logout()
    return
  }
  await loadTickets()
  // An absent initial session is the normal login screen, not an expired-session warning.
  if (!user.value && error.value === '登录已失效，请重新登录') error.value = ''
  initialized.value = true
})
</script>

<template>
  <NConfigProvider>
    <NLayout class="app-shell">
      <NLayoutHeader class="topbar">
        <a class="brand" href="#" @click.prevent="user && backToList()"
          ><span class="brand-mark">T</span><strong>微型工单</strong></a
        >
        <NSpace v-if="user" align="center" :size="14">
          <NText depth="2">{{ user.displayName }}</NText>
          <NTag size="small" :bordered="false">{{ identityLabel }}</NTag>
          <NButton text :disabled="busy" @click="logout">退出登录</NButton>
        </NSpace>
      </NLayoutHeader>
      <NLayoutContent class="app-content">
        <main v-if="!initialized" class="loading-page">
          <NSpin size="small" /><NText depth="3">正在连接工作台…</NText>
        </main>
        <main v-else-if="logoutPending" class="login-page">
          <div class="login-heading">
            <NText depth="3" class="section-label">TICKET DESK</NText>
            <h1>{{ busy ? '正在退出登录' : '退出尚未完成' }}</h1>
          </div>
          <NCard :bordered="false" class="login-card">
            <NAlert :type="error ? 'error' : 'info'" :show-icon="true" class="form-alert">
              {{ error || '工单内容已隐藏，正在等待服务器确认会话注销。' }}
            </NAlert>
            <NButton type="primary" block :loading="busy" :disabled="busy" @click="logout">重试退出</NButton>
          </NCard>
        </main>
        <main v-else-if="!user" class="login-page">
          <div class="login-heading">
            <NText depth="3" class="section-label">TICKET DESK</NText>
            <h1>登录工作台</h1>
          </div>
          <NCard :bordered="false" class="login-card">
            <NAlert
              v-if="error"
              type="error"
              :show-icon="true"
              class="form-alert"
              >{{ error }}</NAlert
            >
            <NForm @submit.prevent="login">
              <NFormItem label="账号" required
                ><NInput
                  v-model:value="username"
                  name="username"
                  autocomplete="username"
                  placeholder="请输入账号"
              /></NFormItem>
              <NFormItem label="密码" required
                ><NInput
                  v-model:value="password"
                  name="password"
                  type="password"
                  show-password-on="click"
                  autocomplete="current-password"
                  placeholder="请输入密码"
                  @keyup.enter="login"
              /></NFormItem>
              <NButton attr-type="submit" type="primary" block :loading="busy"
                >登录</NButton
              >
            </NForm>
          </NCard>
        </main>
        <main v-else class="workspace">
          <div class="page-heading">
            <div>
              <NText depth="3" class="section-label">{{ scopeLabel }} · 工单工作台</NText>
              <h1>
                {{
                  view === 'list'
                    ? listTitle
                    : view === 'create'
                    ? '新建工单'
                    : '工单详情'
                }}
              </h1>
            </div>
            <NButton
              v-if="view === 'list' && canCreate"
              type="primary"
              :disabled="busy || loading"
              @click="openCreate"
              >新建工单</NButton
            >
            <NButton
              v-if="view !== 'list'"
              secondary
              :disabled="busy"
              @click="backToList"
              >返回列表</NButton
            >
          </div>
          <NAlert
            v-if="error"
            type="error"
            :show-icon="true"
            class="page-alert"
            >{{ error }}</NAlert
          >
          <NAlert
            v-if="notice"
            type="success"
            :show-icon="true"
            closable
            class="page-alert"
            @close="notice = ''"
            >{{ notice }}</NAlert
          >

          <NCard v-if="!hasAccess" :bordered="false" class="scope-card">
            <NEmpty description="暂未配置访问范围">
              <template #extra>
                <p class="scope-help">请联系管理员配置商户或客服组，配置完成后刷新工作台。</p>
                <NButton secondary :loading="loading" :disabled="busy" @click="loadTickets">刷新工作台</NButton>
              </template>
            </NEmpty>
          </NCard>
          <template v-else-if="view === 'list'">
            <NCard :bordered="false" class="filter-card">
              <NForm inline @submit.prevent="filterTickets">
                <NFormItem label="搜索"
                  ><NInput
                    v-model:value="keyword"
                    clearable
                    placeholder="标题或工单编号"
                    maxlength="100"
                    @keyup.enter="filterTickets"
                /></NFormItem>
                <NFormItem label="状态"
                  ><NSelect
                    v-model:value="status"
                    :options="selectOptions.status"
                    clearable
                    @update:value="filterTickets"
                /></NFormItem>
                <NFormItem label="分类"
                  ><NSelect
                    v-model:value="category"
                    :options="selectOptions.category"
                    clearable
                    @update:value="filterTickets"
                /></NFormItem>
                <NFormItem label="优先级"
                  ><NSelect
                    v-model:value="priority"
                    :options="selectOptions.priority"
                    clearable
                    @update:value="filterTickets"
                /></NFormItem>
                <NFormItem v-if="user.role === 'ADMIN'" label="分配情况"
                  ><NSelect
                    v-model:value="assigneeId"
                    :options="[
                      { label: '未分配', value: 'unassigned' },
                    ]"
                    clearable
                    placeholder="全部工单"
                    @update:value="filterTickets"
                /></NFormItem>
                <NButton attr-type="submit" secondary :loading="loading"
                  >搜索</NButton
                >
                <NButton text :loading="loading" @click="loadTickets"
                  >刷新</NButton
                >
              </NForm>
            </NCard>
            <div class="list-summary">
              <NText strong>工单记录</NText
              ><NText depth="3">{{ total }} 条</NText>
            </div>
            <NCard :bordered="false" class="table-card">
              <NSpin :show="loading">
                <NTable :single-line="false" striped>
                  <thead>
                    <tr>
                      <th>工单</th>
                      <th>所属商户</th>
                      <th>分类</th>
                      <th>优先级</th>
                      <th>状态</th>
                      <th>提单人</th>
                      <th>处理人</th>
                      <th>创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="ticket in tickets" :key="ticket.id">
                      <td class="ticket-cell">
                        <NButton
                          text
                          class="ticket-link"
                          @click="openTicket(ticket.id)"
                          >{{ ticket.title }}</NButton
                        ><NText depth="3" class="ticket-number">{{
                          ticket.number
                        }}</NText>
                      </td>
                      <td>{{ ticket.merchant.name }}</td>
                      <td>{{ categoryNames[ticket.category] }}</td>
                      <td>
                        <NText
                          :type="
                            ticket.priority === 'HIGH' ? 'error' : undefined
                          "
                          >{{ priorityNames[ticket.priority] }}</NText
                        >
                      </td>
                      <td>
                        <NTag
                          size="small"
                          :type="renderStatus(ticket.status).type"
                          :bordered="false"
                          >{{ renderStatus(ticket.status).label }}</NTag
                        >
                      </td>
                      <td>{{ ticket.requester.displayName }}</td>
                      <td>{{ ticket.assignee?.displayName ?? '未分配' }}</td>
                      <td class="time-cell">
                        {{ formatTime(ticket.createdAt) }}
                      </td>
                    </tr>
                  </tbody>
                </NTable>
                <NEmpty
                  v-if="!tickets.length && !loading"
                  description="暂无符合条件的工单"
                  class="empty-state"
                />
              </NSpin>
            </NCard>
            <div class="pagination">
              <NText depth="3">共 {{ total }} 条</NText
              ><NPagination
                v-model:page="page"
                :page-count="pageCount"
                :page-size="20"
                :disabled="loading"
                @update:page="changePage"
              />
            </div>
          </template>

          <NCard
            v-else-if="view === 'create'"
            :bordered="false"
            class="form-card"
          >
            <NText depth="2" class="create-scope">所属商户：{{ user.merchant?.name }}</NText>
            <NForm
              :model="form"
              :show-label="true"
              label-placement="top"
              @submit.prevent="createTicket"
            >
              <NFormItem
                label="标题"
                required
                :feedback="fields.title"
                :validation-status="fields.title ? 'error' : undefined"
                ><NInput
                  v-model:value="form.title"
                  placeholder="简要描述你遇到的问题"
              /></NFormItem>
              <NSpace :size="20" :wrap="true"
                ><NFormItem label="分类"
                  ><NSelect
                    v-model:value="form.category"
                    :options="
                      Object.entries(categoryNames).map(([value, label]) => ({
                        value,
                        label,
                      }))
                    " /></NFormItem
                ><NFormItem label="优先级"
                  ><NSelect
                    v-model:value="form.priority"
                    :options="
                      Object.entries(priorityNames).map(([value, label]) => ({
                        value,
                        label,
                      }))
                    " /></NFormItem
              ></NSpace>
              <NFormItem
                label="问题描述"
                required
                :feedback="fields.description"
                :validation-status="fields.description ? 'error' : undefined"
                ><NInput
                  v-model:value="form.description"
                  type="textarea"
                  :autosize="{ minRows: 8, maxRows: 16 }"
                  placeholder="问题发生的场景、实际表现及预期结果"
              /></NFormItem>
              <NSpace
                ><NButton attr-type="submit" type="primary" :loading="busy"
                  >提交工单</NButton
                ><NButton secondary :disabled="busy" @click="backToList"
                  >取消</NButton
                ></NSpace
              >
            </NForm>
          </NCard>

          <section v-else class="detail-content">
            <NSpin :show="loading">
              <template v-if="selectedTicket">
                <div class="detail-heading">
                  <div>
                    <NText depth="3" class="ticket-number">{{
                      selectedTicket.number
                    }}</NText>
                    <h2>{{ selectedTicket.title }}</h2>
                  </div>
                  <NTag
                    :type="renderStatus(selectedTicket.status).type"
                    size="medium"
                    >{{ renderStatus(selectedTicket.status).label }}</NTag
                  >
                </div>
                <NDescriptions
                  bordered
                  :column="3"
                  label-placement="top"
                  class="metadata"
                  ><NDescriptionsItem label="所属商户">{{ selectedTicket.merchant.name }}</NDescriptionsItem
                  ><NDescriptionsItem label="客服组">{{ selectedTicket.supportGroup.name }}</NDescriptionsItem
                  ><NDescriptionsItem label="分类">{{
                    categoryNames[selectedTicket.category]
                  }}</NDescriptionsItem
                  ><NDescriptionsItem label="优先级"
                    ><NText
                      :type="
                        selectedTicket.priority === 'HIGH' ? 'error' : undefined
                      "
                      >{{ priorityNames[selectedTicket.priority] }}</NText
                    ></NDescriptionsItem
                  ><NDescriptionsItem label="提单人">{{
                    selectedTicket.requester.displayName
                  }}</NDescriptionsItem
                  ><NDescriptionsItem label="当前处理人">{{
                    selectedTicket.assignee?.displayName ?? '未分配'
                  }}</NDescriptionsItem
                  ><NDescriptionsItem label="创建时间">{{
                    formatTime(selectedTicket.createdAt)
                  }}</NDescriptionsItem
                  ><NDescriptionsItem label="最后更新">{{
                    formatTime(selectedTicket.updatedAt)
                  }}</NDescriptionsItem></NDescriptions
                >
                <NDivider />
                <section class="description">
                  <h3>问题描述</h3>
                  <NText depth="2" class="description-text">{{
                    selectedTicket.description
                  }}</NText>
                </section>
                <TicketWorkflow
                  :key="selectedTicket.id"
                  :ticket="selectedTicket"
                  @updated="ticket => { selectedTicket = ticket }"
                  @busy="value => { busy = value }"
                  @inaccessible="handleInaccessible"
                  @refresh="openTicket(selectedTicket.id)"
                />
              </template>
              <NEmpty v-else description="无法加载工单" />
            </NSpin>
          </section>
        </main>
      </NLayoutContent>
    </NLayout>
  </NConfigProvider>
</template>
