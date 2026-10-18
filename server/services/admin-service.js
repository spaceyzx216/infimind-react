/**
 * 邀请码管理台的业务服务（列表、发码、停用、统计、审计）。
 *
 * 安全约定：
 * - 数据库存邀请码 sha256 + AES-256-GCM 密文（ADMIN_CODE_KEY 只在服务器 .env.local）；
 * - 明文只在管理员会话下解密展示（列表/复制），响应带 no-store；旧码无密文时退回哈希前缀；
 * - 审计只记动作、目标与数量，不记明文码、密码或 TOTP。
 */
import { randomUUID } from 'node:crypto'
import { decryptInviteCode, encryptInviteCode } from './invite-crypto.js'
import { generateInviteCode, hashInviteCode } from './invite-code.js'

export const INVITE_STATES = Object.freeze(['all', 'unused', 'used', 'disabled', 'expired'])

export class AdminError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'AdminError'
    this.code = code
    this.status = status
  }
}

const ISO_EPOCH = 0
const MAX_LABEL = 80
const MAX_NOTE = 500
const MAX_PAGE_SIZE = 100

const parseDate = (value) => {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : null
}

const normalizePage = (value, fallback = 1) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback
}

const normalizePageSize = (value, fallback = 20) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PAGE_SIZE ? parsed : fallback
}

const stateOf = (row, nowMs) => {
  if (row.used_at) return 'used'
  if (row.disabled_at) return 'disabled'
  if (row.expires_at && parseDate(row.expires_at) !== null && parseDate(row.expires_at) <= nowMs) return 'expired'
  return 'unused'
}

export function createAdminService({ database, config, now = () => Date.now() } = {}) {
  if (!database) throw new Error('createAdminService requires a business database')
  if (!config) throw new Error('createAdminService requires admin config')

  const auditInsert = database.prepare(`
    INSERT INTO admin_audit_log (id, actor, action, target_id, result, detail_json, ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const recordAudit = ({ actor, action, targetId = null, result = 'ok', detail = {}, ip = '', userAgent = '' }) => {
    try {
      auditInsert.run(
        randomUUID(),
        String(actor || 'ops').slice(0, 64),
        String(action),
        targetId == null ? null : String(targetId),
        String(result || 'ok'),
        JSON.stringify(detail || {}).slice(0, 4000),
        String(ip || '').slice(0, 64),
        String(userAgent || '').slice(0, 256),
        new Date(now()).toISOString()
      )
    } catch (error) {
      // 审计写失败不能阻断主流程，但必须可见。
      console.warn('[admin] audit write failed:', error.message)
    }
  }

  const countCreatedSince = database.prepare('SELECT COUNT(*) AS count FROM invite_codes WHERE created_at >= ?')
  const insertInvite = database.prepare(`
    INSERT INTO invite_codes (id, code_hash, created_at, label, note, created_by, expires_at, code_ciphertext)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const decryptCodeOf = (ciphertext, inviteId) => {
    if (!ciphertext) return null
    try {
      return decryptInviteCode(ciphertext, inviteId, config.inviteCodeKey)
    } catch (error) {
      console.warn('[admin] 邀请码密文解密失败（id 已省略）:', error.message)
      return null
    }
  }

  const createInvites = ({ actor, count, label = '', note = '', expiresAt = null, ip = '', userAgent = '' } = {}) => {
    const amount = Number(count)
    if (!Number.isInteger(amount) || amount < 1 || amount > config.maxInvitesPerRequest) {
      throw new AdminError('INVITE_COUNT_INVALID', `一次生成数量需为 1～${config.maxInvitesPerRequest}`)
    }
    const normalizedLabel = String(label || '').trim()
    const normalizedNote = String(note || '').trim()
    if (normalizedLabel.length > MAX_LABEL) throw new AdminError('INVITE_LABEL_TOO_LONG', `标签不能超过 ${MAX_LABEL} 字`)
    if (normalizedNote.length > MAX_NOTE) throw new AdminError('INVITE_NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE} 字`)
    const nowValue = now()
    let expiresIso = null
    if (expiresAt != null && String(expiresAt).trim() !== '') {
      const timestamp = parseDate(expiresAt)
      if (timestamp === null) throw new AdminError('INVITE_EXPIRES_INVALID', '过期时间格式无效')
      if (timestamp <= nowValue) throw new AdminError('INVITE_EXPIRES_INVALID', '过期时间必须晚于当前时间')
      expiresIso = new Date(timestamp).toISOString()
    }
    const dayStart = new Date(nowValue)
    dayStart.setHours(0, 0, 0, 0)
    const createdToday = countCreatedSince.get(dayStart.toISOString()).count
    if (createdToday + amount > config.maxInvitesPerDay) {
      throw new AdminError('INVITE_DAILY_LIMIT', `今日发码已达上限（${config.maxInvitesPerDay}），请调整 ADMIN_MAX_INVITES_PER_DAY 或次日再试`, 429)
    }

    const createdAt = new Date(nowValue).toISOString()
    const codes = []
    const items = []
    const transaction = database.transaction((number) => {
      while (codes.length < number) {
        const code = generateInviteCode()
        const id = randomUUID()
        try {
          insertInvite.run(id, hashInviteCode(code), createdAt, normalizedLabel, normalizedNote, actor, expiresIso, encryptInviteCode(code, id, config.inviteCodeKey))
        } catch (error) {
          if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT_UNIQUE')) continue
          throw error
        }
        codes.push(code)
        items.push({ id, hashPrefix: hashInviteCode(code).slice(0, 12), code, createdAt, expiresAt: expiresIso })
      }
    })
    transaction(amount)

    recordAudit({
      actor,
      action: 'invite.create',
      result: 'ok',
      detail: { count: amount, label: normalizedLabel, ids: items.map((item) => item.id) },
      ip,
      userAgent
    })
    return { codes, items }
  }

  // 管理台只读展示账号状态；真正的启停账号入口不在本期范围。
  const usedByOf = (row, nowMs) => {
    if (!row.username && !row.email) return null
    const expiresAt = row.account_expires_at || null
    const disabledAt = row.account_disabled_at || null
    const state = disabledAt ? 'disabled' : (expiresAt && Date.parse(expiresAt) <= nowMs ? 'expired' : 'active')
    return { username: row.username || '', email: row.email || '', expiresAt, disabledAt, state }
  }

  const listInvites = ({ status = 'all', q = '', page = 1, pageSize = 20 } = {}) => {
    const normalizedStatus = INVITE_STATES.includes(String(status)) ? String(status) : 'all'
    const keyword = String(q || '').trim()
    const nowIso = new Date(now()).toISOString()
    const where = []
    const params = []
    if (normalizedStatus === 'unused') {
      where.push("i.used_at IS NULL AND i.disabled_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > ?)")
      params.push(nowIso)
    } else if (normalizedStatus === 'used') {
      where.push('i.used_at IS NOT NULL')
    } else if (normalizedStatus === 'disabled') {
      where.push('i.used_at IS NULL AND i.disabled_at IS NOT NULL')
    } else if (normalizedStatus === 'expired') {
      where.push('i.used_at IS NULL AND i.disabled_at IS NULL AND i.expires_at IS NOT NULL AND i.expires_at <= ?')
      params.push(nowIso)
    }
    if (keyword) {
      const like = `%${keyword}%`
      where.push('(i.label LIKE ? OR i.note LIKE ? OR u.username LIKE ? OR u.email LIKE ?)')
      params.push(like, like, like, like)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const baseFrom = 'FROM invite_codes i LEFT JOIN users u ON u.id = i.used_by'
    const currentPage = normalizePage(page)
    const currentPageSize = normalizePageSize(pageSize)
    const total = database.prepare(`SELECT COUNT(*) AS count ${baseFrom} ${whereSql}`).get(...params).count
    const rows = database.prepare(`
      SELECT i.id, i.code_hash, i.code_ciphertext, substr(i.code_hash, 1, 12) AS hash_prefix, i.label, i.note,
             i.created_at, i.expires_at, i.disabled_at, i.used_at,
             u.username, u.email,
             u.expires_at AS account_expires_at, u.disabled_at AS account_disabled_at
      ${baseFrom} ${whereSql}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, currentPageSize, (currentPage - 1) * currentPageSize)
    const nowMs = now()
    return {
      items: rows.map((row) => ({
        id: row.id,
        hashPrefix: row.hash_prefix,
        code: decryptCodeOf(row.code_ciphertext, row.id),
        label: row.label || '',
        note: row.note || '',
        createdAt: row.created_at,
        expiresAt: row.expires_at || null,
        disabledAt: row.disabled_at || null,
        usedAt: row.used_at || null,
        usedBy: usedByOf(row, nowMs),
        state: stateOf(row, nowMs)
      })),
      page: currentPage,
      pageSize: currentPageSize,
      total,
      totalPages: Math.ceil(total / currentPageSize)
    }
  }

  // 供“复制全部未使用”使用：只返回可解密明文；legacy 行（无密文）计入 unavailable。
  const listInviteCodes = ({ status = 'unused', actor = 'system', ip = '', userAgent = '' } = {}) => {
    const normalizedStatus = INVITE_STATES.includes(String(status)) ? String(status) : 'unused'
    const nowMs = now()
    const rows = database.prepare('SELECT id, code_ciphertext, used_at, disabled_at, expires_at FROM invite_codes ORDER BY created_at DESC, id DESC').all()
    const codes = []
    let unavailable = 0
    for (const row of rows) {
      if (normalizedStatus !== 'all' && stateOf(row, nowMs) !== normalizedStatus) continue
      const code = decryptCodeOf(row.code_ciphertext, row.id)
      if (code) codes.push(code)
      else unavailable += 1
    }
    recordAudit({
      actor,
      action: 'invite.codes.read',
      result: 'ok',
      detail: { status: normalizedStatus, count: codes.length, unavailable },
      ip,
      userAgent
    })
    return { codes, count: codes.length, unavailable }
  }

  const disableInvite = ({ id, actor, ip = '', userAgent = '' } = {}) => {
    const inviteId = String(id || '').trim()
    if (!inviteId) throw new AdminError('INVITE_ID_REQUIRED', '缺少邀请码 ID')
    const disabledAt = new Date(now()).toISOString()
    const updated = database.prepare(`
      UPDATE invite_codes SET disabled_at = ?
      WHERE id = ? AND used_at IS NULL AND disabled_at IS NULL
    `).run(disabledAt, inviteId)
    if (updated.changes !== 1) {
      const row = database.prepare('SELECT used_at, disabled_at FROM invite_codes WHERE id = ?').get(inviteId)
      if (!row) throw new AdminError('INVITE_NOT_FOUND', '邀请码不存在', 404)
      if (row.used_at) throw new AdminError('INVITE_ALREADY_USED', '该邀请码已使用，不能停用', 409)
      throw new AdminError('INVITE_ALREADY_DISABLED', '该邀请码已停用', 409)
    }
    recordAudit({ actor, action: 'invite.disable', targetId: inviteId, result: 'ok', ip, userAgent })
    return { ok: true, id: inviteId, disabledAt }
  }

  const getStats = () => {
    const nowIso = new Date(now()).toISOString()
    const total = database.prepare('SELECT COUNT(*) AS count FROM invite_codes').get().count
    const used = database.prepare('SELECT COUNT(*) AS count FROM invite_codes WHERE used_at IS NOT NULL').get().count
    const disabled = database.prepare('SELECT COUNT(*) AS count FROM invite_codes WHERE used_at IS NULL AND disabled_at IS NOT NULL').get().count
    const expired = database.prepare(`SELECT COUNT(*) AS count FROM invite_codes
      WHERE used_at IS NULL AND disabled_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`).get(nowIso).count
    return { total, used, disabled, expired, unused: Math.max(0, total - used - disabled - expired) }
  }

  const listAudit = ({ page = 1, pageSize = 20, action = '' } = {}) => {
    const currentPage = normalizePage(page)
    const currentPageSize = normalizePageSize(pageSize, 20)
    const actionFilter = String(action || '').trim()
    const whereSql = actionFilter ? 'WHERE action = ?' : ''
    const params = actionFilter ? [actionFilter] : []
    const total = database.prepare(`SELECT COUNT(*) AS count FROM admin_audit_log ${whereSql}`).get(...params).count
    const rows = database.prepare(`
      SELECT id, actor, action, target_id, result, detail_json, created_at
      FROM admin_audit_log ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, currentPageSize, (currentPage - 1) * currentPageSize)
    return {
      items: rows.map((row) => {
        let detail = {}
        try { detail = JSON.parse(row.detail_json || '{}') } catch { detail = {} }
        return {
          id: row.id,
          actor: row.actor,
          action: row.action,
          targetId: row.target_id || null,
          result: row.result,
          detail,
          createdAt: row.created_at
        }
      }),
      page: currentPage,
      pageSize: currentPageSize,
      total,
      totalPages: Math.ceil(total / currentPageSize)
    }
  }

  return { recordAudit, createInvites, listInvites, listInviteCodes, disableInvite, getStats, listAudit }
}

export { ISO_EPOCH, MAX_PAGE_SIZE }
