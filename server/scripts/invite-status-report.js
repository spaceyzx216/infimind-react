// 邀请码状态看板生成器。
//
// 为什么需要单独的脚本：业务库只存 `code_hash`（sha256），看不到明文，所以看板把
// 已知明文邀请码的哈希与库里的行做匹配，得出「已使用 / 未使用」。明文清单由本脚本
// 从上一版看板 HTML 里自带的 JSON 读回（`--codes` / `--add` 可补充），这样反复刷新
// 不会丢码，也不需要在服务器上留一份明文清单。
//
// 用法：
//   node server/scripts/invite-status-report.js                     # 默认读线上库，写 ./邀请码状态.html
//   node server/scripts/invite-status-report.js --rows rows.json     # 用本地导出的行数据，不连服务器
//   node server/scripts/invite-status-report.js --add UNC8MQU,I78383S
//
// 只读：脚本对业务库只做 SELECT，不写任何数据；产出的 HTML 含可用邀请码，注意保管。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const readArg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const outPath = resolve(readArg('out', '邀请码状态.html'))
const sshTarget = readArg('ssh', process.env.INVITE_SSH || 'root@81.68.223.9')
const sshKey = readArg('ssh-key', process.env.INVITE_SSH_KEY || resolve(homedir(), '.ssh/id_ed25519'))
const rowsFile = readArg('rows')
const codesFile = readArg('codes')
const addedCodes = readArg('add')

const codeHash = (value) => createHash('sha256').update(String(value).trim().toUpperCase()).digest('hex')

// 1) 已知明文邀请码：优先读回上一版看板，再叠加 --codes / --add
const knownCodes = new Set()
const collect = (value) => {
  const code = String(value || '').trim().toUpperCase()
  if (code) knownCodes.add(code)
}
if (existsSync(outPath)) {
  try {
    const html = readFileSync(outPath, 'utf8')
    const match = html.match(/<script id="invite-data" type="application\/json">([\s\S]*?)<\/script>/)
    if (match) JSON.parse(match[1]).codes.forEach(collect)
  } catch (error) {
    console.warn(`[warn] 读取旧看板失败，改用 --codes/--add 提供的清单：${error.message}`)
  }
}
if (codesFile) {
  const text = readFileSync(resolve(codesFile), 'utf8')
  const parsed = text.trim().startsWith('[') ? JSON.parse(text) : text.split(/\s+/)
  parsed.forEach(collect)
}
addedCodes.split(',').forEach(collect)

// 2) 库里当前已有的邀请码行（只看 code_hash / 时间 / 使用者，不需要密钥）
// 远端脚本用 base64 传输：ssh 会把命令交给远端 shell 再解析一次，直接内嵌换行/引号会被吃掉。
const dumpScript = [
  "import Database from 'better-sqlite3'",
  "const db = new Database('server/data/app.db')",
  "const invites = db.prepare('select id, code_hash, created_at, used_at, used_by from invite_codes order by created_at, id').all()",
  "const users = db.prepare('select id, username, email, invite_code_id from users').all()",
  'console.log(JSON.stringify({ invites, users }))',
  'db.close()'
].join('\n')
let rows
if (rowsFile) {
  rows = JSON.parse(readFileSync(resolve(rowsFile), 'utf8'))
} else {
  const encoded = Buffer.from(dumpScript, 'utf8').toString('base64')
  const remote = `cd /www/wwwroot/www.flylegal.cn/agent-api-v2 && echo ${encoded} | base64 -d | node --input-type=module`
  const stdout = execFileSync('ssh', ['-i', sshKey, '-o', 'BatchMode=yes', sshTarget, remote], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  rows = JSON.parse(stdout.trim().split('\n').at(-1))
}

const usersById = new Map(rows.users.map((user) => [user.id, user]))
const usersByInvite = new Map(rows.users.map((user) => [user.invite_code_id, user]))
const byHash = new Map(rows.invites.map((row) => [row.code_hash, row]))

const records = []
const seenHashes = new Set()
for (const code of [...knownCodes].sort()) {
  const hash = codeHash(code)
  const row = byHash.get(hash)
  if (row) seenHashes.add(hash)
  records.push({
    code,
    hash,
    created_at: row?.created_at || '',
    used_at: row?.used_at || '',
    used_by: row?.used_by || '',
    username: row?.used_by ? usersById.get(row.used_by)?.username || '' : '',
    email: row?.used_by ? usersById.get(row.used_by)?.email || '' : '',
    state: !row ? 'missing' : row.used_at ? 'used' : 'unused'
  })
}
// 库里有、但明文对不上的行（例如别处生成的邀请码）：只展示哈希前缀，避免误认为表格漏了码
for (const row of rows.invites) {
  if (seenHashes.has(row.code_hash)) continue
  const user = row.used_by ? usersById.get(row.used_by) : usersByInvite.get(row.id)
  records.push({
    code: '',
    hash: row.code_hash,
    created_at: row.created_at || '',
    used_at: row.used_at || '',
    used_by: row.used_by || '',
    username: user?.username || '',
    email: user?.email || '',
    state: 'unknown'
  })
}

const counts = records.reduce((acc, item) => ({ ...acc, [item.state]: (acc[item.state] || 0) + 1 }), {})
const generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const data = {
  generatedAt,
  source: rowsFile ? `本地行数据 ${resolve(rowsFile)}` : `${sshTarget} · agent-api-v2/server/data/app.db`,
  codes: records.filter((item) => item.code).map((item) => item.code),
  rows: records
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>法飞飞 · 邀请码状态</title>
<style>
  :root { --ink:#221f1d; --muted:#8b817b; --line:#eee7e1; --bg:#faf7f4; --card:#fff; --brand:#e35f00; --ok:#1f8a53; --okbg:#eaf7f0; --warn:#a3562c; --warnbg:#fdf3ec; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 20px 60px; background:var(--bg); color:var(--ink); font:15px/1.6 "PingFang SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .page { max-width:1080px; margin:0 auto; }
  header h1 { margin:6px 0 4px; font-size:26px; letter-spacing:-.4px; }
  .brand { color:var(--brand); font-size:13px; font-weight:700; letter-spacing:.4px; }
  .meta { margin:0 0 22px; color:var(--muted); font-size:13px; }
  .stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
  .stat { padding:14px 16px; background:var(--card); border:1px solid var(--line); border-radius:14px; }
  .stat .label { display:block; color:var(--muted); font-size:12px; }
  .stat strong { display:block; margin-top:2px; font-size:26px; font-variant-numeric:tabular-nums; }
  .stat.ok strong { color:var(--ok); } .stat.used strong { color:var(--warn); }
  .bar { height:8px; margin:14px 0 22px; overflow:hidden; background:#efe8e2; border-radius:999px; }
  .bar i { display:block; height:100%; background:linear-gradient(90deg,#e35f00,#c4551f); border-radius:999px; transition:width .3s ease; }
  .toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-bottom:14px; }
  .toolbar input { flex:1 1 240px; min-width:0; padding:10px 12px; background:var(--card); border:1px solid var(--line); border-radius:11px; font:14px inherit; }
  .toolbar input:focus { border-color:#e08a4c; outline:none; box-shadow:0 0 0 3px rgb(224 138 76 / 14%); }
  .chips { display:flex; gap:6px; }
  .chips button, .ghost { padding:9px 13px; color:#6b625c; background:var(--card); border:1px solid var(--line); border-radius:11px; font:14px inherit; cursor:pointer; }
  .chips button.active { color:#fff; background:#221f1d; border-color:#221f1d; }
  .ghost:hover, .chips button:hover { border-color:#d9cec6; }
  table { width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; background:var(--card); border:1px solid var(--line); border-radius:14px; }
  th, td { padding:11px 14px; text-align:left; border-bottom:1px solid var(--line); font-size:14px; vertical-align:middle; }
  th { color:var(--muted); background:#fdfbfa; font-size:12px; font-weight:600; white-space:nowrap; }
  tbody tr:last-child td { border-bottom:0; }
  tbody tr.used { background:#fcfaf9; }
  tbody tr.used .code { color:#a49b95; }
  tbody tr.hidden { display:none; }
  .idx { color:#b9b0aa; font-variant-numeric:tabular-nums; }
  .code { display:inline-flex; align-items:center; gap:8px; font:600 15px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.9px; }
  .copy { padding:3px 8px; color:var(--muted); background:#f7f3f0; border:0; border-radius:7px; font:12px inherit; cursor:pointer; }
  .copy:hover { color:var(--brand); background:#fdeee3; }
  .badge { display:inline-block; padding:3px 9px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap; }
  .badge.unused { color:var(--ok); background:var(--okbg); }
  .badge.used { color:var(--warn); background:var(--warnbg); }
  .badge.unknown, .badge.missing { color:#6b625c; background:#f2eeea; }
  .time { color:#6f675f; font-size:13px; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .who { color:#4a443f; font-size:13px; }
  .who small { display:block; color:var(--muted); }
  .empty { padding:22px; color:var(--muted); text-align:center; }
  .note { margin:18px 0 0; color:var(--muted); font-size:12.5px; line-height:1.8; }
  .note code { padding:1px 6px; background:#f2eeea; border-radius:6px; font-size:12px; }
  .toast { position:fixed; left:50%; bottom:26px; padding:10px 18px; color:#fff; background:#221f1d; border-radius:999px; font-size:13px; opacity:0; transform:translate(-50%,10px); transition:.22s ease; pointer-events:none; }
  .toast.show { opacity:1; transform:translate(-50%,0); }
  @media (max-width:720px) {
    body { padding:18px 12px 48px; }
    .stats { grid-template-columns:repeat(2,minmax(0,1fr)); }
    thead { display:none; }
    table, tbody, tr, td { display:block; width:100%; }
    table { border:0; background:transparent; }
    tr { margin-bottom:10px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:6px 4px; }
    td { border:0; padding:6px 12px; }
    td:before { content:attr(data-label); display:block; color:var(--muted); font-size:11px; }
  }
  @media print { .toolbar, .copy, .toast { display:none !important; } body { background:#fff; padding:0; } }
</style>
</head>
<body>
<div class="page">
  <header>
    <div class="brand">法飞飞 AI · www.flylegal.cn</div>
    <h1>邀请码状态</h1>
    <p class="meta">数据来源：${data.source} · 生成时间：${generatedAt}</p>
  </header>

  <section class="stats">
    <div class="stat"><span class="label">邀请码总数</span><strong id="stat-total">0</strong></div>
    <div class="stat ok"><span class="label">未使用</span><strong id="stat-unused">0</strong></div>
    <div class="stat used"><span class="label">已使用</span><strong id="stat-used">0</strong></div>
    <div class="stat"><span class="label">使用率</span><strong id="stat-rate">0%</strong></div>
  </section>
  <div class="bar"><i id="stat-bar"></i></div>

  <section class="toolbar">
    <input id="search" type="search" placeholder="搜索邀请码 / 用户名 / 邮箱" autocomplete="off" />
    <div class="chips">
      <button type="button" data-filter="all" class="active">全部</button>
      <button type="button" data-filter="unused">未使用</button>
      <button type="button" data-filter="used">已使用</button>
    </div>
    <button type="button" class="ghost" id="copy-unused">复制全部未使用邀请码</button>
  </section>

  <table>
    <thead>
      <tr><th>#</th><th>邀请码</th><th>状态</th><th>生成时间</th><th>使用时间</th><th>使用者</th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <p class="empty" id="empty" hidden>没有符合条件的邀请码。</p>

  <p class="note">
    邀请码库只保存 <code>sha256</code> 哈希，明文由本文件自带；<b>如重新生成看板，请保留本文件</b>（脚本会从这里的
    <code>invite-data</code> 读回明文清单）。刷新命令：
    <code>node server/scripts/invite-status-report.js</code>。本文件含可直接注册的邀请码，请勿外发或提交到代码库。
  </p>
</div>
<div class="toast" id="toast"></div>
<script id="invite-data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>
  const data = JSON.parse(document.getElementById('invite-data').textContent)
  const stateLabel = { unused: '未使用', used: '已使用', unknown: '明文未知', missing: '已失效' }
  const rowsEl = document.getElementById('rows')
  const emptyEl = document.getElementById('empty')
  const searchEl = document.getElementById('search')
  const toastEl = document.getElementById('toast')
  let filter = 'all'

  const fmt = (value) => {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  }
  const escape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

  function toast(message) {
    toastEl.textContent = message
    toastEl.classList.add('show')
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => toastEl.classList.remove('show'), 1600)
  }
  function copy(text, message) {
    const done = () => toast(message)
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).then(done, () => fallback()) } else fallback()
    function fallback() {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      try { document.execCommand('copy'); done() } catch { toast('复制失败，请手动选择') }
      area.remove()
    }
  }

  function render() {
    const keyword = searchEl.value.trim().toLowerCase()
    const visible = data.rows.filter((row) => {
      if (filter !== 'all' && row.state !== filter) return false
      if (!keyword) return true
      return [row.code, row.username, row.email, row.used_at].join(' ').toLowerCase().includes(keyword)
    })
    rowsEl.innerHTML = visible.map((row) => {
      const index = data.rows.indexOf(row) + 1
      const who = row.username || row.email
        ? \`\${escape(row.username)}<small>\${escape(row.email)}</small>\`
        : '—'
      return \`<tr class="\${row.state === 'used' ? 'used' : ''}">
        <td class="idx" data-label="序号">\${index}</td>
        <td data-label="邀请码"><span class="code">\${row.code ? escape(row.code) : escape(row.hash.slice(0, 12) + '…')}\${row.code ? \`<button type="button" class="copy" data-code="\${escape(row.code)}">复制</button>\` : ''}</span></td>
        <td data-label="状态"><span class="badge \${row.state}">\${stateLabel[row.state] || row.state}</span></td>
        <td class="time" data-label="生成时间">\${fmt(row.created_at)}</td>
        <td class="time" data-label="使用时间">\${fmt(row.used_at)}</td>
        <td class="who" data-label="使用者">\${who}</td>
      </tr>\`
    }).join('')
    emptyEl.hidden = visible.length > 0
    const unused = data.rows.filter((row) => row.state === 'unused')
    const used = data.rows.filter((row) => row.state === 'used')
    // 使用率只统计可用的邀请码（已使用 + 未使用），不含明文未知/已失效的行
    const rate = used.length + unused.length ? Math.round((used.length / (used.length + unused.length)) * 100) : 0
    document.getElementById('stat-total').textContent = data.rows.length
    document.getElementById('stat-unused').textContent = unused.length
    document.getElementById('stat-used').textContent = used.length
    document.getElementById('stat-rate').textContent = rate + '%'
    document.getElementById('stat-bar').style.width = rate + '%'
  }

  rowsEl.addEventListener('click', (event) => {
    const button = event.target.closest('.copy')
    if (!button) return
    copy(button.dataset.code, '已复制 ' + button.dataset.code)
  })
  document.querySelectorAll('.chips button').forEach((button) => button.addEventListener('click', () => {
    filter = button.dataset.filter
    document.querySelectorAll('.chips button').forEach((item) => item.classList.toggle('active', item === button))
    render()
  }))
  searchEl.addEventListener('input', render)
  document.getElementById('copy-unused').addEventListener('click', () => {
    const codes = data.rows.filter((row) => row.state === 'unused' && row.code).map((row) => row.code)
    if (!codes.length) return toast('没有未使用的邀请码')
    copy(codes.join('\\n'), \`已复制 \${codes.length} 个未使用邀请码\`)
  })
  render()
</script>
</body>
</html>
`

writeFileSync(outPath, html, 'utf8')
const summary = ['unused', 'used', 'unknown', 'missing'].map((state) => `${state}=${counts[state] || 0}`).join(' ')
console.log(`邀请码看板已写入：${outPath}`)
console.log(`共 ${records.length} 条（明文匹配 ${data.codes.length} 个）：${summary}`)
if (counts.unknown) console.log('提示：有行的明文不在清单里（哈希前缀已展示），刷新时可用 --add 补充明文。')
