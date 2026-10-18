/**
 * 邀请码明文的可逆保护（运维后台展示用）。
 *
 * 背景：业务库原先只存 sha256，后台只有生成时能看到一次明文，无法再次分发。
 * 现在把明文用 AES-256-GCM 加密后存 `invite_codes.code_ciphertext`：
 * - 密钥 `ADMIN_CODE_KEY` 只放服务器 `.env.local`（32 字节，base64/base64url）；
 * - 使用随机 IV 与 invite id 作为 AAD，行被搬到别的 id 下无法解密；
 * - 数据库/备份单独泄露不能还原邀请码；只有同时拿到服务器环境变量（或 root）才可以。
 *
 * 注意：这是安全性与可运维性的取舍，比“只存哈希”弱；如不接受，应把
 * ADMIN_CODE_KEY 从环境中移除并删除 code_ciphertext。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

const aadOf = (inviteId) => Buffer.from(`invite-code:${String(inviteId)}`, 'utf8')

export function generateInviteCodeKey() {
  return randomBytes(KEY_BYTES).toString('base64url')
}

/** 接受 base64url 或标准 base64；必须是 32 字节。 */
export function loadInviteCodeKey(raw) {
  const text = String(raw || '').trim()
  if (!text) throw new Error('缺少 ADMIN_CODE_KEY')
  let key
  try {
    key = Buffer.from(text, 'base64url')
  } catch {
    throw new Error('ADMIN_CODE_KEY 不是合法 base64url')
  }
  if (key.length !== KEY_BYTES) throw new Error('ADMIN_CODE_KEY 必须是 32 字节（base64url 编码）')
  return key
}

/** @returns {string} `v1:<iv>:<tag>:<cipher>`（base64url） */
export function encryptInviteCode(code, inviteId, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('邀请码加密密钥无效')
  const plaintext = String(code || '')
  if (!plaintext) throw new Error('不能加密空邀请码')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(aadOf(inviteId))
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':')
}

/** 解密；格式/密钥/AAD 不匹配都会抛错，调用方应视为“明文不可用”。 */
export function decryptInviteCode(payload, inviteId, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('邀请码解密密钥无效')
  const parts = String(payload || '').split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('邀请码密文格式无效')
  const iv = Buffer.from(parts[1], 'base64url')
  const tag = Buffer.from(parts[2], 'base64url')
  const encrypted = Buffer.from(parts[3], 'base64url')
  if (iv.length !== IV_BYTES) throw new Error('邀请码密文 IV 无效')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAAD(aadOf(inviteId))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export const INVITE_CODE_CIPHER_VERSION = VERSION
