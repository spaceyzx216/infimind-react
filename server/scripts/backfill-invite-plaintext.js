/**
 * 为历史邀请码补写加密明文（一次性迁移）。
 *
 * 背景：旧版数据库只存 sha256，后台无法再次展示明文。现在新增
 * invite_codes.code_ciphertext（AES-256-GCM）后，可用运维手中保存的明文清单
 * 把历史码补成密文，从而在管理台可见。
 *
 * 用法（服务器或本机，读取 .env.local 的 ADMIN_CODE_KEY、通过 BUSINESS_DB_PATH 指定库）：
 *   node server/scripts/backfill-invite-plaintext.js --codes ./known-codes.txt [--dry-run]
 *
 * 文件格式：每行一个邀请码（大小写不敏感，空行与 # 注释忽略）。
 * 只匹配 hash 完全一致的已有行；不新增行、不改变使用状态。输出只打印计数，不打印明文。
 */
import dotenv from 'dotenv'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createBusinessDatabase } from '../services/business-db.js'
import { decryptInviteCode, encryptInviteCode, loadInviteCodeKey } from '../services/invite-crypto.js'
import { hashInviteCode, normalizeInviteCode } from '../services/invite-code.js'

const argv = process.argv.slice(2)
const readArg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const hasFlag = (name) => argv.includes(`--${name}`)

/**
 * @param {object} database better-sqlite3 连接（已跑过 schema 迁移）
 * @param {string[]} codes 已知明文邀请码
 * @param {Buffer} key 32 字节 AES key
 * @returns {{ matched:number, updated:number, unchanged:number, unmatched:number }}
 */
export function backfillInvitePlaintext(database, codes, key) {
  const find = database.prepare('SELECT id, code_hash, code_ciphertext FROM invite_codes WHERE code_hash = ?')
  const update = database.prepare('UPDATE invite_codes SET code_ciphertext = ? WHERE id = ?')
  const result = { matched: 0, updated: 0, unchanged: 0, unmatched: 0 }
  const apply = database.transaction((list) => {
    for (const raw of list) {
      const code = normalizeInviteCode(raw)
      if (!code) continue
      const row = find.get(hashInviteCode(code))
      if (!row) {
        result.unmatched += 1
        continue
      }
      result.matched += 1
      if (row.code_ciphertext) {
        try {
          if (decryptInviteCode(row.code_ciphertext, row.id, key) === code) {
            result.unchanged += 1
            continue
          }
        } catch {
          // 旧密文无法解密（例如密钥已轮换）：用新密钥重写。
        }
      }
      update.run(encryptInviteCode(code, row.id, key), row.id)
      result.updated += 1
    }
  })
  apply(codes)
  return result
}

function readCodesFile(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  dotenv.config({ path: new URL('../../.env.local', import.meta.url), quiet: true })
  const codesFile = readArg('codes')
  if (!codesFile) {
    console.error('用法：node server/scripts/backfill-invite-plaintext.js --codes <文件> [--dry-run]')
    process.exit(1)
  }
  const key = loadInviteCodeKey(process.env.ADMIN_CODE_KEY)
  const database = createBusinessDatabase()
  try {
    const codes = readCodesFile(codesFile)
    if (hasFlag('dry-run')) {
      const preview = backfillInvitePlaintext(database, codes, key)
      console.log(`[dry-run] 未知/未匹配 ${preview.unmatched}，已匹配 ${preview.matched}（不会写入）`)
    } else {
      const summary = backfillInvitePlaintext(database, codes, key)
      console.log(`回填完成：匹配 ${summary.matched}，写入 ${summary.updated}，已存在 ${summary.unchanged}，未匹配 ${summary.unmatched}`)
      console.log('提示：未匹配通常是想回填的码在库里不存在（或已被删除）；请核对哈希后重试。')
    }
  } finally {
    database.close()
  }
}
