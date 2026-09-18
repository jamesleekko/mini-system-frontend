<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NCheckbox, NEmpty, NForm, NFormItem, NInput, NModal, NPagination, NSelect, NSpace, NSpin, NTable, NTag } from 'naive-ui'
import { ApiError, type User } from '../api'
import { adminApi, passwordProblem, type AdminUser, type AdminGroup, type AdminMerchant, type AdminMember, type AdminAudit, type Resource, type OrganizationResource } from '../admin-api'

const props = defineProps<{ user: User }>()
const emit = defineEmits<{ inaccessible: [error: unknown]; handover: [scope: { groupId?: string; userId?: string }]; identityChanged: []; busy: [value: boolean] }>()
type Tab = Resource | 'audits'
type Row = AdminUser | AdminMerchant | AdminGroup
const tab = ref<Tab>('users'), keyword = ref(''), state = ref<string | null>(null), roleFilter = ref<string | null>(null)
const rows = ref<Row[]>([]), audits = ref<AdminAudit[]>([]), page = ref(1), total = ref(0), loading = ref(false), error = ref(''), notice = ref('')
const dialog = ref<'create' | 'update' | 'activation' | 'deactivation' | 'password-reset' | null>(null)
const current = ref<Row | null>(null), resource = ref<Resource>('users'), saving = ref(false), dialogError = ref('')
const fields = ref<Record<string, string>>({}), form = ref({ username: '', displayName: '', role: 'REQUESTER', password: '', name: '', code: '', defaultSupportGroupId: null as string | null, reason: '', emergency: false })
const groups = ref<AdminGroup[]>([]), groupsLoading = ref(false)
const membersOf = ref<{ resource: OrganizationResource; organization: AdminMerchant | AdminGroup } | null>(null)
const members = ref<AdminMember[]>([]), membersLoading = ref(false), memberFormOpen = ref(false), editingMember = ref<AdminMember | null>(null), memberError = ref('')
const userSearch = ref(''), candidatePage = ref(1), candidateTotal = ref(0), candidates = ref<AdminUser[]>([]), candidateLoading = ref(false)
const memberForm = ref({ userId: null as string | null, role: 'MEMBER', enabled: true, reason: '', emergency: false })
const auditDetail = ref<AdminAudit | null>(null)
let alive = true, generation = 0, memberGeneration = 0, candidateGeneration = 0
const roleOptions = [{ label: '商户用户', value: 'REQUESTER' }, { label: '客服', value: 'AGENT' }, { label: '平台管理员', value: 'ADMIN' }]
const roleNames: Record<string, string> = { REQUESTER: '商户用户', AGENT: '客服', ADMIN: '平台管理员', MEMBER: '普通成员', MERCHANT_ADMIN: '商户管理员', LEAD: '组长' }
const tabNames = { users: '账号', merchants: '商户', 'support-groups': '客服组', audits: '审计记录' }
const dialogTitle = computed(() => dialog.value === 'create' ? `新增${tabNames[resource.value]}` : dialog.value === 'password-reset' ? '重置密码' : `${dialog.value === 'update' ? '编辑' : dialog.value === 'activation' ? '恢复' : '停用'}${tabNames[resource.value]}`)
const memberRoles = computed(() => membersOf.value?.resource === 'merchants' ? [{ label: '普通成员', value: 'MEMBER' }, { label: '商户管理员', value: 'MERCHANT_ADMIN' }] : [{ label: '客服', value: 'AGENT' }, { label: '组长', value: 'LEAD' }])
function isUser(row: Row): row is AdminUser { return 'username' in row }
function label(row: Row) { return isUser(row) ? row.displayName : row.name }
function errorText(cause: unknown) {
  if (!(cause instanceof ApiError)) return '请求未确认成功，请刷新核对后重试'
  const messages: Record<string, string> = {
    ADMIN_CONFLICT: '记录已被修改，请关闭弹窗并刷新后重试', LAST_MERCHANT_ADMIN: '请先指定另一名有效商户管理员，再移除此人的职责',
    LAST_PLATFORM_ADMIN: '至少需要保留一名平台管理员', CANNOT_DISABLE_SELF: '不能停用当前登录的管理员账号',
    OPEN_TICKETS_REQUIRE_HANDOVER: '此客服仍有处理中或已解决工单，请先交接；确需立即收回权限时选择紧急停用',
    GROUP_IN_USE: '客服组仍有未关闭工单或商户默认路由，请先迁移后再停用', MEMBERSHIP_EXISTS: '该成员关系已存在；商户账号不能直接改绑到另一商户',
    USERNAME_EXISTS: '账号已存在，请更换账号名', ORGANIZATION_CODE_EXISTS: '组织编码已存在', USER_DISABLED: '请先恢复该账号',
    ORGANIZATION_DISABLED: '请先恢复该组织', SUPPORT_GROUP_DISABLED: '请选择启用中的默认客服组', USE_PASSWORD_CHANGE: '请使用顶部“修改密码”修改本人的密码',
  }
  return messages[cause.code] ?? cause.message
}
function fail(cause: unknown, local = false) {
  if (!alive) return
  if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) { rows.value = []; audits.value = []; members.value = []; emit('inaccessible', cause); return }
  if (local) dialogError.value = errorText(cause); else error.value = errorText(cause)
  fields.value = cause instanceof ApiError ? cause.fields : {}
}
async function load() {
  const request = ++generation; loading.value = true; error.value = ''; rows.value = []; audits.value = []
  try {
    const query = { keyword: keyword.value, enabled: state.value === null ? null : state.value === 'true', role: roleFilter.value, page: page.value, pageSize: 20 }
    if (tab.value === 'audits') { const result = await adminApi.audits(query); if (alive && request === generation) { audits.value = result.items; total.value = result.total } }
    else { const result = await (tab.value === 'users' ? adminApi.users(query) : tab.value === 'merchants' ? adminApi.merchants(query) : adminApi.groups(query)); if (alive && request === generation) { rows.value = result.items; total.value = result.total } }
  } catch (cause) { if (request === generation) fail(cause) }
  finally { if (alive && request === generation) loading.value = false }
}
function changeTab(value: string) { if (saving.value) return; tab.value = value as Tab; keyword.value = ''; state.value = null; roleFilter.value = null; page.value = 1; notice.value = ''; void load() }
function search() { page.value = 1; void load() }
async function loadGroups() {
  groupsLoading.value = true; groups.value = []
  try {
    let next = 1, count = 0
    do { const result = await adminApi.groups({ page: next++, pageSize: 100 }); if (!alive) return; groups.value.push(...result.items); count = result.total } while (groups.value.length < count)
  } catch (cause) { fail(cause, true) }
  finally { if (alive) groupsLoading.value = false }
}
function open(action: NonNullable<typeof dialog.value>, row?: Row) {
  resource.value = tab.value as Resource; current.value = row ?? null; dialog.value = action; dialogError.value = ''; fields.value = {}
  form.value = { username: row && isUser(row) ? row.username : '', displayName: row && isUser(row) ? row.displayName : '', role: row && isUser(row) ? row.role : 'REQUESTER', password: '', name: row && !isUser(row) ? row.name : '', code: row && !isUser(row) ? row.code : '', defaultSupportGroupId: row && 'defaultSupportGroupId' in row ? row.defaultSupportGroupId : null, reason: '', emergency: false }
  if (resource.value === 'merchants' && (action === 'create' || action === 'update')) void loadGroups()
}
function closeDialog() { if (!saving.value) { dialog.value = null; form.value.password = ''; current.value = null } }
async function submit() {
  if (!dialog.value || saving.value || groupsLoading.value) return
  dialogError.value = ''; fields.value = {}
  if (!form.value.reason.trim()) { dialogError.value = '请填写操作原因'; return }
  if ((resource.value === 'users' && dialog.value === 'create') || dialog.value === 'password-reset') { dialogError.value = passwordProblem(form.value.password); if (dialogError.value) return }
  saving.value = true; emit('busy', true)
  try {
    let payload: Record<string, unknown> = { reason: form.value.reason, version: current.value?.version }
    if (dialog.value === 'create') {
      payload = resource.value === 'users' ? { username: form.value.username, displayName: form.value.displayName, role: form.value.role, password: form.value.password, reason: form.value.reason } : { code: form.value.code, name: form.value.name, reason: form.value.reason, ...(resource.value === 'merchants' ? { defaultSupportGroupId: form.value.defaultSupportGroupId ? Number(form.value.defaultSupportGroupId) : null } : {}) }
      await adminApi.create(resource.value, payload)
    } else if (current.value) {
      if (dialog.value === 'update') payload = { ...payload, ...(resource.value === 'users' ? { displayName: form.value.displayName } : { name: form.value.name }), ...(resource.value === 'merchants' ? { defaultSupportGroupId: form.value.defaultSupportGroupId ? Number(form.value.defaultSupportGroupId) : null } : {}) }
      if (dialog.value === 'password-reset') payload.newPassword = form.value.password
      if (resource.value === 'users' && dialog.value === 'deactivation') payload.emergency = form.value.emergency
      await adminApi.update(resource.value, current.value.id, dialog.value, payload)
    }
    if (!alive) return
    const self = current.value?.id === String(props.user.id) && resource.value === 'users'
    dialog.value = null; notice.value = '操作成功，变更已记录到审计'; await load(); if (self) emit('identityChanged')
  } catch (cause) { fail(cause, true) }
  finally { form.value.password = ''; if (alive) { saving.value = false; emit('busy', false) } }
}
async function showMembers(row: Row) {
  if (isUser(row)) return
  membersOf.value = { resource: tab.value as OrganizationResource, organization: row }; memberError.value = ''; await reloadMembers()
}
async function reloadMembers() {
  if (!membersOf.value) return
  const request = ++memberGeneration, context = membersOf.value; membersLoading.value = true; members.value = []
  try { const result = await adminApi.members(context.resource, context.organization.id); if (alive && request === memberGeneration) members.value = result }
  catch (cause) { memberError.value = errorText(cause); if (cause instanceof ApiError && [401, 403].includes(cause.status)) fail(cause) }
  finally { if (alive && request === memberGeneration) membersLoading.value = false }
}
function openMember(member?: AdminMember) {
  editingMember.value = member ?? null; memberError.value = ''; memberFormOpen.value = true
  memberForm.value = { userId: member?.userId ?? null, role: member?.role ?? (membersOf.value?.resource === 'merchants' ? 'MEMBER' : 'AGENT'), enabled: member?.enabled ?? true, reason: '', emergency: false }
  userSearch.value = ''; candidatePage.value = 1; candidates.value = []; if (!member) void loadCandidates()
}
async function loadCandidates() {
  if (!membersOf.value) return
  const request = ++candidateGeneration; candidateLoading.value = true
  try { const result = await adminApi.users({ keyword: userSearch.value, role: membersOf.value.resource === 'merchants' ? 'REQUESTER' : 'AGENT', enabled: true, page: candidatePage.value, pageSize: 10 }); if (alive && request === candidateGeneration) { candidates.value = result.items; candidateTotal.value = result.total } }
  catch (cause) { if (alive && request === candidateGeneration) { memberError.value = errorText(cause); if (cause instanceof ApiError && [401, 403].includes(cause.status)) fail(cause) } }
  finally { if (alive && request === candidateGeneration) candidateLoading.value = false }
}
async function submitMember() {
  if (!membersOf.value || saving.value) return
  memberError.value = ''; if (!memberForm.value.userId || !memberForm.value.reason.trim()) { memberError.value = '请选择账号并填写原因'; return }
  saving.value = true; emit('busy', true)
  try {
    const context = membersOf.value
    if (editingMember.value) await adminApi.updateMember(context.resource, context.organization.id, editingMember.value.userId, { version: editingMember.value.version, role: memberForm.value.role, enabled: memberForm.value.enabled, reason: memberForm.value.reason, emergency: memberForm.value.emergency })
    else await adminApi.addMember(context.resource, context.organization.id, { userId: Number(memberForm.value.userId), role: memberForm.value.role, reason: memberForm.value.reason })
    if (!alive) return
    memberFormOpen.value = false; await reloadMembers(); notice.value = '成员配置已保存，权限将在后续请求生效'
  } catch (cause) { memberError.value = errorText(cause); if (cause instanceof ApiError && [401, 403].includes(cause.status)) fail(cause) }
  finally { if (alive) { saving.value = false; emit('busy', false) } }
}
function handover(row: Row) { emit('handover', isUser(row) ? { userId: row.id } : { groupId: row.id }) }
function snapshot(value: string | null) { try { return JSON.stringify(JSON.parse(value ?? 'null'), null, 2) } catch { return value } }
onMounted(load)
onBeforeUnmount(() => { alive = false; generation++; memberGeneration++; candidateGeneration++; form.value.password = ''; emit('busy', false) })
</script>

<template>
  <section class="admin-center">
    <p class="admin-intro">账号、组织、成员职责与管理操作记录</p>
    <nav class="admin-tabs" role="tablist" aria-label="管理模块">
      <button v-for="item in [{ value: 'users', label: '账号管理' }, { value: 'merchants', label: '商户管理' }, { value: 'support-groups', label: '客服组管理' }, { value: 'audits', label: '操作审计' }]"
        :id="`admin-tab-${item.value}`" :key="item.value" type="button" role="tab" :aria-selected="tab === item.value" aria-controls="admin-panel" :disabled="saving" @click="changeTab(item.value)">{{ item.label }}</button>
    </nav>
    <div id="admin-panel" role="tabpanel" :aria-labelledby="`admin-tab-${tab}`">
    <NAlert v-if="error" type="error" class="page-alert">{{ error }}</NAlert><NAlert v-if="notice" type="success" closable class="page-alert" @close="notice = ''">{{ notice }}</NAlert>
    <NCard class="admin-filter-card" :bordered="false"><NForm inline @submit.prevent="search">
      <NFormItem label="搜索"><NInput v-model:value="keyword" clearable placeholder="搜索账号、名称或操作记录" /></NFormItem>
      <NFormItem v-if="tab !== 'audits'" label="状态"><NSelect v-model:value="state" clearable :options="[{ label: '启用', value: 'true' }, { label: '停用', value: 'false' }]" placeholder="全部状态" style="min-width: 130px" @update:value="search" /></NFormItem>
      <NFormItem v-if="tab === 'users'" label="账号身份"><NSelect v-model:value="roleFilter" :options="roleOptions" clearable placeholder="全部身份" style="min-width: 140px" @update:value="search" /></NFormItem>
      <NSpace><NButton attr-type="submit" :loading="loading">查询</NButton><NButton :loading="loading" @click="load">刷新</NButton><NButton v-if="tab !== 'audits'" type="primary" @click="open('create')">新增{{ tabNames[tab] }}</NButton></NSpace>
    </NForm></NCard>
    <NSpin :show="loading"><div class="admin-table-scroll"><NTable :single-line="false">
      <thead><tr v-if="tab !== 'audits'"><th>账号 / 编码</th><th>名称</th><th>{{ tab === 'users' ? '身份' : tab === 'merchants' ? '默认客服组' : '类型' }}</th><th>状态</th><th>操作</th></tr><tr v-else><th>时间</th><th>执行人</th><th>操作</th><th>目标</th><th>原因</th><th>详情</th></tr></thead>
      <tbody v-if="tab !== 'audits'"><tr v-for="row in rows" :key="row.id"><td>{{ isUser(row) ? row.username : row.code }}</td><td>{{ label(row) }}</td><td>{{ isUser(row) ? roleNames[row.role] : 'defaultSupportGroupId' in row ? ((row as AdminMerchant & { defaultSupportGroupName?: string }).defaultSupportGroupName || '未配置') : '客服组' }}</td><td><NTag :type="row.enabled ? 'success' : 'default'">{{ row.enabled ? '启用' : '停用' }}</NTag></td><td><NSpace :size="8" class="admin-row-actions">
        <NButton size="small" @click="open('update', row)">编辑</NButton><NButton v-if="!isUser(row)" size="small" @click="showMembers(row)">成员管理</NButton>
        <NButton size="small" :disabled="isUser(row) && row.id === String(user.id)" @click="open(row.enabled ? 'deactivation' : 'activation', row)">{{ row.enabled ? '停用' : '恢复' }}</NButton>
        <NButton v-if="isUser(row)" size="small" :disabled="row.id === String(user.id)" @click="open('password-reset', row)">重置密码</NButton>
        <NButton v-if="tab === 'support-groups' || (isUser(row) && row.role === 'AGENT')" size="small" @click="handover(row)">查看待交接工单</NButton>
      </NSpace></td></tr></tbody>
      <tbody v-else><tr v-for="audit in audits" :key="audit.id"><td>{{ new Date(audit.createdAt).toLocaleString() }}</td><td>{{ audit.actorName }}</td><td>{{ audit.action }}</td><td>{{ audit.targetType }} #{{ audit.targetId }}</td><td>{{ audit.reason }}</td><td><NButton size="small" @click="auditDetail = audit">查看变更</NButton></td></tr></tbody>
    </NTable></div><NEmpty v-if="!loading && !rows.length && !audits.length" description="暂无记录" class="empty-state" /></NSpin>
    <div class="pagination"><span>共 {{ total }} 条</span><NPagination v-model:page="page" :page-count="Math.max(1, Math.ceil(total / 20))" :disabled="loading" @update:page="load" /></div>
    </div>

    <NModal :show="dialog !== null" :mask-closable="!saving" :close-on-esc="!saving" @update:show="closeDialog"><NCard :title="dialogTitle" role="dialog" aria-modal="true" class="admin-dialog" :closable="!saving" @close="closeDialog">
      <NAlert v-if="dialogError" type="error" class="form-alert">{{ dialogError }}</NAlert>
      <NForm :disabled="saving" @submit.prevent="submit">
        <template v-if="dialog === 'create' || dialog === 'update'">
          <template v-if="resource === 'users'"><NFormItem label="账号" required><NInput v-model:value="form.username" :disabled="dialog !== 'create'" placeholder="3–50 位字母、数字、点、横线或下划线" /></NFormItem><NFormItem label="昵称" required><NInput v-model:value="form.displayName" placeholder="显示名称" /></NFormItem><NFormItem label="账号身份" required><NSelect v-model:value="form.role" :options="roleOptions" :disabled="dialog !== 'create'" /></NFormItem><NAlert type="info" class="form-alert">账号身份创建后固定。商户管理员和客服组长请在对应组织的成员管理中设置。</NAlert></template>
          <template v-else><NFormItem label="编码" required><NInput v-model:value="form.code" :disabled="dialog !== 'create'" placeholder="唯一组织编码" /></NFormItem><NFormItem label="名称" required><NInput v-model:value="form.name" placeholder="组织名称" /></NFormItem></template>
          <NFormItem v-if="resource === 'merchants'" label="默认客服组"><NSelect v-model:value="form.defaultSupportGroupId" clearable filterable :loading="groupsLoading" :options="groups.filter(g => g.enabled || g.id === form.defaultSupportGroupId).map(g => ({ label: g.name + (g.enabled ? '' : '（已停用）'), value: g.id, disabled: !g.enabled }))" placeholder="选择默认客服组，可清空" /></NFormItem>
        </template>
        <NFormItem v-if="(resource === 'users' && dialog === 'create') || dialog === 'password-reset'" :label="dialog === 'create' ? '初始密码' : '新密码'" required feedback="至少 12 个字符，最多 72 个 UTF-8 字节"><NInput v-model:value="form.password" type="password" autocomplete="new-password" show-password-on="click" placeholder="设置登录密码" /></NFormItem>
        <NAlert v-if="dialog === 'password-reset'" type="warning" class="form-alert">重置后，该账号的所有登录会话将失效。请通过合适的渠道告知账号本人。</NAlert>
        <NAlert v-if="dialog === 'deactivation'" type="warning" class="form-alert">即将停用“{{ current && label(current) }}”。历史记录保留；恢复账号或组织不会自动恢复其他被停用的成员关系。</NAlert>
        <NCheckbox v-if="resource === 'users' && current && isUser(current) && current.role === 'AGENT' && dialog === 'deactivation'" v-model:checked="form.emergency">紧急停用：立即回收权限，随后处理遗留工单交接</NCheckbox>
        <NFormItem label="操作原因" required><NInput v-model:value="form.reason" type="textarea" placeholder="说明本次变更原因" :autosize="{ minRows: 2 }" /></NFormItem>
        <NSpace justify="end"><NButton :disabled="saving" @click="closeDialog">取消</NButton><NButton type="primary" attr-type="submit" :loading="saving" :disabled="groupsLoading">保存</NButton></NSpace>
      </NForm>
    </NCard></NModal>

    <NModal :show="membersOf !== null" :mask-closable="!saving" :close-on-esc="!saving" @update:show="value => { if (!value && !saving) { membersOf = null; memberGeneration++ } }"><NCard :title="membersOf ? membersOf.organization.name + ' · 成员管理' : '成员管理'" role="dialog" aria-modal="true" class="admin-members-dialog" :closable="!saving" @close="membersOf = null">
      <NAlert v-if="memberError && !memberFormOpen" type="error" class="form-alert">{{ memberError }}</NAlert>
      <NSpace class="admin-member-tools"><NButton type="primary" :disabled="!membersOf?.organization.enabled" @click="openMember()">添加成员</NButton><NButton :loading="membersLoading" @click="reloadMembers">刷新成员</NButton></NSpace>
      <NSpin :show="membersLoading"><div class="admin-table-scroll"><NTable><thead><tr><th>账号</th><th>昵称</th><th>组织职责</th><th>关系状态</th><th>操作</th></tr></thead><tbody><tr v-for="member in members" :key="member.id"><td>{{ member.username }}</td><td>{{ member.displayName }}</td><td>{{ roleNames[member.role] }}</td><td>{{ member.enabled ? '启用' : '停用' }}{{ member.userEnabled ? '' : '（账号已停用）' }}</td><td><NSpace><NButton size="small" @click="openMember(member)">编辑成员</NButton><NButton v-if="membersOf?.resource === 'support-groups'" size="small" @click="emit('handover', { groupId: membersOf.organization.id, userId: member.userId })">查看待交接工单</NButton></NSpace></td></tr></tbody></NTable></div></NSpin>
      <NEmpty v-if="!membersLoading && !members.length" description="暂无成员" class="empty-state" />
    </NCard></NModal>
    <NModal :show="memberFormOpen" :mask-closable="!saving" :close-on-esc="!saving" @update:show="value => { if (!saving) memberFormOpen = value }"><NCard :title="editingMember ? '编辑成员职责' : '添加成员'" role="dialog" aria-modal="true" class="admin-dialog" :closable="!saving" @close="memberFormOpen = false">
      <NAlert v-if="memberError" type="error" class="form-alert">{{ memberError }}</NAlert>
      <NForm :disabled="saving" @submit.prevent="submitMember">
        <template v-if="!editingMember"><NFormItem label="查找账号"><NSpace><NInput v-model:value="userSearch" placeholder="输入账号或昵称" /><NButton @click="candidatePage = 1; loadCandidates()">查找</NButton></NSpace></NFormItem><NFormItem label="选择账号" required><NSelect v-model:value="memberForm.userId" :loading="candidateLoading" :options="candidates.map(u => ({ label: u.displayName + '（' + u.username + '）', value: u.id }))" placeholder="选择查询结果中的账号" /></NFormItem><NPagination v-model:page="candidatePage" :page-count="Math.max(1, Math.ceil(candidateTotal / 10))" @update:page="loadCandidates" /></template>
        <NAlert v-else type="info" class="form-alert">{{ editingMember.displayName }}（{{ editingMember.username }}）</NAlert>
        <NFormItem label="组织职责" required><NSelect v-model:value="memberForm.role" :options="memberRoles" /></NFormItem>
        <NCheckbox v-if="editingMember" v-model:checked="memberForm.enabled">启用成员关系</NCheckbox>
        <NCheckbox v-if="editingMember && !memberForm.enabled && membersOf?.resource === 'support-groups'" v-model:checked="memberForm.emergency">紧急退组，后续交接未完成工单</NCheckbox>
        <NFormItem label="操作原因" required><NInput v-model:value="memberForm.reason" type="textarea" placeholder="说明本次成员变更原因" /></NFormItem>
        <NSpace justify="end"><NButton :disabled="saving" @click="memberFormOpen = false">取消</NButton><NButton type="primary" attr-type="submit" :loading="saving">保存成员</NButton></NSpace>
      </NForm>
    </NCard></NModal>
    <NModal :show="auditDetail !== null" @update:show="value => { if (!value) auditDetail = null }"><NCard title="审计变更详情" role="dialog" aria-modal="true" class="admin-members-dialog" closable @close="auditDetail = null"><template v-if="auditDetail"><p>{{ auditDetail.actorName }} · {{ auditDetail.action }}</p><p>{{ auditDetail.reason }}</p><h3>变更前</h3><pre class="admin-audit-json">{{ snapshot(auditDetail.beforeValue) }}</pre><h3>变更后</h3><pre class="admin-audit-json">{{ snapshot(auditDetail.afterValue) }}</pre></template></NCard></NModal>
  </section>
</template>

<style scoped>
.admin-intro{margin-top:8px;color:#6c7a72}.admin-filter-card{margin:16px 0}.admin-filter-card :deep(.n-form){align-items:center;gap:12px;flex-wrap:wrap}.admin-table-scroll{overflow:auto}.admin-table-scroll :deep(table){min-width:760px}.admin-row-actions{max-width:380px}.admin-member-tools{margin-bottom:20px}.admin-audit-json{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f6;padding:16px;margin:12px 0 20px}.admin-center h3{margin-top:18px}
.admin-tabs{display:flex;gap:24px;margin:20px 0;border-bottom:1px solid #dfe6e2;overflow:auto}.admin-tabs button{background:none;border:0;border-bottom:3px solid transparent;padding:12px 2px;white-space:nowrap;cursor:pointer;color:#65736b}.admin-tabs button[aria-selected=true]{border-color:#17664e;color:#17664e;font-weight:600}.admin-tabs button:disabled{cursor:wait;opacity:.6}
:global(.admin-dialog){width:min(560px,calc(100vw - 32px));max-height:90vh;overflow:auto}:global(.admin-members-dialog){width:min(1040px,calc(100vw - 32px));max-height:90vh;overflow:auto}
@media(max-width:720px){.admin-filter-card :deep(.n-form){display:block}.admin-filter-card :deep(.n-form-item){width:100%}.admin-row-actions{min-width:260px}}
</style>
