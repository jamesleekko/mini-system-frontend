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
  Ticket,
  TicketStatus,
  TimelineItem,
  WorkflowAction,
} from '../api';
import {
  ApiError,
  ticketApi,
} from '../api';

const props = defineProps<{ ticket: Ticket }>()
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
const needsRefresh = ref(false)
const error = ref('')
const historyError = ref('')
const success = ref('')
const fieldErrors = ref<Record<string, string>>({})
const comment = ref('')
const message = ref('')
const assigneeId = ref<number | null>(null)
const agents = ref<AgentCandidate[]>([])
const items = ref<TimelineItem[]>([])
const nextBefore = ref<string | null>(null)
let active = true
let historyRequest = 0
let agentRequest = 0

const labels: Record<WorkflowAction, string> = {
  assignment: '分配处理人',
  reassignment: '改派处理人',
  resolve: '标记已解决',
  reject: '退回处理',
  close: '确认关闭',
}
const eventLabels: Record<TimelineItem['type'], string> = {
  CREATED: '创建工单',
  ASSIGNED: '分配处理人',
  REASSIGNED: '改派处理人',
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
  () => action.value === 'assignment' || action.value === 'reassignment',
)
const messageField = computed(() =>
  action.value === 'resolve' ? 'resolution' : 'reason',
)
const messageLabel = computed(() =>
  action.value === 'resolve'
    ? '解决说明'
    : action.value === 'reject'
    ? '退回原因'
    : '改派原因',
)
const maxLength = computed(() =>
  action.value === 'resolve' ? 2000 : action.value === 'reject' ? 1000 : 500,
)
const agentOptions = computed(() =>
  agents.value
    .filter((agent) => String(agent.id) !== props.ticket.assignee?.id)
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

async function openAction(value: WorkflowAction) {
  if (
    locked.value ||
    needsRefresh.value ||
    !availableActions.value.includes(value)
  )
    return
  const generation = ++agentRequest
  action.value = value
  actionVersion.value = props.ticket.version
  message.value = ''
  assigneeId.value = null
  error.value = ''
  success.value = ''
  fieldErrors.value = {}
  if (assignment.value) {
    agents.value = []
    loadingAgents.value = true
    try {
      const result = await ticketApi.agents(props.ticket.supportGroup.id)
      if (active && generation === agentRequest && action.value === value)
        agents.value = result
    } catch (cause) {
      if (active && generation === agentRequest && action.value === value)
        fail(cause)
    } finally {
      if (active && generation === agentRequest) loadingAgents.value = false
    }
  }
}

async function submitAction() {
  if (
    !action.value ||
    locked.value ||
    needsRefresh.value ||
    !availableActions.value.includes(action.value)
  )
    return
  fieldErrors.value = {}
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
            v-if="item.type === 'ASSIGNED' || item.type === 'REASSIGNED'"
            class="timeline-change"
          >
            {{ item.fromAssignee?.displayName ?? '未分配' }} →
            {{ item.toAssignee?.displayName }}
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
        if (!value && !locked) action = null
      }
    "
  >
    <NAlert v-if="error" type="error" class="page-alert" role="alert">{{
      error
    }}</NAlert>
    <NForm @submit.prevent="submitAction">
      <NFormItem
        v-if="assignment"
        :label="`${ticket.supportGroup.name} · 处理人`"
        required
        :feedback="fieldErrors.assigneeId"
        :validation-status="fieldErrors.assigneeId ? 'error' : undefined"
      >
        <NSelect
          v-model:value="assigneeId"
          :options="agentOptions"
          :loading="loadingAgents"
          :disabled="locked"
          placeholder="请选择处理人"
        />
      </NFormItem>
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
        <NButton :disabled="locked" @click="action = null">取消</NButton>
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
          :disabled="locked || loadingAgents"
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
