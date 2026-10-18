/* global document, window, fetch, Blob, URL, URLSearchParams */

(() => {
  'use strict'

  const API_BASE = '/admin/api'
  const PAGE_SIZE = 20
  const DEFAULT_SESSION_MS = 30 * 60 * 1000
  const SEARCH_DEBOUNCE_MS = 300
  const USERNAME_STORAGE_KEY = 'fafee.admin.lastUsername'
  const MAX_LABEL = 80
  const MAX_NOTE = 500

  const INVITE_STATE_LABELS = {
    unused: '未使用',
    used: '已使用',
    disabled: '已停用',
    expired: '已过期'
  }

  const FILTER_STATUSES = new Set(['all', 'unused', 'used', 'disabled', 'expired'])

  const AUDIT_RESULT_META = new Map([
    ['ok', { label: '成功', tone: 'ok' }],
    ['success', { label: '成功', tone: 'ok' }],
    ['fail', { label: '失败', tone: 'fail' }],
    ['failed', { label: '失败', tone: 'fail' }],
    ['failure', { label: '失败', tone: 'fail' }],
    ['error', { label: '失败', tone: 'fail' }],
    ['denied', { label: '拒绝', tone: 'fail' }],
    ['rejected', { label: '拒绝', tone: 'fail' }],
    ['locked', { label: '已锁定', tone: 'warn' }]
  ])

  const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })

  const auditTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })

  const countFormatter = new Intl.NumberFormat('zh-CN')

  const ui = {
    loginView: document.getElementById('login-view'),
    loginForm: document.getElementById('login-form'),
    loginUsername: document.getElementById('login-username'),
    loginPassword: document.getElementById('login-password'),
    loginTotp: document.getElementById('login-totp'),
    rememberUsername: document.getElementById('remember-username'),
    loginNotice: document.getElementById('login-notice'),
    loginError: document.getElementById('login-error'),
    loginSubmit: document.getElementById('login-submit'),
    appView: document.getElementById('app-view'),
    appTitle: document.getElementById('app-title'),
    currentUser: document.getElementById('current-user'),
    sessionRemaining: document.getElementById('session-remaining'),
    logoutButton: document.getElementById('logout-button'),
    statsRefresh: document.getElementById('stats-refresh'),
    statTotal: document.getElementById('stat-total'),
    statUnused: document.getElementById('stat-unused'),
    statUsed: document.getElementById('stat-used'),
    statDisabled: document.getElementById('stat-disabled'),
    statExpired: document.getElementById('stat-expired'),
    statsError: document.getElementById('stats-error'),
    createForm: document.getElementById('create-form'),
    createCount: document.getElementById('create-count'),
    createLabel: document.getElementById('create-label'),
    createNote: document.getElementById('create-note'),
    createExpiry: document.getElementById('create-expiry'),
    createError: document.getElementById('create-error'),
    createSubmit: document.getElementById('create-submit'),
    statusFilters: document.getElementById('status-filters'),
    inviteSearch: document.getElementById('invite-search'),
    invitesNotice: document.getElementById('invites-notice'),
    invitesSummary: document.getElementById('invites-summary'),
    inviteTableWrap: document.getElementById('invite-table-wrap'),
    invitesBody: document.getElementById('invites-body'),
    invitesPageInfo: document.getElementById('invites-page-info'),
    invitesPrev: document.getElementById('invites-prev'),
    invitesNext: document.getElementById('invites-next'),
    auditRefresh: document.getElementById('audit-refresh'),
    auditTableWrap: document.getElementById('audit-table-wrap'),
    auditBody: document.getElementById('audit-body'),
    auditPageInfo: document.getElementById('audit-page-info'),
    auditPrev: document.getElementById('audit-prev'),
    auditNext: document.getElementById('audit-next'),
    resultDialog: document.getElementById('result-dialog'),
    resultCloseTop: document.getElementById('result-close-top'),
    resultBody: document.getElementById('result-body'),
    resultMeta: document.getElementById('result-meta'),
    resultCodes: document.getElementById('result-codes'),
    resultCopy: document.getElementById('result-copy'),
    resultDownload: document.getElementById('result-download'),
    resultClose: document.getElementById('result-close'),
    resultStatus: document.getElementById('result-status')
  }

  const session = {
    token: '',
    user: '',
    expiresAt: 0,
    timerId: 0,
    epoch: 0
  }

  const invites = {
    status: 'all',
    q: '',
    page: 1,
    pageSize: PAGE_SIZE,
    total: 0,
    totalPages: 0,
    error: '',
    loading: false,
    requestId: 0
  }

  const audit = {
    page: 1,
    pageSize: PAGE_SIZE,
    total: 0,
    totalPages: 0,
    error: '',
    loading: false,
    requestId: 0
  }

  let loginPending = false
  let createPending = false
  let searchTimerId = 0
  let copyResetTimerId = 0
  let generatedBatch = null

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.code = code
    }
  }

  function make(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = String(text)
    return node
  }

  function textOf(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback
    return String(value)
  }

  function formatCount(value) {
    const number = Number(value)
    return Number.isFinite(number) ? countFormatter.format(number) : '—'
  }

  function formatDateTime(value, withSeconds = false) {
    if (value === null || value === undefined || value === '') return '—'
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    try {
      return (withSeconds ? auditTimeFormatter : dateTimeFormatter).format(date)
    } catch {
      return String(value)
    }
  }

  function toPositiveInt(value, fallback) {
    const number = Number(value)
    return Number.isInteger(number) && number >= 1 ? number : fallback
  }

  function toNonNegativeInt(value, fallback) {
    const number = Number(value)
    return Number.isInteger(number) && number >= 0 ? number : fallback
  }

  function normalizeInviteState(value) {
    return Object.prototype.hasOwnProperty.call(INVITE_STATE_LABELS, value) ? value : 'unknown'
  }

  function setAlert(node, message, tone) {
    const text = message === null || message === undefined ? '' : String(message)
    if (!text) {
      clearAlert(node)
      return
    }
    node.classList.remove('alert--error', 'alert--success', 'alert--warning', 'alert--info')
    node.classList.add('alert', `alert--${tone}`)
    node.textContent = text
    node.hidden = false
  }

  function clearAlert(node) {
    node.textContent = ''
    node.hidden = true
  }

  function setLoginBusy(busy) {
    ui.loginSubmit.disabled = busy
    ui.loginSubmit.textContent = busy ? '登录中…' : '登录管理台'
    ui.loginForm.setAttribute('aria-busy', busy ? 'true' : 'false')
  }

  function setCreateBusy(busy) {
    ui.createSubmit.disabled = busy
    ui.createSubmit.textContent = busy ? '生成中…' : '生成邀请码'
    ui.createForm.setAttribute('aria-busy', busy ? 'true' : 'false')
  }

  function setTableState(tbody, colspan, message, retry) {
    const row = make('tr', 'state-row')
    const cell = make('td', 'table-state')
    cell.colSpan = colspan
    cell.append(make('p', 'table-state-text', message))
    if (typeof retry === 'function') {
      const button = make('button', 'btn btn--ghost btn--sm', '重试')
      button.type = 'button'
      button.addEventListener('click', retry)
      cell.append(button)
    }
    row.append(cell)
    tbody.replaceChildren(row)
  }

  function readRememberedUsername() {
    try {
      return window.localStorage.getItem(USERNAME_STORAGE_KEY) || ''
    } catch {
      return ''
    }
  }

  function writeRememberedUsername(username) {
    try {
      if (ui.rememberUsername.checked) {
        window.localStorage.setItem(USERNAME_STORAGE_KEY, username)
      } else {
        window.localStorage.removeItem(USERNAME_STORAGE_KEY)
      }
    } catch {
      /* localStorage 不可用时静默降级，不保存任何凭据。 */
    }
  }

  function fallbackStatusMessage(status) {
    switch (status) {
      case 400:
        return '请求参数有误'
      case 401:
        return '登录已失效，请重新登录'
      case 403:
        return '没有权限执行此操作'
      case 404:
        return '请求的资源不存在'
      case 409:
        return '操作冲突，请刷新后重试'
      case 413:
        return '请求内容过大'
      case 429:
        return '操作过于频繁，请稍后再试'
      default:
        return '管理服务暂时不可用，请稍后重试'
    }
  }

  async function request(path, { method = 'GET', body, auth = true } = {}) {
    if (auth) {
      if (!session.token) {
        throw new ApiError(401, 'ADMIN_NO_SESSION', '登录已失效，请重新登录')
      }
      if (session.expiresAt > 0 && Date.now() >= session.expiresAt) {
        endSession('登录已过期，请重新登录。', 'info')
        throw new ApiError(401, 'ADMIN_SESSION_EXPIRED', '登录已过期，请重新登录')
      }
    }

    const headers = { Accept: 'application/json' }
    if (auth) headers.Authorization = `Bearer ${session.token}`

    let payload
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }

    let response
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: payload,
        cache: 'no-store'
      })
    } catch {
      throw new ApiError(0, 'ADMIN_NETWORK_ERROR', '无法连接管理服务，请确认 SSH 隧道仍然可用')
    }

    let raw = ''
    try {
      raw = await response.text()
    } catch {
      throw new ApiError(0, 'ADMIN_NETWORK_ERROR', '读取管理服务响应失败，请稍后重试')
    }

    let data = null
    if (raw) {
      try {
        data = JSON.parse(raw)
      } catch {
        data = null
      }
    }

    if (!response.ok) {
      if (response.status === 401 && auth) {
        endSession('登录已过期，请重新登录。', 'info')
      }
      const serverMessage = data && typeof data.error === 'string' ? data.error.trim() : ''
      const code = data && typeof data.code === 'string' ? data.code : ''
      throw new ApiError(response.status, code, serverMessage || fallbackStatusMessage(response.status))
    }

    return data
  }

  function startSessionTimer() {
    if (session.timerId) window.clearInterval(session.timerId)
    session.timerId = window.setInterval(updateSessionRemaining, 1000)
    updateSessionRemaining()
  }

  function updateSessionRemaining() {
    if (!session.token) return
    const remaining = session.expiresAt - Date.now()
    if (remaining <= 0) {
      endSession('登录已过期，请重新登录。', 'info')
      return
    }

    const totalSeconds = Math.ceil(remaining / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    const pad = (value) => String(value).padStart(2, '0')
    const display = hours > 0
      ? `${hours}:${pad(minutes)}:${pad(seconds)}`
      : `${pad(minutes)}:${pad(seconds)}`

    ui.sessionRemaining.textContent = display
    ui.sessionRemaining.title = `预计 ${formatDateTime(new Date(session.expiresAt).toISOString(), true)} 到期`
  }

  function resetStatsDisplay() {
    ui.statTotal.textContent = '—'
    ui.statUnused.textContent = '—'
    ui.statUsed.textContent = '—'
    ui.statDisabled.textContent = '—'
    ui.statExpired.textContent = '—'
    clearAlert(ui.statsError)
  }

  function updateStatusFilterButtons() {
    const buttons = ui.statusFilters.querySelectorAll('button[data-status]')
    buttons.forEach((button) => {
      const active = button.dataset.status === invites.status
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    })
  }

  function resetStatusFilter() {
    invites.status = 'all'
    updateStatusFilterButtons()
  }

  function updateInvitesPagination() {
    if (!session.token) {
      ui.invitesPageInfo.textContent = '—'
      ui.invitesPrev.disabled = true
      ui.invitesNext.disabled = true
      return
    }
    if (invites.error) {
      ui.invitesPageInfo.textContent = '加载失败'
      ui.invitesPrev.disabled = true
      ui.invitesNext.disabled = true
      return
    }
    if (invites.loading) {
      ui.invitesPageInfo.textContent = '正在加载…'
      ui.invitesPrev.disabled = true
      ui.invitesNext.disabled = true
      return
    }
    if (invites.total <= 0 || invites.totalPages <= 0) {
      ui.invitesPageInfo.textContent = '暂无记录'
      ui.invitesPrev.disabled = true
      ui.invitesNext.disabled = true
      return
    }
    ui.invitesPageInfo.textContent = `第 ${invites.page} / ${invites.totalPages} 页 · 共 ${formatCount(invites.total)} 条`
    ui.invitesPrev.disabled = invites.page <= 1
    ui.invitesNext.disabled = invites.page >= invites.totalPages
  }

  function updateAuditPagination() {
    if (!session.token) {
      ui.auditPageInfo.textContent = '—'
      ui.auditPrev.disabled = true
      ui.auditNext.disabled = true
      return
    }
    if (audit.error) {
      ui.auditPageInfo.textContent = '加载失败'
      ui.auditPrev.disabled = true
      ui.auditNext.disabled = true
      return
    }
    if (audit.loading) {
      ui.auditPageInfo.textContent = '正在加载…'
      ui.auditPrev.disabled = true
      ui.auditNext.disabled = true
      return
    }
    if (audit.total <= 0 || audit.totalPages <= 0) {
      ui.auditPageInfo.textContent = '暂无记录'
      ui.auditPrev.disabled = true
      ui.auditNext.disabled = true
      return
    }
    ui.auditPageInfo.textContent = `第 ${audit.page} / ${audit.totalPages} 页 · 共 ${formatCount(audit.total)} 条`
    ui.auditPrev.disabled = audit.page <= 1
    ui.auditNext.disabled = audit.page >= audit.totalPages
  }

  function clearSensitiveView() {
    session.token = ''
    session.user = ''
    session.expiresAt = 0
    session.epoch += 1

    if (session.timerId) {
      window.clearInterval(session.timerId)
      session.timerId = 0
    }
    if (searchTimerId) {
      window.clearTimeout(searchTimerId)
      searchTimerId = 0
    }

    invites.requestId += 1
    audit.requestId += 1
    invites.loading = false
    audit.loading = false
    invites.error = ''
    audit.error = ''
    invites.total = 0
    invites.totalPages = 0
    audit.total = 0
    audit.totalPages = 0

    setCreateBusy(false)
    setLoginBusy(false)
    createPending = false
    ui.currentUser.textContent = '—'
    ui.sessionRemaining.textContent = '—'
    ui.sessionRemaining.title = '登录会话剩余时间'
    ui.invitesSummary.textContent = '—'
    ui.invitesBody.replaceChildren()
    ui.auditBody.replaceChildren()
    ui.inviteTableWrap.setAttribute('aria-busy', 'false')
    ui.auditTableWrap.setAttribute('aria-busy', 'false')
    ui.invitesPageInfo.textContent = '—'
    ui.auditPageInfo.textContent = '—'
    ui.invitesPrev.disabled = true
    ui.invitesNext.disabled = true
    ui.auditPrev.disabled = true
    ui.auditNext.disabled = true
    ui.statsRefresh.disabled = false
    ui.statsRefresh.textContent = '刷新'
    ui.auditRefresh.disabled = false
    ui.auditRefresh.textContent = '刷新'
    resetStatsDisplay()
    clearAlert(ui.invitesNotice)
    clearAlert(ui.createError)
    ui.inviteSearch.value = ''
    invites.q = ''
    invites.page = 1
    invites.pageSize = PAGE_SIZE
    audit.page = 1
    audit.pageSize = PAGE_SIZE
    resetStatusFilter()
    ui.createCount.value = '1'
    ui.createLabel.value = ''
    ui.createNote.value = ''
    ui.createExpiry.value = ''
    ui.loginPassword.value = ''
    ui.loginTotp.value = ''
    clearAlert(ui.loginError)
  }

  function endSession(message, tone = 'info') {
    if (ui.appView.hidden) return
    closeGeneratedResult({ restoreFocus: false })
    clearSensitiveView()
    ui.appView.hidden = true
    ui.loginView.hidden = false
    clearAlert(ui.loginNotice)
    if (message) setAlert(ui.loginNotice, message, tone)
    const remembered = readRememberedUsername()
    if (remembered) ui.loginUsername.value = remembered
    window.setTimeout(() => ui.loginUsername.focus(), 0)
  }

  function startSession(payload) {
    const token = payload && typeof payload.token === 'string' ? payload.token : ''
    if (!token) throw new ApiError(500, 'ADMIN_TOKEN_MISSING', '登录响应无效，请稍后重试')

    const username = payload.user && typeof payload.user.username === 'string' && payload.user.username
      ? payload.user.username
      : '管理员'
    const expiresAt = Date.parse(String(payload.expiresAt || ''))

    session.token = token
    session.user = username
    session.expiresAt = Number.isFinite(expiresAt) ? expiresAt : Date.now() + DEFAULT_SESSION_MS
    session.epoch += 1

    invites.status = 'all'
    invites.q = ''
    invites.page = 1
    invites.pageSize = PAGE_SIZE
    invites.total = 0
    invites.totalPages = 0
    invites.error = ''
    invites.loading = false
    invites.requestId = 0
    audit.page = 1
    audit.pageSize = PAGE_SIZE
    audit.total = 0
    audit.totalPages = 0
    audit.error = ''
    audit.loading = false
    audit.requestId = 0

    ui.loginView.hidden = true
    ui.appView.hidden = false
    ui.currentUser.textContent = username
    ui.sessionRemaining.textContent = '—'
    ui.invitesSummary.textContent = '正在加载…'
    ui.invitesPageInfo.textContent = '正在加载…'
    ui.auditPageInfo.textContent = '正在加载…'
    ui.invitesPrev.disabled = true
    ui.invitesNext.disabled = true
    ui.auditPrev.disabled = true
    ui.auditNext.disabled = true
    ui.inviteSearch.value = ''
    resetStatusFilter()
    resetStatsDisplay()
    clearAlert(ui.invitesNotice)
    clearAlert(ui.createError)
    clearAlert(ui.loginError)
    clearAlert(ui.loginNotice)
    setCreateBusy(false)
    setLoginBusy(false)
    createPending = false
    ui.loginPassword.value = ''
    ui.loginTotp.value = ''
    ui.createCount.value = '1'
    ui.createLabel.value = ''
    ui.createNote.value = ''
    ui.createExpiry.value = ''

    startSessionTimer()
    window.setTimeout(() => ui.appTitle.focus(), 0)
    loadStats()
    loadInvites()
    loadAudit()
  }

  async function handleLoginSubmit(event) {
    event.preventDefault()
    if (loginPending) return

    clearAlert(ui.loginError)
    clearAlert(ui.loginNotice)

    const username = ui.loginUsername.value.trim()
    const password = ui.loginPassword.value
    const totp = ui.loginTotp.value.replace(/[^0-9]/g, '')

    if (!username) {
      setAlert(ui.loginError, '请输入用户名。', 'error')
      ui.loginUsername.focus()
      return
    }
    if (!password) {
      setAlert(ui.loginError, '请输入密码。', 'error')
      ui.loginPassword.focus()
      return
    }
    if (!/^[0-9]{6}$/.test(totp)) {
      setAlert(ui.loginError, '请输入 6 位动态验证码。', 'error')
      ui.loginTotp.focus()
      return
    }

    loginPending = true
    setLoginBusy(true)
    try {
      const data = await request('/login', {
        method: 'POST',
        auth: false,
        body: { username, password, totp }
      })
      if (!data || typeof data.token !== 'string' || !data.token) {
        throw new ApiError(500, 'ADMIN_TOKEN_MISSING', '登录响应无效，请稍后重试')
      }
      startSession(data)
      writeRememberedUsername(username)
    } catch (error) {
      if (ui.appView.hidden) {
        const message = error instanceof ApiError && error.message
          ? error.message
          : '登录失败，请稍后重试。'
        setAlert(ui.loginError, message, 'error')
        ui.loginTotp.value = ''
        ui.loginTotp.focus()
      }
    } finally {
      loginPending = false
      setLoginBusy(false)
    }
  }

  async function loadStats() {
    if (!session.token) return
    const epoch = session.epoch
    ui.statsRefresh.disabled = true
    ui.statsRefresh.textContent = '刷新中…'
    clearAlert(ui.statsError)

    try {
      const data = await request('/stats')
      if (epoch !== session.epoch) return
      ui.statTotal.textContent = data ? formatCount(data.total) : '—'
      ui.statUnused.textContent = data ? formatCount(data.unused) : '—'
      ui.statUsed.textContent = data ? formatCount(data.used) : '—'
      ui.statDisabled.textContent = data ? formatCount(data.disabled) : '—'
      ui.statExpired.textContent = data ? formatCount(data.expired) : '—'
    } catch (error) {
      if (epoch !== session.epoch) return
      if (error.status === 401) return
      resetStatsDisplay()
      setAlert(ui.statsError, `统计加载失败：${error.message || '请稍后重试'}`, 'error')
    } finally {
      if (epoch === session.epoch) {
        ui.statsRefresh.disabled = false
        ui.statsRefresh.textContent = '刷新'
      }
    }
  }

  function scheduleInviteSearch() {
    if (searchTimerId) window.clearTimeout(searchTimerId)
    searchTimerId = window.setTimeout(() => {
      searchTimerId = 0
      commitInviteSearch()
    }, SEARCH_DEBOUNCE_MS)
  }

  function commitInviteSearch() {
    if (searchTimerId) {
      window.clearTimeout(searchTimerId)
      searchTimerId = 0
    }
    const keyword = ui.inviteSearch.value.trim()
    if (keyword === invites.q) return
    invites.q = keyword
    invites.page = 1
    clearAlert(ui.invitesNotice)
    loadInvites()
  }

  function makeCell(label, className = '') {
    const cell = document.createElement('td')
    if (className) cell.className = className
    cell.dataset.label = label
    return cell
  }

  function appendTextCell(row, label, text, className = '') {
    const cell = makeCell(label, className)
    cell.textContent = textOf(text)
    row.append(cell)
    return cell
  }

  function appendTruncatedCell(row, label, value, className = 'cell-truncate') {
    const cell = makeCell(label)
    const span = make('span', className, textOf(value))
    if (value !== null && value !== undefined && value !== '') span.title = String(value)
    cell.append(span)
    row.append(cell)
    return cell
  }

  function createUsedByContent(usedBy) {
    if (!usedBy) return make('span', 'muted', '—')

    let username = ''
    let email = ''
    let accountState = ''
    let accountExpiresAt = ''
    if (typeof usedBy === 'string') {
      username = usedBy
    } else if (typeof usedBy === 'object') {
      username = typeof usedBy.username === 'string' ? usedBy.username : ''
      email = typeof usedBy.email === 'string' ? usedBy.email : ''
      accountState = typeof usedBy.state === 'string' ? usedBy.state : ''
      accountExpiresAt = typeof usedBy.expiresAt === 'string' ? usedBy.expiresAt : ''
    }
    if (!username && !email) return make('span', 'muted', '—')

    const wrapper = make('div', 'user-cell')
    if (username) {
      const name = make('span', 'user-name', username)
      name.title = username
      wrapper.append(name)
    }
    if (email) {
      const mail = make('span', 'subtext', email)
      mail.title = email
      wrapper.append(mail)
    }
    // 账号生命周期提示：邀请码到期会联动停用账号；无过期时间的账号不显示噪音。
    const expiry = accountExpiresAt ? formatDateTime(accountExpiresAt) : ''
    if (accountState === 'expired') {
      const note = make('span', 'subtext account-note', expiry ? `账号已到期（${expiry}）` : '账号已到期')
      note.title = '邀请码到期后账号已停用，历史数据仍保留'
      wrapper.append(note)
    } else if (accountState === 'disabled') {
      wrapper.append(make('span', 'subtext account-note', '账号已停用'))
    } else if (expiry) {
      const note = make('span', 'subtext account-note', `账号到期：${expiry}`)
      note.title = '到期后账号将无法登录，历史数据仍保留'
      wrapper.append(note)
    }
    return wrapper
  }

  function createInviteRow(item, serial) {
    const value = item && typeof item === 'object' ? item : {}
    const stateKey = normalizeInviteState(value.state)
    const row = make('tr', `invite-row invite-row--${stateKey}`)

    appendTextCell(row, '序号', String(serial), 'col-index')

    const hashCell = makeCell('哈希前缀')
    hashCell.append(make('code', 'hash', textOf(value.hashPrefix)))
    row.append(hashCell)

    appendTruncatedCell(row, '标签', value.label)
    appendTruncatedCell(row, '备注', value.note, 'cell-truncate cell-truncate--wide')

    const stateCell = makeCell('状态')
    const badge = make('span', `badge badge--${stateKey}`, INVITE_STATE_LABELS[stateKey] || '未知')
    stateCell.append(badge)
    row.append(stateCell)

    appendTextCell(row, '创建时间', formatDateTime(value.createdAt), 'time-cell')
    appendTextCell(row, '过期时间', formatDateTime(value.expiresAt), 'time-cell')
    appendTextCell(row, '使用时间', formatDateTime(value.usedAt), 'time-cell')

    const userCell = makeCell('使用者')
    userCell.append(createUsedByContent(value.usedBy))
    row.append(userCell)

    const actionCell = makeCell('操作', 'action-cell')
    if (stateKey === 'unused' && value.id) {
      const button = make('button', 'btn btn--danger btn--xs', '停用')
      button.type = 'button'
      button.addEventListener('click', () => {
        disableInvite(value, button)
      })
      actionCell.append(button)
    } else {
      actionCell.append(make('span', 'muted', '—'))
    }
    row.append(actionCell)

    return row
  }

  function renderInviteRows(items, startSerial) {
    if (!items.length) {
      const filtered = invites.q !== '' || invites.status !== 'all'
      setTableState(
        ui.invitesBody,
        10,
        filtered ? '没有符合条件的邀请码。' : '暂无邀请码，可在上方生成。'
      )
      return
    }

    const fragment = document.createDocumentFragment()
    items.forEach((item, index) => {
      fragment.append(createInviteRow(item, startSerial + index))
    })
    ui.invitesBody.replaceChildren(fragment)
  }

  async function loadInvites() {
    if (!session.token) return
    const epoch = session.epoch
    const requestId = invites.requestId + 1
    invites.requestId = requestId
    invites.loading = true
    invites.error = ''
    ui.inviteTableWrap.setAttribute('aria-busy', 'true')
    ui.invitesSummary.textContent = '正在加载…'
    updateInvitesPagination()
    setTableState(ui.invitesBody, 10, '正在加载邀请码…')

    const params = new URLSearchParams()
    params.set('status', invites.status)
    params.set('page', String(invites.page))
    params.set('pageSize', String(invites.pageSize))
    if (invites.q) params.set('q', invites.q)

    try {
      const data = await request(`/invites?${params.toString()}`)
      if (epoch !== session.epoch || requestId !== invites.requestId) return

      const items = data && Array.isArray(data.items) ? data.items : []
      const page = toPositiveInt(data && data.page, invites.page)
      const pageSize = toPositiveInt(data && data.pageSize, invites.pageSize)
      const total = toNonNegativeInt(data && data.total, items.length)
      const totalPages = toNonNegativeInt(data && data.totalPages, pageSize > 0 ? Math.ceil(total / pageSize) : 0)

      invites.pageSize = pageSize
      invites.total = total
      invites.totalPages = totalPages

      if (totalPages > 0 && page > totalPages) {
        invites.page = totalPages
        loadInvites()
        return
      }

      invites.page = totalPages === 0 ? 1 : page
      const startSerial = (invites.page - 1) * pageSize + 1
      renderInviteRows(items, startSerial)
      ui.invitesSummary.textContent = total > 0 ? `共 ${formatCount(total)} 条` : '暂无记录'
      invites.loading = false
      invites.error = ''
      ui.inviteTableWrap.setAttribute('aria-busy', 'false')
      updateInvitesPagination()
    } catch (error) {
      if (epoch !== session.epoch || requestId !== invites.requestId) return
      invites.loading = false
      if (error.status === 401) return
      invites.error = error.message || '请稍后重试'
      ui.invitesSummary.textContent = '加载失败'
      ui.inviteTableWrap.setAttribute('aria-busy', 'false')
      updateInvitesPagination()
      setTableState(
        ui.invitesBody,
        10,
        `邀请码加载失败：${invites.error}`,
        () => {
          loadInvites()
        }
      )
    }
  }

  async function disableInvite(item, button) {
    if (!item.id) {
      setAlert(ui.invitesNotice, '停用失败：缺少邀请码 ID。', 'error')
      return
    }

    const prefix = textOf(item.hashPrefix, textOf(item.id, '该邀请码'))
    const confirmed = window.confirm(`确定停用邀请码 ${prefix} 吗？\n\n停用后该邀请码将无法用于注册，且不可恢复。`)
    if (!confirmed) return

    const epoch = session.epoch
    clearAlert(ui.invitesNotice)
    button.disabled = true
    button.textContent = '停用中…'

    try {
      await request(`/invites/${encodeURIComponent(String(item.id))}/disable`, { method: 'POST' })
      if (epoch !== session.epoch) return
      await refreshAfterMutation()
      if (epoch !== session.epoch) return
      setAlert(ui.invitesNotice, `已停用邀请码 ${prefix}。`, 'success')
    } catch (error) {
      if (epoch !== session.epoch || error.status === 401) return
      if (button.isConnected) {
        button.disabled = false
        button.textContent = '停用'
      }
      setAlert(ui.invitesNotice, `停用失败：${error.message || '请稍后重试'}`, 'error')
    }
  }

  async function refreshAfterMutation() {
    audit.page = 1
    await Promise.allSettled([loadStats(), loadInvites(), loadAudit()])
  }

  async function handleCreateSubmit(event) {
    event.preventDefault()
    if (createPending) return

    clearAlert(ui.createError)

    const count = Number(ui.createCount.value)
    const label = ui.createLabel.value.trim()
    const note = ui.createNote.value.trim()

    if (!Number.isInteger(count) || count < 1 || count > 200) {
      setAlert(ui.createError, '数量需为 1–200 的整数。', 'error')
      ui.createCount.focus()
      return
    }
    if (label.length > MAX_LABEL) {
      setAlert(ui.createError, `标签不能超过 ${MAX_LABEL} 个字符。`, 'error')
      ui.createLabel.focus()
      return
    }
    if (note.length > MAX_NOTE) {
      setAlert(ui.createError, `备注不能超过 ${MAX_NOTE} 个字符。`, 'error')
      ui.createNote.focus()
      return
    }

    let expiresAt = null
    if (ui.createExpiry.value) {
      const timestamp = Date.parse(ui.createExpiry.value)
      if (!Number.isFinite(timestamp)) {
        setAlert(ui.createError, '过期时间格式无效。', 'error')
        ui.createExpiry.focus()
        return
      }
      if (timestamp <= Date.now()) {
        setAlert(ui.createError, '过期时间必须晚于当前时间。', 'error')
        ui.createExpiry.focus()
        return
      }
      expiresAt = new Date(timestamp).toISOString()
    }

    const epoch = session.epoch
    createPending = true
    setCreateBusy(true)

    try {
      const data = await request('/invites', {
        method: 'POST',
        body: { count, label, note, expiresAt }
      })
      if (epoch !== session.epoch) return

      const codes = data && Array.isArray(data.codes)
        ? data.codes.filter((code) => typeof code === 'string' && code.length > 0)
        : []
      if (!codes.length) {
        throw new ApiError(502, 'ADMIN_CREATE_EMPTY', '服务端未返回明文邀请码，请稍后重试或检查服务日志')
      }
      const items = data && Array.isArray(data.items) ? data.items : []
      showGeneratedResult({ codes, items, label, expiresAt })
      refreshAfterMutation().catch(() => {})
    } catch (error) {
      if (epoch !== session.epoch) return
      if (error.status === 401) return
      setAlert(ui.createError, `生成失败：${error.message || '请稍后重试'}`, 'error')
    } finally {
      createPending = false
      if (epoch === session.epoch) setCreateBusy(false)
    }
  }

  function setResultStatus(message, tone = '') {
    ui.resultStatus.textContent = message || ''
    ui.resultStatus.classList.remove('is-success', 'is-error')
    if (tone === 'success' || tone === 'error') ui.resultStatus.classList.add(`is-${tone}`)
  }

  function clearGeneratedSecrets() {
    generatedBatch = null
    ui.resultCodes.replaceChildren()
    ui.resultMeta.textContent = ''
    ui.resultCopy.textContent = '复制全部'
    ui.resultCopy.disabled = true
    ui.resultDownload.disabled = true
    if (copyResetTimerId) {
      window.clearTimeout(copyResetTimerId)
      copyResetTimerId = 0
    }
    setResultStatus('')
  }

  function handleResultClosed() {
    clearGeneratedSecrets()
    if (!ui.appView.hidden) {
      window.setTimeout(() => ui.createSubmit.focus(), 0)
    }
  }

  function closeGeneratedResult({ restoreFocus = true } = {}) {
    if (ui.resultDialog.open) {
      if (typeof ui.resultDialog.close === 'function') {
        ui.resultDialog.close()
      } else {
        ui.resultDialog.removeAttribute('open')
      }
    }
    clearGeneratedSecrets()
    if (restoreFocus && !ui.appView.hidden) ui.createSubmit.focus()
  }

  function showGeneratedResult({ codes, items, label, expiresAt }) {
    if (ui.resultDialog.open) closeGeneratedResult({ restoreFocus: false })
    clearGeneratedSecrets()

    generatedBatch = {
      codes: codes.slice(),
      items: items.slice(),
      label,
      expiresAt
    }

    const fragment = document.createDocumentFragment()
    codes.forEach((code, index) => {
      const item = make('li', 'result-item')
      item.append(make('span', 'result-index', String(index + 1).padStart(2, '0')))
      item.append(make('code', 'result-code', code))
      fragment.append(item)
    })
    ui.resultCodes.replaceChildren(fragment)

    const parts = [
      `数量：${codes.length}`,
      `标签：${label || '未设置'}`,
      `过期时间：${expiresAt ? formatDateTime(expiresAt, true) : '未设置'}`
    ]
    ui.resultMeta.textContent = parts.join(' · ')
    ui.resultBody.scrollTop = 0
    setResultStatus('')
    ui.resultCopy.disabled = false
    ui.resultCopy.textContent = '复制全部'
    ui.resultDownload.disabled = false

    if (typeof ui.resultDialog.showModal === 'function') {
      ui.resultDialog.showModal()
    } else {
      ui.resultDialog.setAttribute('open', '')
    }
    window.setTimeout(() => ui.resultCopy.focus(), 0)
  }

  async function copyText(text) {
    const clipboard = window.navigator && window.navigator.clipboard
    if (clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(text)
        return
      } catch {
        /* 回退到 execCommand 方式。 */
      }
    }

    const area = document.createElement('textarea')
    area.className = 'clipboard-fallback'
    area.value = text
    area.setAttribute('readonly', '')
    const host = ui.resultDialog.open ? ui.resultDialog : document.body
    host.append(area)
    try {
      area.focus()
      area.select()
      const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
      if (!copied) throw new Error('copy unavailable')
    } finally {
      area.remove()
    }
  }

  async function copyGeneratedCodes() {
    if (!generatedBatch || !generatedBatch.codes.length) return
    const count = generatedBatch.codes.length
    try {
      await copyText(generatedBatch.codes.join('\n'))
      if (!generatedBatch) return
      ui.resultCopy.textContent = '已复制'
      setResultStatus(`已复制 ${count} 个邀请码。`, 'success')
      if (copyResetTimerId) window.clearTimeout(copyResetTimerId)
      copyResetTimerId = window.setTimeout(() => {
        copyResetTimerId = 0
        if (generatedBatch) ui.resultCopy.textContent = '复制全部'
      }, 2000)
    } catch {
      if (!generatedBatch) return
      setResultStatus('复制失败，请手动选择邀请码或下载 CSV。', 'error')
    }
  }

  function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value)
    const first = text.charAt(0)
    if (first && '=+-@\t\r'.includes(first)) text = `'${text}`
    return `"${text.replace(/"/g, '""')}"`
  }

  function buildInviteCsv(batch) {
    const rows = []
    batch.codes.forEach((code, index) => {
      const item = batch.items[index] && typeof batch.items[index] === 'object' ? batch.items[index] : {}
      const label = typeof item.label === 'string' ? item.label : batch.label
      const itemExpiresAt = typeof item.expiresAt === 'string' && item.expiresAt ? item.expiresAt : ''
      rows.push([
        typeof item.id === 'string' ? item.id : '',
        code,
        label || '',
        itemExpiresAt || batch.expiresAt || ''
      ])
    })
    return `\uFEFFid,code,label,expiresAt\r\n${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`
  }

  function fileTimestamp() {
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  }

  function downloadGeneratedCsv() {
    if (!generatedBatch || !generatedBatch.codes.length) return
    const count = generatedBatch.codes.length
    const csv = buildInviteCsv(generatedBatch)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = `flylegal-invite-codes-${fileTimestamp()}.csv`
    link.rel = 'noopener'
    link.className = 'visually-hidden'
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500)
    setResultStatus(`已生成 CSV（${count} 行），请妥善保存。`, 'success')
  }

  function formatDetail(detail) {
    if (detail === null || detail === undefined) return ''
    if (typeof detail === 'string') {
      const trimmed = detail.trim()
      if (!trimmed) return ''
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2)
      } catch {
        return detail
      }
    }
    try {
      const formatted = JSON.stringify(detail, null, 2)
      return typeof formatted === 'string' ? formatted : String(detail)
    } catch {
      return String(detail)
    }
  }

  function createAuditDetail(detail) {
    const full = formatDetail(detail)
    if (!full) return make('span', 'muted', '—')

    const compact = full.replace(/\s+/g, ' ').trim()
    if (!compact) return make('span', 'muted', '—')

    const details = document.createElement('details')
    details.className = 'audit-detail'
    const summary = document.createElement('summary')
    summary.className = 'audit-detail-summary'
    summary.textContent = compact.length > 68 ? `${compact.slice(0, 68)}…` : compact
    const pre = document.createElement('pre')
    pre.className = 'audit-json'
    pre.textContent = full
    details.append(summary, pre)
    return details
  }

  function auditResultMeta(value) {
    const key = value === null || value === undefined ? '' : String(value).toLowerCase()
    if (AUDIT_RESULT_META.has(key)) return AUDIT_RESULT_META.get(key)
    return {
      label: key ? String(value) : '—',
      tone: 'neutral'
    }
  }

  function createAuditRow(item) {
    const value = item && typeof item === 'object' ? item : {}
    const row = make('tr', 'audit-row')

    appendTextCell(row, '时间', formatDateTime(value.createdAt, true), 'time-cell')

    const actionCell = makeCell('动作')
    actionCell.append(make('span', 'audit-action', textOf(value.action)))
    if (value.actor) actionCell.append(make('span', 'audit-actor', `操作者：${textOf(value.actor)}`))
    row.append(actionCell)

    const targetCell = makeCell('目标')
    const target = make('code', 'target-id', textOf(value.targetId))
    if (value.targetId) target.title = String(value.targetId)
    targetCell.append(target)
    row.append(targetCell)

    const result = auditResultMeta(value.result)
    const resultCell = makeCell('结果')
    resultCell.append(make('span', `badge badge--${result.tone}`, result.label))
    row.append(resultCell)

    const detailCell = makeCell('详情')
    detailCell.append(createAuditDetail(value.detail))
    row.append(detailCell)

    return row
  }

  function renderAuditRows(items) {
    if (!items.length) {
      setTableState(ui.auditBody, 5, '暂无审计记录。')
      return
    }
    const fragment = document.createDocumentFragment()
    items.forEach((item) => {
      fragment.append(createAuditRow(item))
    })
    ui.auditBody.replaceChildren(fragment)
  }

  async function loadAudit() {
    if (!session.token) return
    const epoch = session.epoch
    const requestId = audit.requestId + 1
    audit.requestId = requestId
    audit.loading = true
    audit.error = ''
    ui.auditRefresh.disabled = true
    ui.auditRefresh.textContent = '刷新中…'
    ui.auditTableWrap.setAttribute('aria-busy', 'true')
    updateAuditPagination()
    setTableState(ui.auditBody, 5, '正在加载审计日志…')

    const params = new URLSearchParams()
    params.set('page', String(audit.page))
    params.set('pageSize', String(audit.pageSize))

    try {
      const data = await request(`/audit?${params.toString()}`)
      if (epoch !== session.epoch || requestId !== audit.requestId) return

      const items = data && Array.isArray(data.items) ? data.items : []
      const page = toPositiveInt(data && data.page, audit.page)
      const pageSize = toPositiveInt(data && data.pageSize, audit.pageSize)
      const total = toNonNegativeInt(data && data.total, items.length)
      const totalPages = toNonNegativeInt(data && data.totalPages, pageSize > 0 ? Math.ceil(total / pageSize) : 0)

      audit.pageSize = pageSize
      audit.total = total
      audit.totalPages = totalPages

      if (totalPages > 0 && page > totalPages) {
        audit.page = totalPages
        loadAudit()
        return
      }

      audit.page = totalPages === 0 ? 1 : page
      renderAuditRows(items)
      audit.loading = false
      audit.error = ''
      ui.auditRefresh.disabled = false
      ui.auditRefresh.textContent = '刷新'
      ui.auditTableWrap.setAttribute('aria-busy', 'false')
      updateAuditPagination()
    } catch (error) {
      if (epoch !== session.epoch || requestId !== audit.requestId) return
      audit.loading = false
      if (error.status === 401) return
      audit.error = error.message || '请稍后重试'
      ui.auditRefresh.disabled = false
      ui.auditRefresh.textContent = '刷新'
      ui.auditTableWrap.setAttribute('aria-busy', 'false')
      updateAuditPagination()
      setTableState(
        ui.auditBody,
        5,
        `审计日志加载失败：${audit.error}`,
        () => {
          loadAudit()
        }
      )
    }
  }

  function bindEvents() {
    ui.loginForm.addEventListener('submit', handleLoginSubmit)
    ui.loginTotp.addEventListener('input', () => {
      const digits = ui.loginTotp.value.replace(/[^0-9]/g, '').slice(0, 6)
      if (ui.loginTotp.value !== digits) ui.loginTotp.value = digits
    })

    ui.logoutButton.addEventListener('click', () => {
      endSession('已退出登录。', 'info')
    })

    ui.statsRefresh.addEventListener('click', () => {
      loadStats()
    })
    ui.auditRefresh.addEventListener('click', () => {
      loadAudit()
    })

    ui.statusFilters.querySelectorAll('button[data-status]').forEach((button) => {
      button.addEventListener('click', () => {
        const status = button.dataset.status
        if (!FILTER_STATUSES.has(status) || status === invites.status) return
        invites.status = status
        invites.page = 1
        updateStatusFilterButtons()
        clearAlert(ui.invitesNotice)
        loadInvites()
      })
    })

    ui.inviteSearch.addEventListener('input', scheduleInviteSearch)
    ui.inviteSearch.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      commitInviteSearch()
    })

    ui.invitesPrev.addEventListener('click', () => {
      if (invites.loading || invites.page <= 1) return
      clearAlert(ui.invitesNotice)
      invites.page -= 1
      loadInvites()
    })
    ui.invitesNext.addEventListener('click', () => {
      if (invites.loading || invites.page >= invites.totalPages) return
      clearAlert(ui.invitesNotice)
      invites.page += 1
      loadInvites()
    })

    ui.auditPrev.addEventListener('click', () => {
      if (audit.loading || audit.page <= 1) return
      audit.page -= 1
      loadAudit()
    })
    ui.auditNext.addEventListener('click', () => {
      if (audit.loading || audit.page >= audit.totalPages) return
      audit.page += 1
      loadAudit()
    })

    ui.createForm.addEventListener('submit', handleCreateSubmit)

    ui.resultCopy.addEventListener('click', copyGeneratedCodes)
    ui.resultDownload.addEventListener('click', downloadGeneratedCsv)
    ui.resultClose.addEventListener('click', () => {
      closeGeneratedResult()
    })
    ui.resultCloseTop.addEventListener('click', () => {
      closeGeneratedResult()
    })
    ui.resultDialog.addEventListener('close', handleResultClosed)

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && session.token) updateSessionRemaining()
    })

    window.addEventListener('pagehide', () => {
      clearGeneratedSecrets()
      if (ui.resultDialog.open && typeof ui.resultDialog.close === 'function') ui.resultDialog.close()
    })
  }

  function init() {
    const remembered = readRememberedUsername()
    if (remembered) {
      ui.loginUsername.value = remembered
      ui.rememberUsername.checked = true
    }
    resetStatsDisplay()
    updateStatusFilterButtons()
    updateInvitesPagination()
    updateAuditPagination()
    bindEvents()
    ui.loginUsername.focus()
  }

  init()
})()
