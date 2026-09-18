<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NModal, NSpace } from 'naive-ui'
import { ApiError } from '../api'
import { adminApi, passwordProblem } from '../admin-api'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  'update:show': [value: boolean]
  changed: []
  inaccessible: [cause: unknown]
  busy: [value: boolean]
}>()
const currentPassword = ref('')
const newPassword = ref('')
const confirmation = ref('')
const error = ref('')
const busy = ref(false)
let alive = true
function clear() { currentPassword.value = ''; newPassword.value = ''; confirmation.value = ''; error.value = '' }
watch(() => props.show, clear)
onBeforeUnmount(() => { alive = false; clear(); emit('busy', false) })
function close() { if (!busy.value) { clear(); emit('update:show', false) } }
async function submit() {
  if (busy.value) return
  error.value = !currentPassword.value ? '请输入当前密码' : passwordProblem(newPassword.value)
  if (!error.value && confirmation.value !== newPassword.value) error.value = '两次新密码不一致'
  if (error.value) return
  busy.value = true; emit('busy', true)
  try {
    await adminApi.changePassword(currentPassword.value, newPassword.value)
    if (!alive) return
    clear(); emit('update:show', false); emit('changed')
  } catch (cause) {
    if (!alive) return
    clear()
    if (cause instanceof ApiError && cause.status === 401 && cause.code !== 'INVALID_CREDENTIALS') {
      emit('inaccessible', cause)
    } else if (cause instanceof ApiError) {
      error.value = cause.fields.currentPassword ? '当前密码不正确，请重新输入'
        : cause.fields.newPassword ? '新密码需与当前密码不同，且至少 12 个字符、最多 72 个 UTF-8 字节'
        : cause.message
    } else error.value = '网络连接失败，请核对密码是否已修改；如已失去登录状态，请使用新密码登录'
  } finally { busy.value = false; emit('busy', false) }
}
</script>

<template>
  <NModal :show="show" :mask-closable="!busy" :close-on-esc="!busy" @update:show="close">
    <NCard title="修改密码" role="dialog" aria-modal="true" class="admin-dialog" :closable="!busy" @close="close">
      <NAlert type="info" class="form-alert">修改成功后，当前账号的所有登录会话将退出，需要使用新密码重新登录。</NAlert>
      <NAlert v-if="error" type="error" class="form-alert" role="alert">{{ error }}</NAlert>
      <NForm data-testid="password-form" :disabled="busy" @submit.prevent="submit">
        <NFormItem label="当前密码" required><NInput v-model:value="currentPassword" type="password" autocomplete="current-password" show-password-on="click" /></NFormItem>
        <NFormItem label="新密码" required feedback="至少 12 个字符，最多 72 个 UTF-8 字节"><NInput v-model:value="newPassword" type="password" autocomplete="new-password" show-password-on="click" /></NFormItem>
        <NFormItem label="确认新密码" required><NInput v-model:value="confirmation" type="password" autocomplete="new-password" show-password-on="click" /></NFormItem>
        <NSpace justify="end"><NButton :disabled="busy" @click="close">取消</NButton><NButton type="primary" attr-type="submit" :loading="busy">修改并重新登录</NButton></NSpace>
      </NForm>
    </NCard>
  </NModal>
</template>
