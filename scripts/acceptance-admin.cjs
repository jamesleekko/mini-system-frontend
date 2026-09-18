#!/usr/bin/env node
'use strict'

/**
 * Management-center acceptance against an explicitly isolated test database.
 * Reuses M6 acceptance environment variables; creates only uniquely prefixed fixtures.
 * The caller owns servers and database cleanup. No credentials enter result artifacts.
 */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const baseURL = process.env.M6_ACCEPTANCE_BASE_URL
const password = process.env.M6_ACCEPTANCE_PASSWORD
if (process.env.M6_ACCEPTANCE_CONFIRM !== 'isolated-test-database' || !baseURL || !password) {
  console.error('Set M6_ACCEPTANCE_CONFIRM=isolated-test-database, M6_ACCEPTANCE_BASE_URL and M6_ACCEPTANCE_PASSWORD.')
  process.exit(2)
}
const target = new URL(baseURL)
assert(['http:', 'https:'].includes(target.protocol), 'HTTP(S) base URL required')
assert(!target.username && !target.password, 'Do not put credentials in the base URL')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(3).toString('hex')}`
const prefix = `admin-${runId}`
const artifactDir = path.resolve(process.env.M6_ACCEPTANCE_ARTIFACT_DIR || `artifacts/admin-${runId}`)
const accountPassword = `AdminTest-${crypto.randomBytes(12).toString('hex')}`
const nextPassword = `AdminNext-${crypto.randomBytes(12).toString('hex')}`
const secrets = [password, accountPassword, nextPassword]
const result = { runId, startedAt: new Date().toISOString(), baseURL: target.origin,
  status: 'running', scenarios: [], screenshots: [], pageErrors: [] }
const actors = []
let browser
let currentPage

function redact(value) {
  let text = String(value)
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
  return text
}

async function api(actor, method, endpoint, data, expectedStatus) {
  const response = await actor.context.request.fetch(`/api/v1${endpoint}`, { method, data })
  const body = await response.json()
  if (expectedStatus !== undefined) assert.equal(response.status(), expectedStatus, `${method} ${endpoint} status`)
  else assert(response.ok(), `${method} ${endpoint}: HTTP ${response.status()} ${body.code || ''}`)
  return body.data
}

async function settle(page) {
  await page.waitForLoadState('networkidle')
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
  // Keep secrets masked even if a password reveal control was toggled during debugging.
  await page.screenshot({ path: path.join(artifactDir, name), fullPage: true,
    mask: [page.locator('input[type="password"], input[autocomplete="new-password"], input[autocomplete="current-password"]')] })
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
  } finally { entry.durationMs = Date.now() - started }
}

async function actor(username, loginPassword, ui = false) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => result.pageErrors.push({ account: username, message: redact(error.message) }))
  const item = { username, context, page }
  actors.push(item)
  currentPage = page
  if (ui) await loginPage(item, loginPassword)
  else {
    item.identity = await api(item, 'POST', '/auth/login', { username, password: loginPassword })
    await page.goto('/')
    await page.getByRole('button', { name: '退出登录', exact: true }).waitFor()
  }
  return item
}

async function loginPage(item, loginPassword) {
  currentPage = item.page
  await item.page.goto('/')
  await item.page.getByPlaceholder('请输入账号', { exact: true }).fill(item.username)
  await item.page.getByPlaceholder('请输入密码', { exact: true }).fill(loginPassword)
  await item.page.getByRole('button', { name: '登录', exact: true }).click()
  await item.page.getByRole('button', { name: '退出登录', exact: true }).waitFor()
  item.identity = await api(item, 'GET', '/auth/me')
  await settle(item.page)
}

async function submit(page, endpoint, action) {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${endpoint}`
    && response.request().method() === 'POST')
  await action()
  const response = await responsePromise
  const body = await response.json()
  assert(response.ok(), `${endpoint}: HTTP ${response.status()} ${body.code || ''}`)
  await settle(page)
  return body.data
}

async function namedItem(actor, resource, code) {
  const page = await api(actor, 'GET', `/admin/${resource}?keyword=${encodeURIComponent(code)}&pageSize=100`)
  const item = page.items.find(value => value.code === code || value.username === code)
  assert(item, `${resource}: expected newly created item`)
  return item
}

async function main() {
  await fs.mkdir(artifactDir, { recursive: true })
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
  let platform, merchantUser, account, merchant, firstGroup, secondGroup, otherTicket
  const reason = `独立数据库管理中心验收 ${prefix}`

  await step('管理员通过页面进入管理中心并创建商户账号', async () => {
    platform = await actor('m6-platform-admin', password, true)
    await openAdmin(platform.page)
    account = await createAccountUI(platform, `${prefix}-user`, `${prefix} 商户成员`, accountPassword, reason)
    assert.equal(account.role, 'REQUESTER')
    assert.equal(account.version, 1)
    const listing = await api(platform, 'GET', `/admin/users?keyword=${encodeURIComponent(account.username)}`)
    assert.equal(listing.items.length, 1)
    assert(!JSON.stringify(listing).includes(accountPassword), 'Account list exposes password')
    assert(!JSON.stringify(listing).includes('passwordHash'), 'Account list exposes password hash')
    await screenshot(platform.page, 'admin-01-created-account.png')
  })

  await step('页面创建客服组和商户，修改默认路由并保留历史工单归属', async () => {
    firstGroup = await createGroupUI(platform, `${prefix}-g1`, `${prefix} 原客服组`, reason)
    secondGroup = await api(platform, 'POST', '/admin/support-groups',
      { code: `${prefix}-g2`, name: `${prefix} 新客服组`, reason })
    merchant = await createMerchantUI(platform, `${prefix}-m`, `${prefix} 商户`, firstGroup, reason)
    await addMemberUI(platform, merchant, account, 'MEMBER', reason)
    merchantUser = await actor(account.username, accountPassword)
    const original = await api(merchantUser, 'POST', '/tickets', { title: `${prefix} 原路由工单`,
      description: '默认客服组变更不能移动已经创建的工单。', category: 'BUG', priority: 'NORMAL' }, 201)
    assert.equal(String(original.supportGroup.id), String(firstGroup.id))
    merchant = await updateMerchantRouteUI(platform, merchant, secondGroup, reason)
    const unchanged = await api(merchantUser, 'GET', `/tickets/${original.id}`)
    assert.equal(String(unchanged.supportGroup.id), String(firstGroup.id))
    const newer = await api(merchantUser, 'POST', '/tickets', { title: `${prefix} 新路由工单`,
      description: '商户旧会话应实时获得已更新的默认客服组。', category: 'BUG', priority: 'NORMAL' }, 201)
    assert.equal(String(newer.supportGroup.id), String(secondGroup.id))
    await screenshot(platform.page, 'admin-02-merchant-routing.png')
  })

  await step('页面晋升商户管理员，旧会话立即获得同商户工单权限', async () => {
    const peer = await api(platform, 'POST', '/admin/users', { username: `${prefix}-peer`, displayName: `${prefix} 同商户成员`,
      role: 'REQUESTER', password: accountPassword, reason })
    await api(platform, 'POST', `/admin/merchants/${merchant.id}/members`, { userId: peer.id, role: 'MEMBER', reason })
    const peerActor = await actor(peer.username, accountPassword)
    otherTicket = await api(peerActor, 'POST', '/tickets', { title: `${prefix} 同商户他人工单`,
      description: '用于验证成员晋升前后的真实访问范围变化。', category: 'BUG', priority: 'NORMAL' }, 201)
    await api(merchantUser, 'GET', `/tickets/${otherTicket.id}`, undefined, 404)
    await updateMemberRoleUI(platform, merchant, account, 'MERCHANT_ADMIN', reason)
    const me = await api(merchantUser, 'GET', '/auth/me')
    assert.equal(me.merchant.role, 'MERCHANT_ADMIN')
    const visible = await api(merchantUser, 'GET', `/tickets/${otherTicket.id}`)
    assert.equal(visible.id, otherTicket.id)
    const memberships = await api(platform, 'GET', `/admin/merchants/${merchant.id}/members`)
    const promoted = memberships.find(value => value.userId === account.id)
    assert.equal(promoted.role, 'MERCHANT_ADMIN')
    await api(platform, 'POST', `/admin/merchants/${merchant.id}/members/${account.id}/update`,
      { role: 'MEMBER', enabled: true, version: promoted.version, reason }, 409)
    await screenshot(platform.page, 'admin-03-promoted-membership.png')
  })

  await step('非平台管理员被拒绝访问管理接口，旧版本写入被拒绝', async () => {
    for (const endpoint of ['/admin/users', '/admin/merchants', '/admin/support-groups', '/admin/audits'])
      await api(merchantUser, 'GET', endpoint, undefined, 403)
    await api(merchantUser, 'POST', '/admin/support-groups', { code: `${prefix}-denied`, name: '无权创建', reason }, 403)
    await merchantUser.page.reload()
    await merchantUser.page.getByRole('button', { name: '退出登录', exact: true }).waitFor()
    assert.equal(await merchantUser.page.getByRole('button', { name: '管理中心', exact: true }).count(), 0)
    await api(platform, 'POST', `/admin/merchants/${merchant.id}/update`,
      { name: merchant.name, defaultSupportGroupId: firstGroup.id, version: 1, reason }, 409)
    const unchanged = await namedItem(platform, 'merchants', merchant.code)
    assert.equal(unchanged.defaultSupportGroupId, secondGroup.id)
  })

  await step('本人页面改密，全部旧会话失效并使用新密码重新登录', async () => {
    const secondSession = await actor(account.username, accountPassword)
    await changePasswordUI(merchantUser, accountPassword, nextPassword)
    await api(merchantUser, 'GET', '/auth/me', undefined, 401)
    await api(secondSession, 'GET', '/auth/me', undefined, 401)
    await api(secondSession, 'POST', '/auth/login', { username: account.username, password: accountPassword }, 401)
    await loginPage(merchantUser, nextPassword)
    assert.equal(merchantUser.identity.merchant.role, 'MERCHANT_ADMIN')
    await api(merchantUser, 'GET', `/tickets/${otherTicket.id}`)
    await screenshot(merchantUser.page, 'admin-04-password-relogin.png')
  })

  await step('页面查看管理审计，记录角色变更且不暴露密码', async () => {
    await auditUI(platform, prefix)
    const audit = await api(platform, 'GET', `/admin/audits?keyword=${encodeURIComponent(prefix)}&pageSize=100`)
    assert(audit.items.some(item => item.action === 'ACCOUNT_CREATED'), 'Missing account audit')
    assert(audit.items.some(item => item.action === 'MERCHANT_UPDATED'), 'Missing route-change audit')
    assert(audit.items.some(item => item.action === 'MERCHANT_MEMBER_UPDATED'), 'Missing membership audit')
    const passwordAudits = await api(platform, 'GET', '/admin/audits?keyword=PASSWORD_CHANGED&pageSize=100')
    assert(passwordAudits.items.some(item => item.targetId === account.id), 'Missing password-change audit')
    for (const secret of secrets) assert(!JSON.stringify([audit, passwordAudits]).includes(secret), 'Audit exposes credentials')
    await screenshot(platform.page, 'admin-05-audit.png')
  })

  await step('工单独立链接刷新和浏览器后退仍恢复正确访问范围', async () => {
    const page = merchantUser.page
    await page.goto(`/#/tickets/${otherTicket.id}`)
    await page.getByRole('heading', { name: otherTicket.title, exact: true }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: otherTicket.title, exact: true }).waitFor()
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    await page.getByRole('heading', { name: '本商户工单', exact: true }).waitFor()
    await page.goBack()
    await page.getByRole('heading', { name: otherTicket.title, exact: true }).waitFor()
  })

  await step('390px 管理中心可操作，页面没有横向溢出', async () => {
    await platform.page.setViewportSize({ width: 390, height: 844 })
    await settle(platform.page)
    assert(await platform.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Management page overflows mobile viewport')
    await screenshot(platform.page, 'admin-06-mobile.png')
  })
  await step('全部管理中心浏览器会话无未处理页面异常', async () => assert.deepEqual(result.pageErrors, []))
  result.status = 'passed'
}

// Component-specific helpers are defined below using the actual rendered form labels.

async function openAdmin(page) {
  currentPage = page
  await page.getByRole('button', { name: '管理中心', exact: true }).click()
  await page.getByRole('heading', { name: '管理中心', exact: true }).waitFor()
  await settle(page)
}

async function adminTab(page, title, resource) {
  currentPage = page
  await page.locator('.admin-center').getByRole('tab', { name: title, exact: true }).click()
  await settle(page)
  assert.equal(await page.locator('.admin-center').getByPlaceholder('搜索账号、名称或操作记录').count(), 1)
}

async function searchAdmin(page, resource, keyword) {
  const center = page.locator('.admin-center')
  await center.getByPlaceholder('搜索账号、名称或操作记录').fill(keyword)
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === `/api/v1/admin/${resource}` && url.searchParams.get('keyword') === keyword
      && response.request().method() === 'GET'
  })
  await center.getByRole('button', { name: '查询', exact: true }).click()
  assert((await responsePromise).ok(), 'Admin search failed')
  await settle(page)
}

function organizationTableRow(page, code) {
  return page.locator('.admin-center tbody tr').filter({ has: page.getByText(code, { exact: true }) })
}

async function saveDialog(page, endpoint, dialog) {
  const saved = await submit(page, endpoint, () => dialog.getByRole('button', { name: '保存', exact: true }).click())
  await dialog.waitFor({ state: 'hidden' })
  return saved
}

async function createAccountUI(item, username, displayName, initialPassword, reason) {
  const page = item.page
  await adminTab(page, '账号管理', 'users')
  await page.getByRole('button', { name: '新增账号', exact: true }).click()
  const dialog = page.locator('.admin-dialog')
  await dialog.waitFor()
  await fillField(dialog, '账号', username)
  await fillField(dialog, '昵称', displayName)
  await fillField(dialog, '初始密码', initialPassword)
  await fillField(dialog, '操作原因', reason)
  return saveDialog(page, '/admin/users', dialog)
}

async function createGroupUI(item, code, name, reason) {
  const page = item.page
  await adminTab(page, '客服组管理', 'support-groups')
  await page.getByRole('button', { name: '新增客服组', exact: true }).click()
  const dialog = page.locator('.admin-dialog')
  await dialog.waitFor()
  await fillField(dialog, '编码', code)
  await fillField(dialog, '名称', name)
  await fillField(dialog, '操作原因', reason)
  return saveDialog(page, '/admin/support-groups', dialog)
}

async function createMerchantUI(item, code, name, group, reason) {
  const page = item.page
  await adminTab(page, '商户管理', 'merchants')
  await page.getByRole('button', { name: '新增商户', exact: true }).click()
  const dialog = page.locator('.admin-dialog')
  await dialog.waitFor()
  await settle(page)
  await fillField(dialog, '编码', code)
  await fillField(dialog, '名称', name)
  await selectField(page, dialog, '默认客服组', group.name)
  await fillField(dialog, '操作原因', reason)
  return saveDialog(page, '/admin/merchants', dialog)
}

async function showMembers(item, merchant) {
  const page = item.page
  currentPage = page
  await adminTab(page, '商户管理', 'merchants')
  await searchAdmin(page, 'merchants', merchant.code)
  await organizationTableRow(page, merchant.code).getByRole('button', { name: '成员管理', exact: true }).click()
  const dialog = page.locator('.admin-members-dialog')
  await dialog.waitFor()
  await settle(page)
  return dialog
}

async function closeMembers(page, dialog) {
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await settle(page)
}

async function addMemberUI(item, merchant, account, role, reason) {
  const page = item.page
  const members = await showMembers(item, merchant)
  await members.getByRole('button', { name: '添加成员', exact: true }).click()
  const dialog = page.locator('.admin-dialog')
  await dialog.waitFor()
  await dialog.getByPlaceholder('输入账号或昵称').fill(account.username)
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/v1/admin/users' && url.searchParams.get('keyword') === account.username
      && response.request().method() === 'GET'
  })
  await dialog.getByRole('button', { name: '查找', exact: true }).click()
  assert((await responsePromise).ok(), 'Member candidate search failed')
  await settle(page)
  await selectField(page, dialog, '选择账号', account.username)
  if (role !== 'MEMBER') await selectField(page, dialog, '组织职责', role === 'MERCHANT_ADMIN' ? '商户管理员' : '普通成员')
  await fillField(dialog, '操作原因', reason)
  await submit(page, `/admin/merchants/${merchant.id}/members`,
    () => dialog.getByRole('button', { name: '保存成员', exact: true }).click())
  await dialog.waitFor({ state: 'hidden' })
  await members.getByText(account.username, { exact: true }).waitFor()
  await closeMembers(page, members)
}

async function updateMerchantRouteUI(item, merchant, group, reason) {
  const page = item.page
  currentPage = page
  await adminTab(page, '商户管理', 'merchants')
  await searchAdmin(page, 'merchants', merchant.code)
  await organizationTableRow(page, merchant.code).getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.locator('.admin-dialog')
  await dialog.waitFor()
  await settle(page)
  await selectField(page, dialog, '默认客服组', group.name)
  await fillField(dialog, '操作原因', reason)
  return saveDialog(page, `/admin/merchants/${merchant.id}/update`, dialog)
}

async function updateMemberRoleUI(item, merchant, account, role, reason) {
  const page = item.page
  const members = await showMembers(item, merchant)
  await members.locator('tbody tr').filter({ has: page.getByText(account.username, { exact: true }) })
    .getByRole('button', { name: '编辑成员', exact: true }).click()
  const dialog = page.locator('.admin-dialog')
  await dialog.waitFor()
  await selectField(page, dialog, '组织职责', role === 'MERCHANT_ADMIN' ? '商户管理员' : '普通成员')
  await fillField(dialog, '操作原因', reason)
  await submit(page, `/admin/merchants/${merchant.id}/members/${account.id}/update`,
    () => dialog.getByRole('button', { name: '保存成员', exact: true }).click())
  await dialog.waitFor({ state: 'hidden' })
  await members.getByText('商户管理员', { exact: true }).waitFor()
  await closeMembers(page, members)
}

async function auditUI(item, keyword) {
  const page = item.page
  await adminTab(page, '操作审计', 'audits')
  await searchAdmin(page, 'audits', keyword)
  await page.locator('.admin-center tbody tr').filter({ hasText: 'MERCHANT_MEMBER_UPDATED' }).waitFor()
  await page.locator('.admin-center tbody tr').filter({ hasText: 'MERCHANT_MEMBER_UPDATED' })
    .getByRole('button', { name: '查看变更', exact: true }).click()
  const dialog = page.locator('.admin-members-dialog')
  await dialog.waitFor()
  assert((await dialog.textContent()).includes('MERCHANT_ADMIN'), 'Audit detail does not include promoted role')
  await closeMembers(page, dialog)
}

function formItem(scope, label) {
  return scope.locator('.n-form-item').filter({ has: scope.page().getByText(label, { exact: true }) })
}

async function fillField(scope, label, value) {
  await formItem(scope, label).locator('input, textarea').fill(value)
}

async function selectField(page, scope, label, option) {
  await formItem(scope, label).locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: option }).click()
}

async function changePasswordUI(item, currentPassword, newPassword) {
  const page = item.page
  currentPage = page
  await page.getByRole('button', { name: '修改密码', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: '修改密码' })
  await dialog.waitFor()
  await fillField(dialog, '当前密码', currentPassword)
  await fillField(dialog, '新密码', newPassword)
  await fillField(dialog, '确认新密码', newPassword)
  await submit(page, '/auth/password', () => dialog.getByRole('button', { name: '修改并重新登录', exact: true }).click())
  await page.getByRole('heading', { name: '登录工作台', exact: true }).waitFor()
}

main().catch(async error => {
  result.status = 'failed'
  result.error = redact(error.stack || error)
  if (currentPage && !currentPage.isClosed()) {
    try { await screenshot(currentPage, 'admin-failure.png') } catch { /* Preserve the original failure. */ }
  }
  process.exitCode = 1
}).finally(async () => {
  for (const item of actors) await item.context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  result.finishedAt = new Date().toISOString()
  await fs.mkdir(artifactDir, { recursive: true })
  await fs.writeFile(path.join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ status: result.status, scenarios: result.scenarios, artifactDir }))
})
