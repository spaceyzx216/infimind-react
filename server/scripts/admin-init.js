/**
 * 生成/轮换运维管理台凭据。
 *
 * 用法（在本地或服务器上执行均可，输出含明文密码与 TOTP 种子，注意保管）：
 *   node server/scripts/admin-init.js --username ops --credentials-out ~/.fafee-admin-credentials.txt
 *   node server/scripts/admin-init.js --print-env        # 只生成环境变量块（默认行为）
 *
 * 输出的 ADMIN_* 块需要写入服务器 .env.local（600），然后 pm2 reload infimind-server。
 * 密码只存 scrypt 哈希；TOTP 种子与 ADMIN_JWT_SECRET 是运行时校验所需，必须与密码分开保管。
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hashAdminPassword, base32Encode } from '../services/admin-auth.js'

const argv = process.argv.slice(2)
const readArg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const username = String(readArg('username', 'ops')).trim()
if (username.length < 2 || username.length > 64) {
  console.error('用户名长度需为 2～64')
  process.exit(1)
}
const credentialsOut = readArg('credentials-out')
const generatedAt = new Date().toISOString()

const password = randomBytes(18).toString('base64url')
const passwordHash = await hashAdminPassword(password)
const totpSecret = base32Encode(randomBytes(20))
const jwtSecret = randomBytes(48).toString('base64url')
const port = readArg('port', '8791')

const envBlock = [
  '# 运维管理台（邀请码）—— 由 server/scripts/admin-init.js 于 ' + generatedAt + ' 生成',
  `ADMIN_USERNAME=${username}`,
  `ADMIN_PASSWORD_HASH=${passwordHash}`,
  `ADMIN_TOTP_SECRET=${totpSecret}`,
  `ADMIN_JWT_SECRET=${jwtSecret}`,
  `ADMIN_PORT=${port}`
].join('\n')

const otpauth = `otpauth://totp/${encodeURIComponent(`法飞飞运维管理台:${username}`)}?secret=${totpSecret}&issuer=${encodeURIComponent('法飞飞')}&algorithm=SHA1&digits=6&period=30`

if (credentialsOut) {
  const target = resolve(credentialsOut)
  const content = [
    '# 法飞飞运维管理台凭据（含明文密码与 TOTP 种子，切勿提交/外发）',
    `生成时间：${generatedAt}`,
    `用户名：${username}`,
    `密码：${password}`,
    `TOTP 种子（base32）：${totpSecret}`,
    `otpauth URI：${otpauth}`,
    '',
    '用法：',
    '1. 把「密码」与 otpauth URI/种子导入密码管理器或验证器 App（可多设备添加同一 TOTP 种子）；',
    '2. 确认 .env.local 已写入下面的 ADMIN_* 块并 pm2 reload infomind-server 后，经 SSH 隧道打开管理台；',
    '3. 登录成功后建议删除本文件，凭据只留在密码管理器与服务器 .env.local。',
    '',
    '--- 服务器 .env.local 追加内容（不要和本文件放在一起） ---',
    envBlock
  ].join('\n')
  writeFileSync(target, `${content}\n`, { mode: 0o600 })
  chmodSync(target, 0o600)
}

console.log(envBlock)
if (credentialsOut) {
  console.error(`\n[提示] 凭据文件已写入：${resolve(credentialsOut)}（权限 600）。请导入密码管理器后删除该文件。`)
} else {
  console.log('\n--- 一次性明文凭据（仅本次输出，请立即保存到密码管理器） ---')
  console.log(`用户名：${username}`)
  console.log(`密码：${password}`)
  console.log(`TOTP 种子（base32）：${totpSecret}`)
  console.log(`otpauth URI：${otpauth}`)
}
console.error('[提示] 把上面 ADMIN_* 块写入服务器 .env.local（600），然后 pm2 reload infimind-server。')
