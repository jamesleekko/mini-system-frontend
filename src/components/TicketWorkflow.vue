<script setup lang="ts">
import {
  computed,
  onMounted,
  onUnmounted,
  ref,
} from 'vue';

import {
  NAlert,
  NButton,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NSpin,
  NText,
  NTimeline,
  NTimelineItem,
} from 'naive-ui';

import type {
  AgentCandidate,
  Organization,
  Ticket,
  TicketStatus,
  TimelineItem,
  User,
  WorkflowAction,
} from '../api';
import {
  ApiError,
  ticketApi,
} from '../api';

const props = defineProps<{ ticket: Ticket; user: User }>()
const emit = defineEmits<{
  updated: [ticket: Ticket]
  busy: [value: boolean]
  inaccessible: [error: unknown]
  refresh: []
}>()

const action = ref<WorkflowAction | null>(null)
const actionVersion = ref(0)
const saving = ref(false)
const refreshing = ref(false)
const loadingHistory = ref(false)
const loadingAgents = ref(false)
const loadingGroups = ref(false)
const needsRefresh = ref(false)
const error = ref('')
const historyError = ref('')
const success = ref('')
const fieldErrors = ref<Record<string, string>>({})
const comment = ref('')
const message = ref('')
const assigneeId = ref<number | null>(null)
const groupId = ref<string | null>(null)
const agents = ref<AgentCandidate[]>([])
const groups = ref<Organization[]>([])
const items = ref<TimelineItem[]>([])
const nextBefore = ref<string | null>(null)
let active = true
let historyRequest = 0
let agentRequest = 0
let groupRequest = 0

const labels: Record<WorkflowAction, string> = {
  assignment: '分配处理人',
  reassignment: '改派处理人',
  transfer: '跨组转派',
  handover: '交接处理人',
  resolve: '标记已解决',
  reject: '退回处理',
  close: '确认关闭',
}
const eventLabels: Record<TimelineItem['type'], string> = {
  CREATED: '创建工单',
  ASSIGNED: '分配处理人',
  REASSIGNED: '改派处理人',
  TRANSFERRED: '跨组转派',
  HANDED_OVER: '交接处理人',
  RESOLVED: '标记已解决',
  REJECTED: '退回处理',
  CLOSED: '确认关闭',
  COMMENT: '添加评论',
}
const statuses: Record<TicketStatus, string> = {
  PENDING: '待分配',
  IN_PROGRESS: '处理中',
  RESOLVED: '已解决',
  CLOSED: '已关闭',
}
const canComment = computed(() =>
  props.ticket.allowedActions.includes('comment'),
)
const availableActions = computed<WorkflowAction[]>(() =>
  (Object.keys(labels) as WorkflowAction[]).filter((action) =>
    props.ticket.allowedActions.includes(action),
  ),
)
const assignment = computed(
  () => action.value === 'assignment' || action.value === 'reassignment'
    || action.value === 'handover'
    || (action.value === 'transfer' && props.ticket.status === 'IN_PROGRESS'),
)
const routing = computed(() => action.value === 'transfer' || action.value === 'handover')
const canChooseGroup = computed(() => routing.value && props.user.role === 'ADMIN')
const groupOptions = computed(() => groups.value
  .filter(group => action.value !== 'transfer' || group.id !== props.ticket.supportGroup.id)
  .map(group => ({ label: group.name, value: group.id })))
const targetGroupName = computed(() => groups.value.find(group => group.id === groupId.value)?.name
  ?? (groupId.value === props.ticket.supportGroup.id ? props.ticket.supportGroup.name : '目标客服组'))
const messageField = computed(() =>
  action.value === 'resolve' ? 'resolution' : 'reason',
)
const messageLabel = computed(() =>
  action.value === 'resolve'
    ? '解决说明'
    : action.value === 'reject'
    ? '退回原因'
    : action.value === 'transfer'
    ? '转派原因'
    : action.value === 'handover'
    ? '交接原因'
    : '改派原因',
)
const maxLength = computed(() =>
  action.value === 'resolve' ? 2000 : action.value === 'reject' ? 1000 : 500,
)
const agentOptions = computed(() =>
  agents.value
    .filter((agent) => groupId.value !== props.ticket.supportGroup.id
      || String(agent.id) !== props.ticket.assignee?.id)
    .map((agent) => ({ label: agent.displayName, value: agent.id })),
)
const locked = computed(() => saving.value || refreshing.value)

function fail(cause: unknown) {
  if (!active) return
  fieldErrors.value = cause instanceof ApiError ? cause.fields : {}
  if (
    cause instanceof ApiError &&
    (cause.status === 401 || cause.status === 403 || cause.status === 404)
  ) {
    items.value = []
    nextBefore.value = null
    agents.value = []
    groups.value = []
    comment.value = ''
    message.value = ''
    action.value = null
    active = false
    emit('inaccessible', cause)
    return
  }
  if (cause instanceof ApiError && cause.code === 'ASSIGNEE_UNAVAILABLE') {
    error.value =
      '当前处理人已不可用，请等待客服交接；已保留退回原因，你也可以取消后通过评论补充问题'
  } else if (cause instanceof ApiError && cause.status === 409) {
    needsRefresh.value = true
    error.value = '工单状态已变化，请刷新后重试'
  } else if (cause instanceof ApiError && cause.status === 400) {
    error.value = '请检查输入内容'
  } else {
    error.value = '操作未确认成功，请刷新工单核对结果后再决定是否重试'
    needsRefresh.value = true
  }
}

async function loadHistory(append = false) {
  if (append && (!nextBefore.value || loadingHistory.value)) return
  const generation = ++historyRequest
  loadingHistory.value = true
  historyError.value = ''
  try {
    const result = await ticketApi.timeline(
      props.ticket.id,
      append ? nextBefore.value! : undefined,
    )
    if (!active || generation !== historyRequest) return
    items.value = append ? [...items.value, ...result.items] : result.items
    nextBefore.value = result.nextBefore
  } catch (cause) {
    if (!active || generation !== historyRequest) return
    if (
      cause instanceof ApiError &&
      (cause.status === 401 || cause.status === 403 || cause.status === 404)
    )
      fail(cause)
    else historyError.value = '时间线加载失败，请重试'
  } finally {
    if (active && generation === historyRequest) loadingHistory.value = false
  }
}

function refresh() {
  if (locked.value) return
  refreshing.value = true
  // The parent refreshes /auth/me first and discards this component's cached data.
  emit('refresh')
}

async function loadActionAgents() {
  const generation = ++agentRequest
  const currentAction = action.value
  const targetGroupId = groupId.value
  agents.value = []
  assigneeId.value = null
  loadingAgents.value = false
  if (!currentAction || !assignment.value || !targetGroupId) return
  loadingAgents.value = true
  try {
    const result = await ticketApi.agents(targetGroupId)
    if (active && generation === agentRequest && action.value === currentAction
      && groupId.value === targetGroupId) agents.value = result
  } catch (cause) {
    if (active && generation === agentRequest && action.value === currentAction) fail(cause)
  } finally {
    if (active && generation === agentRequest) loadingAgents.value = false
  }
}

async function changeGroup(value: string | null) {
  groupId.value = value
  fieldErrors.value = {}
  await loadActionAgents()
}

function closeAction() {
  if (locked.value) return
  action.value = null
  agentRequest++
  groupRequest++
  agents.value = []
  groups.value = []
  loadingAgents.value = false
  loadingGroups.value = false
}

async function openAction(value: WorkflowAction) {
  if (
    locked.value ||
    needsRefresh.value ||
    !availableActions.value.includes(value)
  )
    return
  const generation = ++groupRequest
  agentRequest++
  action.value = value
  actionVersion.value = props.ticket.version
  message.value = ''
  assigneeId.value = null
  groupId.value = value === 'transfer' ? null : props.ticket.supportGroup.id
  groups.value = []
  agents.value = []
  loadingAgents.value = false
  loadingGroups.value = false
  error.value = ''
  success.value = ''
  fieldErrors.value = {}
  if (canChooseGroup.value) {
    loadingGroups.value = true
    try {
      const result = await ticketApi.supportGroups()
      if (!active || generation !== groupRequest || action.value !== value) return
      groups.value = result
      if (groupId.value && !result.some(group => group.id === groupId.value)) groupId.value = null
    } catch (cause) {
      if (active && generation === groupRequest && action.value === value) fail(cause)
      return
    } finally {
      if (active && generation === groupRequest) loadingGroups.value = false
    }
  }
  if (active && generation === groupRequest && action.value === value) await loadActionAgents()
}

async function submitAction() {
  if (
    !action.value ||
    locked.value ||
    loadingAgents.value || loadingGroups.value ||
    needsRefresh.value ||
    !availableActions.value.includes(action.value)
  )
    return
  fieldErrors.value = {}
  if (routing.value && !groupId.value) fieldErrors.value.groupId = '请选择目标客服组'
  if (assignment.value && assigneeId.value === null)
    fieldErrors.value.assigneeId = '请选择处理人'
  if (action.value !== 'assignment' && action.value !== 'close') {
    const length = Array.from(message.value.trim()).length
    if (length < 1 || length > maxLength.value)
      fieldErrors.value[
        messageField.value
      ] = `请输入 1～${maxLength.value} 个字符`
  }
  if (Object.keys(fieldErrors.value).length) return
  const currentAction = action.value
  saving.value = true
  emit('busy', true)
  error.value = ''
  try {
    const id = props.ticket.id
    const version = actionVersion.value
    let result: Ticket
    switch (currentAction) {
      case 'assignment':
        result = await ticketApi.assign(id, version, assigneeId.value!)
        break
      case 'reassignment':
        result = await ticketApi.reassign(
          id,
          version,
          assigneeId.value!,
          message.value,
        )
        break
      case 'transfer':
        result = await ticketApi.transfer(id, version, Number(groupId.value), assigneeId.value, message.value)
        break
      case 'handover':
        result = await ticketApi.handover(id, version, Number(groupId.value), assigneeId.value, message.value)
        break
      case 'resolve':
        result = await ticketApi.resolve(id, version, message.value)
        break
      case 'reject':
        result = await ticketApi.reject(id, version, message.value)
        break
      case 'close':
        result = await ticketApi.close(id, version)
        break
    }
    if (!active) return
    emit('updated', result)
    action.value = null
    success.value = `${labels[currentAction]}成功`
    await loadHistory()
  } catch (cause) {
    fail(cause)
  } finally {
    if (active) {
      saving.value = false
      emit('busy', false)
    }
  }
}

async function submitComment() {
  if (locked.value || needsRefresh.value || !canComment.value) return
  const length = Array.from(comment.value.trim()).length
  fieldErrors.value = {}
  if (length < 1 || length > 1000) {
    fieldErrors.value.body = '请输入 1～1000 个字符'
    return
  }
  saving.value = true
  emit('busy', true)
  error.value = ''
  success.value = ''
  try {
    const result = await ticketApi.comment(props.ticket.id, comment.value)
    if (!active) return
    emit('updated', result)
    comment.value = ''
    success.value = '评论已发布'
    await loadHistory()
  } catch (cause) {
    fail(cause)
  } finally {
    if (active) {
      saving.value = false
      emit('busy', false)
    }
  }
}

function time(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

onMounted(() => loadHistory())
onUnmounted(() => {
  active = false
  historyRequest++
  agentRequest++
  groupRequest++
})
</script>

<template>
  <section class="workflow-section" aria-label="工单处理">
    <div class="workflow-heading">
      <h3>工单处理</h3>
      <NSpace align="center">
        <NText depth="3">版本 {{ ticket.version }}</NText>
        <NButton
          secondary
          :loading="refreshing"
          :disabled="saving"
          @click="refresh"
          >刷新工单</NButton
        >
      </NSpace>
    </div>
    <NAlert
      v-if="error && !action"
      type="error"
      class="page-alert"
      role="alert"
      >{{ error }}</NAlert
    >
    <NAlert
      v-if="success"
      type="success"
      closable
      class="page-alert"
      @close="success = ''"
      >{{ success }}</NAlert
    >
    <NSpace v-if="availableActions.length" class="workflow-actions">
      <NButton
        v-for="operation in availableActions"
        :key="operation"
        :type="operation === 'reject' ? 'warning' : 'primary'"
        :disabled="locked || needsRefresh"
        @click="openAction(operation)"
        >{{ labels[operation] }}</NButton
      >
    </NSpace>
    <NText v-if="ticket.status === 'CLOSED'" depth="3"
      >已关闭 · {{ ticket.assignee?.displayName }}</NText
    >
    <NForm
      v-if="canComment"
      class="comment-form"
      @submit.prevent="submitComment"
    >
      <NFormItem
        label="评论"
        :feedback="fieldErrors.body"
        :validation-status="fieldErrors.body ? 'error' : undefined"
      >
        <NInput
          v-model:value="comment"
          type="textarea"
          :disabled="locked"
          :input-props="{ 'aria-label': '评论内容' }"
          :autosize="{ minRows: 3, maxRows: 10 }"
          placeholder="补充问题或处理进展"
        />
      </NFormItem>
      <NButton
        attr-type="submit"
        type="primary"
        :loading="saving"
        :disabled="locked || needsRefresh"
        >发布评论</NButton
      >
    </NForm>
  </section>

  <section class="workflow-section" aria-label="沟通与操作记录">
    <div class="workflow-heading"><h3>沟通与操作记录</h3></div>
    <NAlert v-if="historyError" type="error" class="page-alert">
      {{ historyError }}
      <NButton text :disabled="loadingHistory" @click="loadHistory(false)"
        >重试</NButton
      >
    </NAlert>
    <NSpin :show="loadingHistory">
      <NTimeline v-if="items.length" class="ticket-timeline">
        <NTimelineItem
          v-for="item in items"
          :key="item.id"
          :title="`${item.actor.displayName} · ${eventLabels[item.type]}`"
          :time="time(item.createdAt)"
          :type="
            item.type === 'COMMENT'
              ? 'default'
              : item.type === 'REJECTED'
              ? 'warning'
              : 'success'
          "
        >
          <div v-if="item.toStatus" class="timeline-change">
            {{ item.fromStatus ? statuses[item.fromStatus] + ' → ' : ''
            }}{{ statuses[item.toStatus] }}
          </div>
          <div
            v-if="item.fromGroup || item.toGroup"
            class="timeline-change"
          >
            客服组：{{ item.fromGroup?.name ?? '未设置' }} → {{ item.toGroup?.name ?? '未设置' }}
          </div>
          <div
            v-if="['ASSIGNED', 'REASSIGNED', 'TRANSFERRED', 'HANDED_OVER'].includes(item.type)"
            class="timeline-change"
          >
            {{ item.fromAssignee?.displayName ?? '未分配' }} →
            {{ item.toAssignee?.displayName ?? '未分配' }}
          </div>
          <p v-if="item.message" class="timeline-message">{{ item.message }}</p>
        </NTimelineItem>
      </NTimeline>
      <NEmpty
        v-else-if="!loadingHistory && !historyError"
        description="暂无记录"
      />
    </NSpin>
    <NButton
      v-if="nextBefore"
      secondary
      :loading="loadingHistory"
      :disabled="locked"
      @click="loadHistory(true)"
      >加载更早记录</NButton
    >
  </section>

  <NModal
    :show="action !== null"
    preset="card"
    :title="action ? labels[action] : ''"
    class="workflow-modal"
    :closable="!locked"
    :mask-closable="!locked"
    :close-on-esc="!locked"
    @update:show="
      (value) => {
        if (!value) closeAction()
      }
    "
  >
    <NAlert v-if="error" type="error" class="page-alert" role="alert">{{
      error
    }}</NAlert>
    <NForm @submit.prevent="submitAction">
      <NAlert v-if="routing" type="info" class="page-alert">
        <template v-if="action === 'transfer' && ticket.status === 'PENDING'">转派后仍为待分配，由目标客服组安排处理人。</template>
        <template v-else-if="action === 'handover'">为不可用的原处理人安排交接，保留工单当前状态。{{ user.role === 'ADMIN' ? '可选择目标客服组。' : '仅可交接给当前客服组成员。' }}</template>
        <template v-else>选择目标客服组及处理人，转派后继续处理。</template>
      </NAlert>
      <NFormItem
        v-if="canChooseGroup"
        label="目标客服组"
        required
        :feedback="fieldErrors.groupId"
        :validation-status="fieldErrors.groupId ? 'error' : undefined"
      >
        <NSelect
          :value="groupId"
          :options="groupOptions"
          :loading="loadingGroups"
          :disabled="locked || loadingGroups"
          placeholder="请选择目标客服组"
          @update:value="changeGroup"
        />
      </NFormItem>
      <NFormItem
        v-if="assignment"
        :label="`${targetGroupName} · 处理人`"
        required
        :feedback="fieldErrors.assigneeId"
        :validation-status="fieldErrors.assigneeId ? 'error' : undefined"
      >
        <NSelect
          v-model:value="assigneeId"
          :options="agentOptions"
          :loading="loadingAgents"
          :disabled="locked || loadingAgents || loadingGroups || !groupId"
          placeholder="请选择处理人"
        />
      </NFormItem>
      <NText v-if="assignment && groupId && !loadingAgents && !loadingGroups && !agentOptions.length" depth="3" class="candidate-empty">
        当前客服组没有可选处理人，请联系管理员核对成员状态。
      </NText>
      <NFormItem
        v-if="action && action !== 'assignment' && action !== 'close'"
        :label="messageLabel"
        required
        :feedback="fieldErrors[messageField]"
        :validation-status="fieldErrors[messageField] ? 'error' : undefined"
      >
        <NInput
          v-model:value="message"
          type="textarea"
          :disabled="locked"
          :input-props="{ 'aria-label': messageLabel }"
          :autosize="{ minRows: 4, maxRows: 10 }"
          :placeholder="messageLabel"
        />
      </NFormItem>
      <NAlert v-if="action === 'close'" type="warning" class="page-alert"
        >确认问题已解决？关闭后无法继续评论或重新打开。</NAlert
      >
      <NSpace justify="end">
        <NButton :disabled="locked" @click="closeAction">取消</NButton>
        <NButton
          v-if="needsRefresh"
          type="primary"
          :loading="refreshing"
          :disabled="saving"
          @click="refresh"
          >刷新工单</NButton
        >
        <NButton
          v-else
          attr-type="submit"
          type="primary"
          :loading="saving"
          :disabled="locked || loadingAgents || loadingGroups"
        >
          {{ action ? labels[action] : '确认' }}
        </NButton>
      </NSpace>
    </NForm>
  </NModal>
</template>

<style scoped>
.workflow-section {
  margin-top: 28px;
  padding-top: 24px;
  border-top: 1px solid #e0e8e3;
}
.workflow-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 20px;
}
.workflow-heading h3 {
  font-size: 15px;
}
.workflow-actions {
  margin-bottom: 20px;
}
.comment-form {
  margin-top: 20px;
}
.candidate-empty {
  display: block;
  margin: -8px 0 20px;
}
.ticket-timeline {
  min-height: 80px;
  padding: 4px 0;
}
.timeline-message {
  margin: 8px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.8;
}
.timeline-change {
  color: #6c766f;
  font-size: 12px;
  line-height: 1.8;
}
:global(.workflow-modal) {
  width: min(520px, calc(100vw - 32px));
  border-radius: 6px;
}
.ticket-timeline :deep(.n-timeline-item-content__title) {
  overflow-wrap: anywhere;
}
</style>
