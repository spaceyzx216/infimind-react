# 法飞飞 AI 合同工作台交接说明

## 当前状态：合同审查与起草任务平台（2026-09-18，优先阅读）

- 第一阶段「合同审查、合同起草两个功能的稳定性闭环」已完成代码并联合验收通过：真实 DeepSeek + Redis/BullMQ + 独立 Worker（并发 1），合同审查在 Worker 中断后恢复成功、合同起草成功完成、事件回放通过。待合并的 PR 是把这两个功能合入上游 main。
- **合同审查已任务化**：审查页上传合同后走 `POST /api/tasks/contract-review`，接口只负责鉴权、接收文件并返回 `taskId`，Worker 负责解析、结构分析、证据检索、多轮审查、归并和修订。任务状态为 `queued` / `running` / `retry_waiting` / `succeeded` / `failed` / `cancel_requested` / `cancelled`。
- **合同起草也已任务化**：`POST /api/tasks/contract-draft` 复用同一任务底座；但起草页当前仍使用兼容 SSE 的 `POST /api/contract-draft` 保持即时体验，尚未切换到任务订阅。
- **同对话串行约束由数据库保证**：`tasks` 表对 `user_id + thread_id` 上的活动任务建立部分唯一索引，前端判断只是软约束，重复提交无法绕过。命中时合同审查返回 `409 review_task_conflict`，起草返回对应冲突码。
- **生成中停止与插队发送**：审查页发送与停止共用同一按钮（空闲发送 / 生成中空输入停止 / 生成中已有输入则停止上一轮并立即发送）。被中断的半截内容标记为 `interrupted`，可作为下一轮上下文但不作为正式审查结果；旧请求迟到的事件不会覆盖新回复。
- **后台任务入口已收敛**：左侧只保留「历史对话」，不再渲染独立的「后台任务」栏。刷新或重新打开对话时按关联的 `taskId` 恢复排队、运行、取消、失败与成功状态；`GET /api/tasks` 保留为服务端通用查询能力，不新增独立任务中心。
- 业务请求使用 15 分钟 HS256 JWT；随机刷新令牌仅保存在 `HttpOnly`、`SameSite=Lax` Cookie，登录绝对期限为 7 天。JWT 仅保存在页面内存，刷新页面时通过刷新令牌恢复登录。**刷新令牌是随机串，与 `JWT_SECRET` 无关**；轮换 `JWT_SECRET` 只影响已签发的 access token，刷新一次即可恢复。
- 已验证（2026-09-18，7 套回归全绿）：`npm run test:tasks`、`test:contract-draft`、`test:interrupt`、`test:concurrency`、`test:consolidation`、`test:auth`、`test:auth:client`，以及 `npm run build`。
- 仓库状态正常：本地 `feat/contract-draft-task-platform` 已提交并推送到 fork `LiCharon/infimind-react`，`git fsck` 干净。**注意本机 `.git/refs` 下新建的 ref 目录会被反复清空**（`heads/feat/`、`remotes/origin/`），症状是 commit 成功但紧接着 `git log`/`push` 报 `does not have any commits yet`；应对办法见第 10 节。

## 2026-09-15 认证与工具台状态（历史记录；当前状态以文首 2026-09-18 一节为准）

- 官网已实现“邀请码注册 → 登录 → 进入工具台 → 使用工具 → 退出后重新登录”。注册、登录、刷新、当前用户和退出接口均在服务端实现；业务 API 除健康检查和认证接口外均要求有效 JWT。
- 业务请求使用 15 分钟 HS256 JWT；随机刷新令牌仅保存在 `HttpOnly`、`SameSite=Lax` Cookie，登录绝对期限为 7 天。JWT 仅保存在页面内存，刷新页面时通过刷新令牌恢复登录；退出会撤销刷新令牌并清空页面凭证，关闭网页不会主动退出。
- SQLite 业务库保存用户、邀请码和刷新令牌的哈希；密码使用 `crypto.scrypt` 加盐哈希。邀请码一人一码，注册在事务内核销。真实密钥仅放入 `.env.local` 或服务器环境变量，不提交 Git。
- 工具台保留 9 个入口：合同审查与合同起草继续走现有真实后端和 SSE；其余 7 个工具复用会话原型。浏览器本地历史按“用户 ID + 工具 ID”隔离，JWT 不使用 localStorage 保存。
- 已验证：`npm run test:auth`、`npm run test:auth:client`、`npm run test:concurrency`、`npm run test:consolidation`、`npm run build`、相关 `node --check` 和 `git diff --check`。服务器数据库、正式模型 API Key、部署和线上验收仍为后续工作。

## 2026-09-14 前端原型说明（历史记录；当前状态以文首 2026-09-18 一节为准）

- 本地运行目录是包含 `package.json` 的 `法飞飞/infimind-react`，执行 `npm run dev`。当前开发预览为 `http://127.0.0.1:5173`；进程停止后需重新启动，以终端实际地址为准。
- 已调整产品演示视频：移除外围白卡、预览标题、矩阵分类标题及右下角入口，桌面视频高度为 700px、宽度按素材比例；保留底部立即体验。登录左侧改用预裁好的贴图 `public/auth-visual.jpg`（800×938，由登录页参考草图左半边裁出，原图存 `docs/reference/auth-reference.png`），CSS 用 `background-size: auto 100%` 按高度等比铺满，右侧表单为真实表单；自动登录复选框仅演示，不改变登录存储策略。工具台使用统一浅橙色和桌面多列紧凑布局，全部入口保留。
- 工具台布局曾做过一版「紧凑一屏」改造（固定 4 列 / 卡片压扁 / flex 摊开剩余高度），已按用户要求**回退**，现为上面这一版原始样式；改造版留存于工作区 `.tooling/backup/ToolHubPage.compact.{css,jsx}`，需要时可再取回。
- 会话导航统一复用 `ToolOverviewLink`，文字入口返回 `/tools`；已移除侧栏重复的当前工具说明。官网入口在工具总览。
- **架构边界**：合同审查和起草仍是两个现有页面，保留各自业务逻辑与历史存储；其余七个工具复用 `ToolConversationPage`，通过工具配置、路由参数和独立 localStorage key 区分。当前不是全站已完成共用工作台抽取。后续沿“公共工作台结构 + 工具配置 + 专属业务区域”增量设计，不复制整页扩展。
- **当时的原型边界（2026-09-14）**：登录仅本地模拟，邀请码未校验；历史目前按工具隔离，没有真实账号权限隔离。不能以此替代后端鉴权。七个新增工具返回明确标注的演示消息，不代表业务能力已接通。数据库、真实注册和完整公共外壳抽取不在当时修改范围。
- 本次验证：`npm run build`；Edge + Playwright 检查登录前置、回到工具台顶部、两个新增工具间历史隔离及刷新保留、两个合同页导航、390px 登录/工具台横向溢出和浏览器运行错误。未测试真实合同上传/模型调用，未发布线上。
- 追加验证（2026-09-14 晚，登录页贴图 + 工具台回退）：登录页与工具台在 1920×1080 / 1800×1000 / 1683×973 / 1672×941 / 1600×900 / 1440×900 / 1366×768 / 1280×960 / 1280×800 / 2560×1440 / 390×844 共 11 档下，**开发态与生产构建预览各跑一轮**，断言横向溢出为 0、登录贴图 200、无 console error / pageerror / HTTP≥400。用户实际视口为 1683×973（由截图侧栏宽度反推，缩放 1.52）。
- 收尾状态：代码及本地运行态 `changed-and-verified`；本节说明 `changed-and-verified`；规则未修改；记忆 `out-of-scope`；现有工作区改动保留、未提交。旧文档与全项目治理审计 `pending`，下方内容保留为 2026-08-13 历史快照，不作为本次运行事实。

> 更新时间：2026-08-13（Asia/Shanghai）· **以下为历史快照，非当前状态**
> 工作区：`/Users/ypc/Desktop/infimind-react`（当时路径；当前开发机路径为 `E:\桌面\资料\法智科讯\法飞飞\infimind-react`）
> Git 基线：`main` / `214ee60 feat: import annotated labor contract templates`（当时基线）
> 状态：当时的工作区未提交改动，后来均已提交并合入 main。**当前工作区干净。**
> 本节保留仅用于追溯，不要照此执行；当前状态见文首「2026-09-18」一节。

---

## 0. 2026-08-13 任务交接（历史快照，内容已完成并合入 main，仅作追溯）

> **本节已过时，不要照此执行。** 该轮「`notice` 批注」工作已完成并合入上游 main（相关提交见 `git log`）。
> 其中「仓库当前目录不是 Git 仓库」「工作区包含未提交改动」等描述在当时或许成立，**对当前仓库完全不成立**：本仓库是正常 Git 仓库，工作区干净，`git fsck` 无错误。
> 当前状态请看文首「2026-09-18」一节。

### 正在做什么

修复合同审查修订稿中的一类展示误导：有些 finding 只要求用户确认或填写业务事实，原合同文字本身不需要改动。例如“本协议有效期：自____年__月__日至____年__月__日。”已经预留日期空位，批注只需提醒“请明确协议起止日期”。此前模型常把原片段原样放入 `replacementText`，页面于是显示“改为：本协议有效期……”，用户容易以为系统错误地把原条款照抄了一遍。

### 已完成

1. 已用 CodeGraph 初始化并索引当前项目（`.codegraph/` 为本地索引元数据），并结合本文件定位审查链路：
   `Agent 3 提示词 → revision-merger 校验/归并 → ContractRewritePage 行内卡片及 Word 导出`。
2. 在 `server/prompts/agent-3-rewrite.js` 增加局部操作 `notice`：
   - 用于“仅提示确认/补全，原文无需改写”；
   - 要求 `replacementText` 为空；
   - 明确禁止把 `targetQuote` 原样复制成替换文本。
3. 在 `server/services/revision-merger.js` 支持 `notice`，并兼容模型仍输出旧格式的情况：当 `operation: "replace"` 且 `replacementText` 与模型给出的 `targetQuote` 规范化后相同时，自动降级为 `notice`，且清空 `replacementText`。
4. 在 `src/pages/ContractRewritePage.jsx` 的页面卡片与 `exportWord` 中支持 `notice`：显示“提示 + 批注说明”，不显示“改为”，也不展开重复的完整修订条款。
5. 在 `server/scripts/test-finding-consolidation.js` 加入“原文不改、仅提醒”的回归断言。

### 当前状态／卡点

代码、回归和构建均已完成，**当前没有技术卡点**。尚未用真实合同端到端调用模型并在浏览器中人工确认视觉效果；这属于下一步验收，而不是代码阻塞。

本轮已通过：

```bash
npm run test:consolidation
npm run test:word-annotations
npm run test:concurrency
npm run build
node --check server/prompts/agent-3-rewrite.js
node --check server/services/revision-merger.js
```

`test:word-annotations` 会输出 mammoth 对 `v:line`、`w:cr` 的既有非致命警告，最终测试通过。`node --check` 不支持 `.jsx` 扩展名；前端语法由 `npm run build` 验证。

### 下一步建议

1. 启动前端和后端，上传一份含“有效期日期空位”条款的真实或脱敏 DOCX/PDF，检查页面第 N 条批注是否显示为“提示：请明确协议起止日期”，且不含“改为：原条款”。
2. 从该结果导出 Word，确认 Word 中同样是“提示”而非“改为”。
3. 观察真实模型是否稳定输出 `notice`；即使未稳定，`revision-merger` 的“原样替换→notice”兼容逻辑仍会覆盖完全照抄的常见情形。
4. 若继续迭代，考虑把 `notice` 在视觉上与真实文本修改进一步区分（例如不使用修改色高亮）；本轮按最小改动保留原有定位高亮，方便用户看到提醒对应的条款。

### 绝对不要再踩的坑

- 不要把“需要填写/确认”一律实现成 `replace`：原文不变时必须使用 `notice`，`replacementText` 为空。
- 不要只在前端用字符串相等判断掩盖问题；模型输出必须先在服务端 `revision-merger` 规范化，才能同时覆盖页面、历史数据和 Word 导出。
- `nearestQuoteMatch` 的返回 `targetQuote` 可能因定位器上下文与模型入参不同；识别“原样照抄”时应比较模型传入的 `rawEdit.targetQuote` 与 `replacementText`，不能只和定位后的文本比较。
- `annotation-locator` 对可精确定位的 quote 有至少 6 个规范化字符的安全阈值。测试片段太短会触发既有 fallback，不代表 `notice` 逻辑失效。
- ~~仓库当前目录不是 Git 仓库；不要假定 `git status`、提交或回滚可用。更不要使用破坏性清理命令覆盖现有用户改动。~~ **（已失效）** 本仓库是正常 Git 仓库，`git status` / `git commit` / `git push` 均可正常使用。但本机有一个已知问题：`.git/refs` 下**新建**的 ref 目录会被反复清空，处理办法见第 10 节。
- 不要删除 `.codegraph/`，除非明确不再需要本地代码图谱；有源文件修改后执行 `codegraph sync .` 保持索引最新。

---

## 1. 当前产品完成态

项目有官网和一套共用外壳的双工作台：

| 工作台 | 路由 | 用户目标 | 正式交付物 |
| --- | --- | --- | --- |
| 合同审查与批注 | `/contract-rewrite` | 上传合同、审查风险、获取可追溯修改建议 | 原文定位的修订稿，可导出 Word |
| 合同智能起草 | `/contract-draft` | 描述交易或上传参考材料、持续补充事实 | Markdown 合同初稿、待确认信息，可复制或下载 Word |

两个页面均支持历史会话、独立任务、流式进度、余额浮层、附件上传与右侧文档展开。
**任务事实源已迁移到服务端 SQLite**：审查任务、事件、检查点与结果均由 `tasks` / `task_events` / `task_checkpoints` / `task_files` 持久化，浏览器 `localStorage` 只作为缓存；按 `taskId` 可查询、补拉事件并在 Worker 重启后恢复。
（历史说明：服务端 ReviewSession 仍是内存态，默认 2 小时过期，仅服务于 SSE 追问链路；异步任务不再依赖它。）

## 2. 用户关键流程

### 2.1 合同审查

```text
上传合同与审查重点
  → 文件解析/OCR
  → Agent 1：结构分析
  → 知识库检索与审查计划
  → Agent 2：最多三轮增量审查与代码去重
  → 原文定位、可信 finding 校验
  → Agent 4：已定位问题归并
  → Agent 3：逐条结构化修订
  → 前端行内标记、就近修订卡与 Word 导出
```

审查页没有附件时走普通追问 `/api/contract-chat`；**有附件时走异步任务接口 `POST /api/tasks/contract-review`**（返回 `taskId`，由 Worker 执行完整审查管线，通过 `GET /api/tasks/:taskId/events?after=<seq>` 回放与订阅事件）。
`POST /api/contract-rewrite` 仍保留为 SSE 直连接口。快速/深度思考模式只在审查页提供。

### 2.2 合同起草与可重复生成

```text
首次需求/新增参考材料 → 合同类型识别 → 生成完整初稿
已有初稿后的普通提问   → 根据当前草稿回答，不重复输出全文
明确要求重写/更新/重新生成 → 将当前草稿作为上下文，再生成一份新初稿
```

`/api/contract-draft` 在已有草稿时先做意图路由：`draft` 表示生成完整文档，`chat` 表示普通对话。前端把最新草稿随历史上下文传入，以便新版本真正基于旧版本修改。起草页用 Enter 发送，Shift+Enter 换行；中文输入法组合态不会误发。

## 3. 主要代码位置

| 范围 | 文件 | 职责 |
| --- | --- | --- |
| 路由与工作台入口 | `src/App.jsx`、`src/components/Header.jsx` | 官网与两个工作台入口 |
| 审查界面 | `src/pages/ContractRewritePage.jsx`、`.css` | 多会话、SSE 消费、修订稿、导出、Enter 发送 |
| 起草界面 | `src/pages/ContractDraftPage.jsx`、`.css` | 起草/追问/重生成、待确认面板、Word 下载 |
| API 编排 | `server/routes/contract-rewrite.js` | 上传校验、审查与起草 SSE、余额、追问 |
| 文件解析 | `server/services/file-parser.js` | PDF、Word、Office、文本、OCR、Word 批注/修订读取 |
| LLM 客户端 | `server/services/llm-client.js` | DeepSeek 兼容 Chat Completions、重试、流式响应 |
| 审查 Agent | `server/agents/contract-*.js`、`server/prompts/agent-*.js` | 分析、审查、归并、修订 |
| 起草提示词 | `server/prompts/contract-draft*.js` | 类型识别、专项条款与输出格式约束 |
| 审查可信性 | `server/services/annotation-locator.js`、`revision-merger.js` | finding 定位/去重、锚点、修订合并 |
| 任务 API | `server/routes/tasks.js` | 任务创建、列表、详情、事件订阅、取消；串行冲突返回 409 |
| 任务服务 | `server/services/task-service.js`、`task-queue.js`、`task-processor.js`、`task-runtime.js` | 状态机、队列（BullMQ / SQLite 降级）、阶段推进、检查点 |
| 工作流注册表 | `server/workflows/contract-review.js`、`contract-draft.js` | 按 `productId` 分派的各产品工作流 |
| Worker 入口 | `server/worker.js` | 独立进程消费任务；`TASK_RUN_WORKER=false` 时与 API 分离 |
| 前端请求状态 | `src/utils/thread-request-state.js` | 按 `threadId` 的运行态与取消标记 |

## 4. 接口与流式事件

| 接口 | 用途 | 主要事件/响应 |
| --- | --- | --- |
| `POST /api/tasks/contract-review` | **审查页主路径**：创建合同审查异步任务 | `202` + `taskId` |
| `POST /api/tasks/contract-draft` | 创建合同起草异步任务；咨询类请求不入队 | `202` + `taskId` |
| `GET /api/tasks` | 当前用户最近任务；服务端通用查询能力 | JSON |
| `GET /api/tasks/:taskId` | 任务状态、阶段摘要、结果或失败原因 | JSON |
| `GET /api/tasks/:taskId/events?after=<seq>` | 回放并持续订阅任务事件；断线后用递增序号补拉 | SSE |
| `POST /api/tasks/:taskId/cancel` | 取消当前用户的排队或运行中任务 | JSON |
| `POST /api/contract-rewrite` | 上传并审查合同（SSE 直连，保留） | `stage.start`、`stage.progress`、`analysis.delta`、`review.delta`、`review.round`、`rewrite.result`、`error` |
| `POST /api/contract-chat` | 审查页普通追问 | `chat.start`、`chat.delta`、`done` |
| `POST /api/contract-draft` | 起草页意图路由、对话或生成初稿（SSE，起草页现用） | `chat.*` 或 `draft.progress`、`draft.type`、`draft.start`、`draft.delta`、`draft.complete`、`error` |
| `POST /api/contract-finalize` | 历史确认后改写接口 | 保留兼容；当前主界面不调用 |
| `GET /api/account/balance` | 读取模型账户余额 | JSON |

除健康检查和 `/api/auth/*` 外，所有 `/api` 接口都要求 `Authorization: Bearer <JWT>`，未登录返回 `401`；跨用户访问任务返回 `404`。
同对话重复提交会命中串行约束，返回 `409`（审查为 `review_task_conflict`）。

SSE 连接需要 Nginx 关闭代理缓冲并保留较长读取超时；不要把事件先汇总后再返回，否则前端进度与流式文本会失效。

## 5. 附件解析能力与部署依赖

前后端白名单一致支持：

- PDF、DOC、DOCX、RTF、ODT；
- XLS/XLSX/ODS、PPT/PPTX/ODP；
- TXT、Markdown、CSV/TSV、JSON、XML、HTML；
- PNG、JPG/JPEG、WebP、BMP、TIFF/TIF、GIF。

处理原则：DOC 优先使用 macOS `textutil`，失败或 Linux 环境回退到 LibreOffice/soffice；RTF 在转换器返回空文本时回退本地控制字解析；Office 文件经 LibreOffice 转为文本；图片先用 `jimp` 放大、灰度化、增强对比度，再使用 `chi_sim + eng` OCR，低置信度会补跑稀疏文本模式。

生产环境要求：

1. Node.js **24**（见 `.nvmrc`；`server` / `worker` 脚本使用 `--use-env-proxy`，需 Node ≥ 22.21）；执行 `npm ci` 安装依赖。
2. 安装 `libreoffice`/`soffice` 与中文字体（Ubuntu 常用 `libreoffice fonts-noto-cjk`）。没有它时 DOC、Office 格式无法可靠转换。
3. Tesseract.js 首次 OCR 需取得中英语言模型；生产环境要保证可下载，或预热/缓存语言模型。
4. Multer 使用内存存储，单文件上限 80MB、一次最多 6 个。OCR 与 Office 转换会占用 CPU/内存，线上建议至少 4GB 内存，并在 Nginx 同步配置请求体限制与超时。

## 6. 本地运行与验证

```bash
npm ci
npm run dev                 # Vite 前端
npm run server              # Express 后端，默认 8789 或 LOCAL_SERVER_PORT
npm run worker              # 独立任务 Worker（生产建议与 API 分离）
npm run build               # 前端生产构建
npm run test:tasks          # 任务平台：创建、事件回放、检查点、Fake LLM、越权、取消、重试
npm run test:contract-draft # 合同起草任务适配：意图分流、草稿快照、恢复、重试、取消、兼容 SSE
npm run test:interrupt      # 同对话串行、插队取消边界、迟到事件保护、taskId 恢复、越权
npm run test:concurrency    # 会话请求隔离回归
npm run test:consolidation  # finding 归并回归
npm run test:auth           # 邀请码、并发注册、密码/刷新令牌保密、JWT、恢复、退出
npm run test:auth:client    # 浏览器侧鉴权客户端回归
```

**运行环境注意**：`better-sqlite3` 是按 Node 24 编译的原生模块（`NODE_MODULE_VERSION` 137）。若 PATH 首个命中 Node 22，`npm run test:*` 会报 `ERR_DLOPEN_FAILED`，需把 Node 24 目录前置到 PATH。

`npm run lint` 当前不可用：仓库使用 ESLint 9，但没有 `eslint.config.*`。这是已有配置缺口；提交前至少运行 `node --check server/routes/contract-rewrite.js`、`node --check server/services/file-parser.js`、`npm run build` 与上述回归脚本。

`npm run test:word-annotations` 需要本机安装 LibreOffice，缺少时会以 `spawn libreoffice ENOENT` 失败，属环境缺失而非代码回归。

## 7. 上线检查

1. 前端 `dist/` 部署到站点目录；SPA 使用 `try_files $uri $uri/ /index.html`。
2. `/api/` 反代到 Node 实际端口；配置 `proxy_buffering off`、`proxy_read_timeout 600s`，并统一 Nginx、`.env.local` 与 Node 端口。
3. 设置 DeepSeek API 环境变量，绝不提交或打包 `.env.local`。
4. 验证 `/api/health`、`/api/knowledge-base/status`、`/api/account/balance`，再做一次真实 DOC、XLSX、扫描图片和 PDF 的端到端上传。
5. 检查首次 OCR 的语言模型下载/缓存、LibreOffice 路径与中文字体。

## 8. 当前风险与下一步

- 新增文件格式与 OCR 预处理已通过语法、构建、Word 批注、并发和归并回归；仍应使用真实客户的 DOC、表格、演示文稿和低清扫描件做线上验收。
- `jimp` 新增依赖后，`npm audit` 报告依赖树风险；上线前应由维护者评估并安排依赖升级，不要盲目执行破坏性 `npm audit fix --force`。
- 起草意图路由会额外调用一次轻量分类；需观察线上延迟、分类误判与模型用量。
- **审查与起草的联合验收已在真实链路通过**（真实 DeepSeek + Redis/BullMQ + 独立 Worker 并发 1）。仍建议在浏览器中人工过一遍停止、插队与刷新恢复的交互效果。
- 生产拆分 API 与 Worker 时，在 API 进程设 `TASK_RUN_WORKER=false`，再单独运行 `npm run worker`；两者必须共享同一 SQLite 数据库与 Redis 配置。

## 9. 安全边界

- 模型密钥只留在后端环境变量；浏览器不得得到密钥。
- Node 服务仅监听本机或内网，由 Nginx 反代；不要直接暴露服务端口。
- 合同及上传材料具有敏感性；临时转换目录会在解析后清理，但部署日志不得记录正文。
- 输出是辅助起草/审查，不构成法律意见；高风险交易、签署、授权、税务与监管事项仍需人工专业复核。
