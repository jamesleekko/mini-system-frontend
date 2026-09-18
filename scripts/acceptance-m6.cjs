#!/usr/bin/env node
'use strict'

/**
 * M6 browser acceptance against a disposable database prepared by the backend runner.
 * No servers, database instances, dependencies, or production data are managed here.
 * Required: M6_ACCEPTANCE_CONFIRM=isolated-test-database, M6_ACCEPTANCE_BASE_URL,
 * M6_ACCEPTANCE_PASSWORD. Optional: M6_ACCEPTANCE_ARTIFACT_DIR,
 * PLAYWRIGHT_MODULE_PATH and PLAYWRIGHT_CHROMIUM_EXECUTABLE.
 * The fixture must be fresh: the emergency handover scenario disables its G1 agent.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const baseURL = process.env.M6_ACCEPTANCE_BASE_URL
const password = process.env.M6_ACCEPTANCE_PASSWORD
if (process.env.M6_ACCEPTANCE_CONFIRM !== 'isolated-test-database' || !baseURL || !password) {
  console.error('Set M6_ACCEPTANCE_CONFIRM=isolated-test-database, M6_ACCEPTANCE_BASE_URL and M6_ACCEPTANCE_PASSWORD. A fresh isolated fixture is required.')
  process.exit(2)
}
const target = new URL(baseURL)
assert(['http:', 'https:'].includes(target.protocol), 'HTTP(S) base URL required')
assert(!target.username && !target.password, 'Do not put credentials in the base URL')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '')
const prefix = `M6.5-${runId}`
const artifactDir = path.resolve(process.env.M6_ACCEPTANCE_ARTIFACT_DIR || `artifacts/m6.5-${runId}`)
const result = { runId, startedAt: new Date().toISOString(), baseURL: target.origin,
  status: 'running', scenarios: [], screenshots: [], pageErrors: [] }
const actors = new Map()
let browser
let currentPage

async function api(actor, method, endpoint, data, expectedStatus) {
  const response = await actor.context.request.fetch(`/api/v1${endpoint}`, { method, data })
  const body = await response.json()
  if (expectedStatus !== undefined) assert.equal(response.status(), expectedStatus, `${method} ${endpoint} status`)
  else assert(response.ok(), `${method} ${endpoint}: HTTP ${response.status()} ${body.code || ''}`)
  return body.data
}

async function settle(page) {
  await page.waitForLoadState('networkidle')
  // Wait for Vue/Naive UI transitions and web fonts before visual evidence.
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.allSettled(document.getAnimations()
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

async function screenshot(page, name) {
  await settle(page)
  await page.screenshot({ path: path.join(artifactDir, name), fullPage: true })
  result.screenshots.push(name)
}

async function step(name, work) {
  const entry = { name, status: 'running' }
  result.scenarios.push(entry)
  const started = Date.now()
  try {
    await work()
    entry.status = 'passed'
  } catch (error) {
    entry.status = 'failed'
    throw error
  } finally {
    entry.durationMs = Date.now() - started
  }
}

async function actor(username, options = {}) {
  if (actors.has(username)) return actors.get(username)
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => result.pageErrors.push({ account: username, message: error.message }))
  const item = { context, page, username }
  actors.set(username, item)
  currentPage = page
  if (options.ui) {
    await page.goto('/')
    await page.getByPlaceholder('请输入账号', { exact: true }).fill(username)
    await page.getByPlaceholder('请输入密码', { exact: true }).fill(options.password || password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).waitFor()
    await settle(page)
    item.identity = await api(item, 'GET', '/auth/me')
  } else {
    item.identity = await api(item, 'POST', '/auth/login', { username, password: options.password || password })
    await page.goto('/')
    await page.getByRole('button', { name: '退出登录', exact: true }).waitFor()
    await settle(page)
  }
  return item
}

async function list(actor, title) {
  return api(actor, 'GET', `/tickets?keyword=${encodeURIComponent(title)}&page=1&pageSize=20`)
}

async function verifyVisible(actor, ticket, visible) {
  const found = await list(actor, ticket.title)
  assert.equal(found.items.some(item => item.id === ticket.id), visible, `${actor.username} list visibility`)
  if (!visible) {
    await api(actor, 'GET', `/tickets/${ticket.id}`, undefined, 404)
    await api(actor, 'GET', `/tickets/${ticket.id}/timeline`, undefined, 404)
  }
}

async function openTicket(actor, ticket) {
  const page = actor.page
  currentPage = page
  await page.goto('/')
  await page.getByPlaceholder('标题或工单编号').fill(ticket.title)
  const response = page.waitForResponse(response => response.url().includes('/api/v1/tickets?')
    && new URL(response.url()).searchParams.get('keyword') === ticket.title)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  assert((await response).ok(), 'Ticket search failed')
  await page.getByRole('link', { name: ticket.title, exact: true }).click()
  await page.getByRole('heading', { name: ticket.title, exact: true }).waitFor()
  await settle(page)
}

async function selectOption(page, placeholder, label) {
  await page.locator('.n-base-selection:not(.n-base-selection--disabled)')
    .filter({ has: page.getByText(placeholder, { exact: true }) }).click()
  await page.locator('.n-base-select-option').filter({ hasText: label }).click()
}

async function action(actor, ticket, endpoint, label, fill) {
  const page = actor.page
  currentPage = page
  await page.getByRole('button', { name: label, exact: true }).click()
  const modal = page.locator('.workflow-modal')
  await modal.waitFor({ state: 'visible' })
  if (fill) await fill(page, modal)
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/tickets/${ticket.id}/${endpoint}`
    && response.request().method() === 'POST')
  await modal.getByRole('button', { name: label, exact: true }).click()
  const response = await responsePromise
  const body = await response.json()
  assert(response.ok(), `${label}: HTTP ${response.status()} ${body.code || ''}`)
  await modal.waitFor({ state: 'hidden' })
  await settle(page)
  return body.data
}

async function create(actor, suffix) {
  return api(actor, 'POST', '/tickets', { title: `${prefix}-${suffix}`,
    description: '独立测试数据库的 M6 总体验收工单。', category: 'BUG', priority: 'NORMAL' }, 201)
}

async function main() {
  await fs.mkdir(artifactDir, { recursive: true })
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
  let memberA, managerA, managerB, leadG1, agentG1, leadG2, platform, lifecycle, transfer, handover

  await step('商户成员通过页面登录、新建工单并由服务端绑定组织', async () => {
    memberA = await actor('m6-merchant-a-member', { ui: true })
    const page = memberA.page
    await page.getByRole('heading', { name: '我提交的工单', exact: true }).waitFor()
    await page.getByRole('button', { name: '新建工单', exact: true }).click()
    await page.getByPlaceholder('简要描述你遇到的问题').fill(`${prefix}-处理闭环`)
    await page.getByPlaceholder('问题发生的场景、实际表现及预期结果').fill('商户 A 的接口联调反馈，用于验证分配、解决、退回和验收关闭。')
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/tickets'
      && response.request().method() === 'POST')
    await page.getByRole('button', { name: '提交工单', exact: true }).click()
    const response = await responsePromise
    assert.equal(response.status(), 201)
    lifecycle = (await response.json()).data
    assert.equal(lifecycle.merchant.id, memberA.identity.merchant.id)
    assert.equal(lifecycle.supportGroup.id, memberA.identity.merchant.defaultSupportGroupId)
    assert.equal(lifecycle.status, 'PENDING')
    await page.getByRole('heading', { name: lifecycle.title, exact: true }).waitFor()
    await screenshot(page, '01-merchant-created.png')
  })

  await step('同商户管理员可见、普通成员仅本人可见、跨商户列表详情及时间线隔离', async () => {
    managerA = await actor('m6-merchant-a-admin')
    managerB = await actor('m6-merchant-b-admin')
    const memberB = await actor('m6-merchant-b-member')
    const otherTicketA = await create(managerA, '商户管理员自建')
    const ticketB = await create(memberB, '商户B')
    await verifyVisible(managerA, lifecycle, true)
    await verifyVisible(memberA, otherTicketA, false)
    await verifyVisible(managerB, ticketB, true)
    await verifyVisible(managerB, lifecycle, false)
    await verifyVisible(memberB, lifecycle, false)
    await verifyVisible(memberA, ticketB, false)
    await openTicket(managerA, lifecycle)
    assert.equal(await managerA.page.getByRole('button', { name: '分配处理人', exact: true }).count(), 0)
  })

  await step('组长分配、客服解决、商户管理员退回及确认关闭的页面闭环', async () => {
    leadG1 = await actor('m6-support-g1-lead')
    agentG1 = await actor('m6-support-g1-agent')
    leadG2 = await actor('m6-support-g2-lead')
    await verifyVisible(agentG1, lifecycle, false)
    await verifyVisible(leadG2, lifecycle, false)
    await openTicket(leadG1, lifecycle)
    lifecycle = await action(leadG1, lifecycle, 'assignment', '分配处理人', page =>
      selectOption(page, '请选择处理人', '客服组 G1 客服'))
    assert.equal(lifecycle.status, 'IN_PROGRESS')
    assert.equal(String(lifecycle.assignee.id), String(agentG1.identity.id))
    await openTicket(agentG1, lifecycle)
    assert.equal(await agentG1.page.getByRole('button', { name: '改派处理人', exact: true }).count(), 0)
    lifecycle = await action(agentG1, lifecycle, 'resolve', '标记已解决', page =>
      page.getByRole('textbox', { name: '解决说明', exact: true }).fill('已修复接口参数，请商户复核。'))
    assert.equal(lifecycle.status, 'RESOLVED')
    await openTicket(managerA, lifecycle)
    lifecycle = await action(managerA, lifecycle, 'reject', '退回处理', page =>
      page.getByRole('textbox', { name: '退回原因', exact: true }).fill('仍存在一处联调问题，请继续处理。'))
    assert.equal(lifecycle.status, 'IN_PROGRESS')
    await openTicket(agentG1, lifecycle)
    lifecycle = await action(agentG1, lifecycle, 'resolve', '标记已解决', page =>
      page.getByRole('textbox', { name: '解决说明', exact: true }).fill('已完成二次修复并验证。'))
    await openTicket(managerA, lifecycle)
    lifecycle = await action(managerA, lifecycle, 'close', '确认关闭')
    assert.equal(lifecycle.status, 'CLOSED')
    assert.equal(await managerA.page.getByRole('button', { name: '发布评论', exact: true }).count(), 0)
    const timeline = await api(managerA, 'GET', `/tickets/${lifecycle.id}/timeline`)
    for (const type of ['CREATED', 'ASSIGNED', 'RESOLVED', 'REJECTED', 'CLOSED'])
      assert(timeline.items.some(item => item.type === type), `Missing ${type} event`)
    await screenshot(managerA.page, '02-merchant-manager-closed.png')
  })

  await step('平台管理员跨组转派、原组权限收回、目标组和跨组客服权限正确', async () => {
    platform = await actor('m6-platform-admin')
    transfer = await create(memberA, '跨组转派')
    await openTicket(platform, transfer)
    transfer = await action(platform, transfer, 'transfer', '跨组转派', async page => {
      await selectOption(page, '请选择目标客服组', '开发收款支持组')
      await page.getByRole('textbox', { name: '转派原因', exact: true }).fill('收款问题由 G2 接手。')
    })
    assert.equal(transfer.status, 'PENDING')
    assert.equal(transfer.assignee, null)
    assert.equal(transfer.supportGroup.id, leadG2.identity.supportGroups[0].id)
    await verifyVisible(leadG1, transfer, false)
    await verifyVisible(leadG2, transfer, true)
    const dual = await actor('m6-support-dual')
    const agentG2 = await actor('m6-support-g2-agent')
    await verifyVisible(dual, transfer, false)
    await verifyVisible(agentG2, transfer, false)
    await openTicket(leadG2, transfer)
    await screenshot(leadG2.page, '03-transferred-target-group.png')
  })

  await step('紧急停用撤销旧会话、组长交接保留已解决状态和原解决记录', async () => {
    handover = await create(memberA, '已解决工单交接')
    handover = await api(leadG1, 'POST', `/tickets/${handover.id}/assignment`,
      { version: handover.version, assigneeId: agentG1.identity.id })
    handover = await api(agentG1, 'POST', `/tickets/${handover.id}/resolve`,
      { version: handover.version, resolution: '交接前已经解决，保留本条解决记录。' })
    const before = await api(leadG1, 'GET', `/tickets/${handover.id}/timeline`)
    const originalResolution = before.items.find(item => item.type === 'RESOLVED')
    assert(originalResolution)
    await api(platform, 'POST', `/users/${agentG1.identity.id}/deactivation`,
      { reason: 'M6.5 独立库紧急离岗验收', emergency: true })
    await api(agentG1, 'GET', '/auth/me', undefined, 401)
    await agentG1.page.reload()
    await agentG1.page.getByRole('heading', { name: '登录工作台', exact: true }).waitFor()
    await openTicket(leadG1, handover)
    handover = await action(leadG1, handover, 'handover', '交接处理人', async page => {
      await selectOption(page, '请选择处理人', '跨组客服')
      await page.getByRole('textbox', { name: '交接原因', exact: true }).fill('原处理人停用，由跨组客服跟进商户验收。')
    })
    assert.equal(handover.status, 'RESOLVED')
    assert.equal(handover.assignee.displayName, '跨组客服')
    const after = await api(leadG1, 'GET', `/tickets/${handover.id}/timeline`)
    assert.deepEqual(after.items.find(item => item.id === originalResolution.id), originalResolution)
    assert(after.items.some(item => item.type === 'HANDED_OVER'))
    await screenshot(leadG1.page, '04-resolved-ticket-handover.png')
  })

  await step('390px 商户详情与列表布局不超出页面，保留可操作入口', async () => {
    await memberA.page.setViewportSize({ width: 390, height: 844 })
    await openTicket(memberA, handover)
    assert(await memberA.page.getByRole('button', { name: '确认关闭', exact: true }).isVisible())
    await settle(memberA.page)
    assert(await memberA.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile detail overflows viewport')
    await screenshot(memberA.page, '05-mobile-detail.png')
    await memberA.page.getByRole('button', { name: '返回列表', exact: true }).click()
    await settle(memberA.page)
    assert(await memberA.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile list overflows viewport')
    await screenshot(memberA.page, '06-mobile-list.png')
  })

  await step('退出失败立即隐藏数据、刷新仍保持待退出、重试成功注销', async () => {
    const page = managerA.page
    currentPage = page
    await openTicket(managerA, handover)
    const blockLogout = route => route.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ code: 'ACCEPTANCE_SIMULATED_FAILURE', message: '验收模拟退出故障' }) })
    await page.route('**/api/v1/auth/logout', blockLogout)
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('heading', { name: '退出尚未完成', exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: handover.title, exact: true }).count(), 0)
    await page.reload()
    await page.getByRole('heading', { name: '退出尚未完成', exact: true }).waitFor()
    assert.equal(await page.locator('.workspace').count(), 0)
    await screenshot(page, '07-logout-pending.png')
    await page.unroute('**/api/v1/auth/logout', blockLogout)
    await page.getByRole('button', { name: '重试退出', exact: true }).click()
    await page.getByRole('heading', { name: '登录工作台', exact: true }).waitFor()
    await api(managerA, 'GET', '/auth/me', undefined, 401)
  })

  await step('未配置组织的旧账号展示提示且不显示工单内容', async () => {
    const legacy = await actor('requester-a', { ui: true, password: 'Demo@12345' })
    await legacy.page.getByText('暂未配置访问范围', { exact: true }).waitFor()
    assert.equal(await legacy.page.getByRole('button', { name: '新建工单', exact: true }).count(), 0)
    assert.equal(await legacy.page.locator('.ticket-link').count(), 0)
    await screenshot(legacy.page, '08-unconfigured-identity.png')
  })

  await step('全部浏览器会话无未处理页面异常', async () => assert.deepEqual(result.pageErrors, []))
  result.status = 'passed'
}

main().catch(async error => {
  result.status = 'failed'
  // No request bodies, cookies, environment variables, or password values in artifacts.
  result.error = String(error.stack || error).split(password).join('[REDACTED]')
  if (currentPage && !currentPage.isClosed()) {
    try {
      await currentPage.screenshot({ path: path.join(artifactDir, 'failure.png'), fullPage: true })
      result.screenshots.push('failure.png')
    } catch { /* Preserve the original failure. */ }
  }
  process.exitCode = 1
}).finally(async () => {
  for (const item of actors.values()) await item.context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  result.finishedAt = new Date().toISOString()
  await fs.mkdir(artifactDir, { recursive: true })
  await fs.writeFile(path.join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ status: result.status, scenarios: result.scenarios, artifactDir }))
})
