# 法飞飞 AI · 全栈 Agent 系统化改造方案

> 版本：v1（2026-08 基线）
> 代码基线：`infimind-react` 归档副本（**注意：当前目录不是 Git 仓库**）
> 依据文档：`HANDOFF.md`、`docs/prd.md`、`README.md`、`docs/实习生上岗准备清单-全栈Agent改造.md`
> 依据代码：CodeGraph 索引（205 文件 / 2245 节点 / 5515 边）+ 全量核心文件通读

---

## 一、现状盘点

### 1.1 一句话总结

当前系统是一个**匿名可用的单进程 AI 试用站**：技术含量集中在「多 Agent 审查管线 + 服务端可信性校验」，但**没有用户、没有持久化、没有队列**。要变成 Agent 系统网站，缺的不是 AI 能力，而是**平台底座**（账号 / 任务 / 事件 / 配额 / 可观测）。

### 1.2 已有能力（不要重写，直接复用）

| 层 | 现状 | 位置 |
| --- | --- | --- |
| 前端 | React 18 + Vite 5 + React Router 7，手写 CSS，4 条路由 | `src/App.jsx`、`src/pages/` |
| 官网 | 首页/关于页/客户背书/咨询入口 | `src/pages/HomePage.jsx`、`AboutPage.jsx` |
| 工作台 UI | 审查页 844 行（多会话、SSE 消费、批注三明治视图、Word 导出）；起草页 313 行 | `ContractRewritePage.jsx`、`ContractDraftPage.jsx` |
| 后端 | Express 4 单入口，1 个路由文件承载 6 个接口 | `server/index.js`、`server/routes/contract-rewrite.js` |
| 流式 | 手写 SSE（`res.writeHead` + `res.write`） | 同上 |
| 多 Agent | 4 个 Agent（分析 / 审查 / 归并 / 改写）+ 协议化提示词 | `server/agents/`、`server/prompts/` |
| **可信层** | finding 定位、去重、归并、修订合并（**项目护城河**） | `annotation-locator.js`、`finding-consolidator.js`、`revision-merger.js` |
| 知识库 | SQLite + FTS5 + BM25，可选 Qdrant 向量 + bge-reranker | `knowledge-base.js`、`vector-store.js`、`evidence-reranker.js` |
| 文件解析 | PDF/DOC/DOCX/Office/图片 OCR（jimp + Tesseract） | `file-parser.js` |
| 模型接入 | OpenAI 兼容，DeepSeek 快速/深度双模型 | `llm-client.js` |
| 部署 | pm2 fork 单实例 + Nginx 反代 | `ecosystem.config.cjs` |

### 1.3 缺失能力（改造对象）

| 缺口 | 现状证据 | 后果 |
| --- | --- | --- |
| **无用户体系** | 身份 = localStorage 随机 `clientId`，仅审查页通过 `X-Client-ID` 请求头传递 | 无法准入、无法计费、无法审计 |
| **无鉴权** | `server/index.js:15` 是 `app.use(cors())` 全开；所有 `/api/*` 匿名可打 | 任何人可白嫖模型额度 |
| **会话内存态** | `review-session-store.js` = `new Map()`，TTL 2h，全局 500 / 每端 30 | 重启即丢；多实例不共享 |
| **历史在前端** | 4 个 localStorage key：`fafee-contract-threads-v1`、`-tasks-v1`、`fafee-contract-draft-*-v1` | 换设备即丢，无法做任务中心 |
| **无任务模型** | 一次请求 = 一条挂着数分钟的 SSE 长连接，跑完整条管线 | 断线即前功尽弃；无法排队/取消/重试/限流 |
| **管线硬编码** | 管线是 `contract-rewrite.js:368-874` 里约 400 行顺序代码 | 加一个新产品要复制一遍路由 |
| **无成本核算** | `llm-client.js:133-137` 只 `console.log` token；流式的 `totalTokens` 算了但丢弃 | 无法配额、无法定价 |
| **余额是全局的** | `GET /api/account/balance` 返回服务端 API Key 的账户余额 | 匿名用户能看到公司账上还有多少钱 |
| **可观测性缺失** | 只有 `console.log/warn/error`，无 requestId/taskId | 线上排障靠猜 |
| **lint 不可用** | ESLint 9 但缺 `eslint.config.*` | 无静态门禁 |
| **无版本控制** | 当前目录 `git rev-parse` 失败 | 改错了回不去 |

### 1.4 三个结构性卡脖子问题

1. **连接即任务**：SSE 长连接的生命周期 = 任务生命周期。这决定了无法排队、无法断线重连、无法多实例。→ 必须拆成「提交任务」+「订阅事件」两段。
2. **管线即路由**：编排逻辑写在 HTTP handler 里，`writeSSE` 闭包与业务逻辑耦合。→ 必须把 `writeSSE` 抽成 `emit`，管线体抽成可注册的 workflow。
3. **身份即浏览器**：`clientId` 只能防串会话，不能承担授权。→ 必须引入 `userId`，并把 `review-session-store` 的归属校验换成真正的所有权校验。

---

## 二、目标架构

### 2.1 分层图

```
┌─────────────────────────────────────────────────────────────┐
│ 公开官网（不改）  /  /aboutus                                  │
├─────────────────────────────────────────────────────────────┤
│ 认证层    /login  /register(邀请码)                           │
├─────────────────────────────────────────────────────────────┤
│ 工作台    /app  产品矩阵 · 最近任务 · 额度                      │
│          /app/contract-rewrite  /app/contract-draft          │
│          /app/tasks  /app/tasks/:id                          │
│          /admin/invites  /admin/tasks  （管理员）              │
├─────────────────────────────────────────────────────────────┤
│ API 网关层  鉴权中间件 · 限流 · 统一错误格式 · requestId · 审计    │
├──────────────┬──────────────┬──────────────┬────────────────┤
│ 账号与邀请码   │ 任务服务      │ 文件服务      │ 管理后台 API     │
│ auth-service │ task-service │ file-store   │ admin routes   │
├──────────────┴──────────────┴──────────────┴────────────────┤
│ 任务队列 + Worker（并发控制 · 取消 · 重试 · 背压）               │
├─────────────────────────────────────────────────────────────┤
│ 工作流引擎  products.js → workflow registry → steps[]         │
│   step: parse | retrieve | llm | validate | assemble         │
├─────────────────────────────────────────────────────────────┤
│ 模型网关  model-gateway（超时/重试/并发/token计量/成本/降级）      │
├─────────────────────────────────────────────────────────────┤
│ 知识库服务（复用）   │  可信性校验服务（复用，红线不可动）           │
├─────────────────────────────────────────────────────────────┤
│ 存储：app.db（SQLite WAL，用户/任务/事件/产物/审计）+ 上传文件目录   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据模型（`server/data/app.db`）

沿用 `knowledge-base.js` 已验证的 better-sqlite3 模式（WAL + `foreign_keys = ON` + 启动建表）。

```sql
-- 用户与准入
users(id, email UNIQUE, phone, name, password_hash, password_salt,
      role TEXT DEFAULT 'user',        -- user | admin
      status TEXT DEFAULT 'active',    -- active | disabled
      invite_code, quota_json, created_at, last_login_at)

invites(code PRIMARY KEY, batch, max_uses, used_count DEFAULT 0,
        expires_at, permissions_json, note, status DEFAULT 'active',
        created_by, created_at)

sessions(id, user_id REFERENCES users(id), token_hash UNIQUE,
         expires_at, created_at, ip, user_agent, revoked_at)

-- 任务与事件（核心）
tasks(id, user_id, product_id, workflow_id, workflow_version,
      status,                          -- queued|running|succeeded|failed|canceled
      input_json, error, progress,
      tokens_in DEFAULT 0, tokens_out DEFAULT 0, cost_cents DEFAULT 0,
      created_at, started_at, finished_at, idempotency_key)

task_events(id, task_id, seq, event_type, payload_json, created_at)
      -- 唯一索引 (task_id, seq)；这是 SSE 重放与断线重连的唯一依据

task_artifacts(id, task_id, kind,   -- source|analysis|review|revision|export
               content TEXT, content_path, sha256, meta_json, created_at)

uploads(id, user_id, task_id, original_name, mime, size, sha256,
        storage_path, expires_at, created_at)

conversations(id, user_id, product_id, title, created_at, updated_at)
messages(id, conversation_id, role, content, meta_json, created_at)

audit_logs(id, user_id, event_type, target, ip, detail_json, created_at)
```

迁移框架：`server/db/migrations/00X_*.sql` + `PRAGMA user_version` 版本的极简 runner（约 40 行），不引入 ORM。

**为什么是 SQLite 而不是直接上 Postgres**：MVP 目标是 200 并发会话 / 50 并发长任务（PRD NFR-001），单机 SQLite WAL 完全够；写入集中在任务与事件表，量级是「每任务几十条事件」，不是高频写。升级路径写在 `db/index.js` 一处，Growth 期换 Postgres + Redis 时上层不改。

### 2.3 关键设计决策

| 决策 | 选择 | 理由 | 被否方案 |
| --- | --- | --- | --- |
| 登录态 | **httpOnly 服务端 Session Cookie** | 可撤销、SSE 天然带 Cookie、合同类敏感数据不该暴露给 JS | JWT 存 localStorage（XSS 可窃、无法撤销、SSE 要 query 传 token） |
| 口令哈希 | `node:crypto` scrypt | 零新依赖，参数可调 | bcrypt（多一个原生模块）/ argon2（编译负担） |
| 任务执行 | MVP 单进程有界队列 + 状态落库 | 与现有 pm2 fork 单实例一致，改造量最小 | 直接上 BullMQ（引入 Redis 运维成本，MVP 阶段过度设计） |
| SSE 语义 | **事件溯源 + `id:` 序号 + 重放** | 断线/刷新/换设备都能续看；顺带满足 FR-012 | 现状的「一次性推送」（丢了就没了） |
| 管线抽象 | Step 数组 + 注册表，**管线体原样搬运** | 400 行编排逻辑零改动迁移，风险最低 | 重写成声明式 DSL（引入行为差异风险） |
| 可信层 | 保持服务端强校验，**不变** | 项目最重要的工程原则 | 「让模型直接输出最终稿」（HANDOFF 明令禁止） |

---

## 三、分阶段实施路线

> 工作量按「熟悉项目的 1 名全栈」估算，2-3 人可并行压缩。

### Sprint 0：基线与护栏（3-5 人日）· 必须最先做

| 任务 | 产出 |
| --- | --- |
| 建立版本控制 | 在**真实 clone**（`git@github.com:spaceyzx216/infimind-react.git`）上开分支 `feat/agent-platform`；当前归档副本不要直接改 |
| 修复 lint | 新增 `eslint.config.js`（flat config，react + hooks + refresh），`npm run lint` 可用 |
| CI 门禁 | `npm run lint && npm run build && node --check server/**/*.js && npm run test:consolidation && test:word-annotations && test:concurrency` |
| 管线基线快照 | 用同一份脱敏合同跑一次完整审查，把 `rewrite.result` 落成 golden fixture，供 Sprint 2 做平移等价性验证 |

**验收**：新人 clone → `npm ci` → 四连命令全绿。

### Sprint 1：账号体系与准入（5-8 人日）

**新增**
```
server/db/index.js                       # app.db 连接 + 迁移 runner
server/db/migrations/001_accounts.sql
server/services/auth-service.js          # register / login / logout / verifySession
server/services/invite-service.js        # validate / consume / create / disable / list
server/middleware/auth.js                # requireAuth / requireAdmin / optionalAuth
server/middleware/rate-limit.js          # 登录爆破防护（令牌桶）
server/routes/auth.js                    # /api/auth/*
server/routes/admin.js                   # /api/admin/invites/*
src/context/AuthContext.jsx
src/components/RequireAuth.jsx
src/api/client.js                        # fetch 封装：credentials/include、401 跳登录、错误归一
src/pages/LoginPage.jsx / RegisterPage.jsx / .css
```

**接口**
```
POST /api/auth/register   { inviteCode, email, password, name } → 201 + Set-Cookie
POST /api/auth/login      { email, password }                   → 200 + Set-Cookie
POST /api/auth/logout                                            → 204
GET  /api/auth/me                                                → { id, name, role, permissions, quota }
POST /api/admin/invites   { batch, maxUses, expiresAt, ... }     → 201（管理员）
GET  /api/admin/invites?status=                                  → 列表（管理员）
```

**修改**
- `server/index.js`：`cors()` → `cors({ origin: [SITE_ORIGIN], credentials: true })`；挂载 auth/admin 路由；`cookie-parser`（或手写 10 行解析，避免新依赖）。
- `server/routes/contract-rewrite.js`：所有业务接口加 `requireAuth`；`requestClientId` 逐步替换为 `req.user.id`。
- `src/App.jsx`：新增路由 + `RequireAuth` 包裹 `/app/*`；`AuthProvider` 包在 `BrowserRouter` 外层。
- `src/components/Header.jsx`：右上角改为「未登录 → 登录/注册」「已登录 → 用户名 / 工作台 / 退出」。
- `GET /api/account/balance` → 改为**用户自己的额度** `GET /api/account/quota`；DeepSeek 账户余额降级到 `/api/admin/account/balance`。

**注册事务（务必一个事务内完成）**
```
BEGIN
  校验 invite：status=active 且 (expires_at IS NULL OR expires_at > now) 且 used_count < max_uses
  校验 email 未占用
  INSERT users（scrypt 哈希）
  UPDATE invites SET used_count = used_count + 1
  INSERT audit_logs（invite_code, user_id, ip）
COMMIT
```

**验收**：无邀请码/过期/禁用/超次数的邀请码均被拒绝且返回明确原因（FR-001）；未登录访问 `/app/*` 跳登录；退出后受保护接口返回 401。

### Sprint 2：任务化 + 事件溯源 + 工作流抽象（8-12 人日）· 改造核心

**2.1 事件存储与订阅（新增）**
```
server/services/event-store.js
  append(taskId, eventType, payload) -> seq        # 单调递增，落库
  listSince(taskId, seq) -> rows                    # 重放
  subscribe(taskId, cb) -> unsubscribe              # MVP：进程内 EventEmitter
```

**2.2 SSE 端点改造要点**

现状：
```js
res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
```
目标（**必须带 `id:`，否则 `Last-Event-ID` 机制无效**）：
```js
res.write(`id: ${seq}\nevent: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`)
```

```js
// GET /api/tasks/:id/events
const task = getTask(id)
if (!task || task.userId !== req.user.id) return res.status(404).end()
const since = Number(req.get('Last-Event-ID') || req.query.since || 0)
res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
                     'Cache-Control': 'no-cache, no-transform',
                     'X-Accel-Buffering': 'no', Connection: 'keep-alive' })
for (const ev of listSince(id, since)) writeEvent(ev)        // 先重放历史
if (['succeeded','failed','canceled'].includes(task.status)) return res.end()
const unsub = subscribe(id, writeEvent)
const hb = setInterval(() => res.write(': ping\n\n'), 15000)  // 心跳防代理断连
req.on('close', () => { clearInterval(hb); unsub() })
```

**2.3 任务接口（新增 `server/routes/tasks.js`）**
```
POST   /api/tasks               multipart，submitter 立即返回 202 { taskId, eventsUrl }
                                支持 Idempotency-Key 头防重复提交
GET    /api/tasks?status=&cursor=&limit=      任务列表（FR-036）
GET    /api/tasks/:id                          状态 / 结果 / 失败原因（FR-012）
GET    /api/tasks/:id/events                   SSE 订阅（带重放）
POST   /api/tasks/:id/cancel                   排队中直接取消；执行中发 AbortSignal
GET    /api/tasks/:id/export.docx              服务端生成（可选，见 2.6）
```

**2.4 工作流抽象（最小改动搬运）**

新增：
```
server/workflows/types.js               # defineWorkflow / defineStep 契约
server/workflows/registry.js            # workflowId -> definition
server/workflows/contract-review/
  index.js                              # steps 编排
  steps/parse-files.js
  steps/analyze.js                      # → analyzeContract()
  steps/retrieve-evidence.js            # → buildReviewPlan + searchEvidence
  steps/review-rounds.js                # → 三轮循环
  steps/consolidate.js                  # → consolidateContractFindings + buildRevisionGroups
  steps/rewrite.js                      # → rewriteContract + mergeRevisions + 分批补全
  steps/assemble-result.js              # → rewrite.result payload
server/workflows/contract-draft/index.js
server/services/task-queue.js           # 有界队列 + 并发上限 + 背压
server/services/task-service.js         # create / get / list / cancel / run
```

**迁移手法（低风险关键）**：把 `contract-rewrite.js:368-874` 的管线体**整段搬进 step**，只把两处替换掉：

| 现状 | 目标 |
| --- | --- |
| `writeSSE(event, data)` | `ctx.emit(event, data)`（`emit` 内部 = 落库 + 推送订阅者） |
| `modelProfile.model` 局部变量 | `ctx.model` / `ctx.services.llm` |

其余包括注释、三层审查循环、分批降级补全、`mergeRevisions` 兜底——**一行逻辑都不改**。

Step 契约：
```js
/**
 * @typedef {object} StepContext
 * @property {object} task              # { id, userId, productId, input }
 * @property {Record<string, any>} bag  # 步骤间产物传递（引用式，不序列化大文本）
 * @property {(event: string, data: object) => void} emit
 * @property {AbortSignal} signal
 * @property {{ llm, kb, files, logger }} services
 */
export const analysisStep = {
  id: 'analysis',
  label: '正在分析合同结构与要素完整性',
  errorPolicy: 'fail-fast',              // fail-fast | fallback | skip
  async run(ctx) {
    ctx.emit('stage.start', { stage: 'analysis', label: this.label })
    const report = await analyzeContract(ctx.bag.contractText,
      (chunk) => ctx.emit('analysis.delta', { content: chunk }), ctx.model)
    ctx.bag.analysisReport = report
    ctx.emit('stage.complete', { stage: 'analysis', summary: '合同结构分析完成' })
  }
}
```

**等价性验收（本 Sprint 的硬门槛）**：用 Sprint 0 的 golden fixture 跑新工作流，断言 `rewrite.result` 的 `revisions`、`stats`、每条 `findingId/anchor/localizedEdits` 与基线**逐字段一致**。这是「400 行搬运」唯一可信的安全网。

**2.5 取消与超时**
- `llm-client.js` 的 `deepseekFetch` / `streamChat` 增加 `signal` 参数，透传给 `fetch`。
- Worker 持有 `AbortController`，`cancel` 时 abort 并写 `task_events: task.canceled`。
- 每步声明 `timeoutMs`，超时按 `errorPolicy` 处理。

**2.6 Word 导出（可选后置）**
现状是浏览器端 mammoth/jszip 生成。改造后可下沉为 `GET /api/tasks/:id/export.docx`：结果可审计、口径统一、移动端也能导出。保留前端导出作为降级。

### Sprint 3：工作台、配额与可观测（5-8 人日）

**前端**
```
src/App.jsx                             # 路由重构
src/pages/AppHomePage.jsx               # 产品矩阵 + 最近任务 + 额度
src/pages/TaskCenterPage.jsx            # 任务列表 / 详情 / 失败原因
src/pages/admin/InviteAdminPage.jsx
src/hooks/useTaskStream.js              # SSE 订阅 + Last-Event-ID 自动重连 + 状态恢复
src/api/tasks.js / auth.js
```
- **`useTaskStream` 是前端改造的关键件**：把 `ContractRewritePage.jsx` 里内联的 `readSSE` 抽出来，加上「断线记 `lastEventId` → 重连时 `?since=` → 续接」。页面刷新后从 `GET /api/tasks/:id` 恢复渲染。
- 两个工作台页面：**渲染层不动**，只把数据源从 localStorage 换成 API + `useTaskStream`。
- localStorage 迁移：首次登录时把遗留的 `fafee-*` 键一次性导入服务端（可选，做一次就删标记），或直接放弃并提示。

**服务端**
```
server/services/quota-service.js        # 按用户/产品校验任务数、token 额度
server/services/model-gateway.js        # 统一出口：超时/重试/并发/token计量/成本/降级
server/middleware/request-context.js    # requestId + 结构化日志（禁止记录合同正文）
server/routes/health.js                 # /api/health（存活） + /api/ready（依赖：db/queue/kb/model）
server/services/audit-service.js
```
- Agent 不再直接 `import llm-client`，改为 `ctx.services.llm`（网关注入），token 用量随 step 回写 `tasks.tokens_in/out`（NFR-020）。
- 限流：非 AI 接口按用户 IP 令牌桶；AI 任务创建按用户配额；队列达阈值返回排队位次而非接收（NFR-007 背压）。

**验收**：登录 → 提交任务 → 关闭浏览器 → 重新打开任务中心 → 结果完整可见；`GET /api/ready` 在依赖不可用时返回 503。

### Sprint 4：产品矩阵扩展（按产品逐个，每个 3-6 人日）

平台化之后新增产品的成本从「复制路由」降到「加一个 workflow + 一条 products 记录」：

| 产品 | 实现方式 |
| --- | --- |
| 劳动合同分析（FR-025） | 复用审查管线，换 `prompts/` + 限定知识库范围 |
| 员工手册诊断（FR-027） | 同上，换审查 checklist |
| 劳动仲裁答辩（FR-026） | 新 workflow：案情抽取 → 争议焦点 → 证据清单 → 文书生成（无原文定位步骤） |
| 医疗期 / 养老 / 灵活就业测算（FR-028~030） | **纯确定性 tool step**，不调模型或仅用于自然语言解析输入 |
| AI 用工风险助手（FR-031） | 意图识别 step → 路由到对应 workflow |

```js
// server/products.js
export const PRODUCTS = {
  'contract-review-v1':  { label: '商业合同改写', workflow: 'contract-review@1',
                           permissions: ['contract_review'], quotaKey: 'contract_review',
                           inputs: ['pdf','doc','docx','png','jpg'], resultKind: 'revision' },
  'labor-contract-v1':   { label: '劳动合同分析', workflow: 'labor-contract@1', ... },
  'medical-period-v1':   { label: '医疗期计算器', workflow: 'medical-period@1', ... }
}
```

---

## 四、必须守住的工程红线

从 `HANDOFF.md` 与实习生清单继承，改造全程不可破：

1. **模型输出永远不可信**。任何 Agent 产物进页面/进库前必须过服务端校验。工作流化之后，`annotation-locator` / `finding-consolidator` / `revision-merger` 三个服务**保持原样**，作为 step 的 validator 挂载，不允许「为了省事让模型直出」。
2. **`notice` 语义不可退化**。原文不需改动时用 `notice` 且 `replacementText` 为空，禁止把 `targetQuote` 原样填入替换文本。
3. **SSE 不得先聚合再返回**。Nginx `proxy_buffering off` + `X-Accel-Buffering: no` 必须保留，否则进度与流式文本失效。
4. **密钥永不入库入码**。`.env.local` 只在本机；新增 `SESSION_SECRET` 同样只放环境变量。
5. **日志不得记录合同正文**（NFR-013）。结构化日志只记 id、长度、hash、耗时。
6. **不跑破坏性命令**。当前目录是归档副本且不是 Git 仓库——**先在真实 clone 上开工**，不要在归档副本里做任何清理/重置。
7. **改代码前先跑回归**：`test:consolidation` / `test:word-annotations` / `test:concurrency` + `npm run build`。

---

## 五、风险与取舍

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| SSE 长连接与多实例冲突 | 进程内 EventEmitter 无法跨实例广播 | MVP 单实例；`event-store` 接口预留 `listSince`，换 Redis Pub/Sub 时只改 `subscribe` 实现 |
| SQLite 单写者 | 高并发任务写入可能 `SQLITE_BUSY` | 开 WAL + `busy_timeout`；事件写入合并为批量事务；Growth 期换 Postgres |
| 400 行管线搬运引入行为漂移 | 现有逻辑含大量兜底分支 | **golden fixture 逐字段等价性断言**为合并前置条件，不通过不合 |
| 登录态与 SSE 的 Cookie 传递 | 跨域部署时 Cookie 不下发 | 同源部署（Nginx 同域反代 `/api`）；若必须跨域，`credentials: 'include'` + CORS 白名单 + `SameSite=None; Secure` |
| 上传文件落盘后的合规 | 现状是纯内存不落盘，改后有明文残留 | `server/data/uploads/` 不入 Git、不可静态访问、按 `expires_at` 定时清理（NFR-010） |
| 改造面大导致长期不可发布 | 一次做完才上线风险极高 | 严格按 Sprint 切分，每个 Sprint 结束都可发布：Sprint 1 后是「要登录的试用站」，Sprint 2 后是「能续看的任务站」 |

---

## 六、立即开始的第一个 PR（建议）

**范围**：只做 Sprint 0 + Sprint 1 的骨架，能独立评审、独立回滚。

1. 在真实 clone 上开 `feat/agent-platform` 分支。
2. `eslint.config.js` + CI 门禁脚本。
3. `server/db/index.js` + `001_accounts.sql` + 迁移 runner。
4. `auth-service.js`（scrypt）+ `invite-service.js` + `middleware/auth.js` + `routes/auth.js`。
5. `server/index.js`：CORS 白名单化 + 挂载 auth 路由。
6. 前端：`AuthContext` + `RequireAuth` + 登录/注册页 + Header 登录态。
7. 回归脚本 `server/scripts/test-auth.js`（注册事务、邀请码边界、会话校验）。

**不收范围**：不动管线、不动 prompts、不动三个可信性服务、不动工作台渲染逻辑。

---

## 附：本次盘点的 CodeGraph 使用说明

本项目 CodeGraph 索引已就绪（`codegraph sync .` 返回 *Already up to date*）。注意：CodeGraph MCP 工具的**默认 project 指向的是另一个代码库**（DSH checkout），查询本项目时必须显式传参，否则会返回无关文件：

```
codegraph_explore(query="...", projectPath="/Users/ypc/Desktop/归档项目/infimind-react")
```

源文件改动后执行 `codegraph sync .` 保持索引最新；不要删除 `.codegraph/`。
