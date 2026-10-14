# AGENTS.md — 法飞飞 AI（infimind-react）

> 本文件只记录本项目事实与边界；通用协作纪律见全局（Codex 自动注入）。
> 优先级：团队既有规范（`README.md`「贡献与维护」、PRD、技术文档、导师口头约定）> 本文件；冲突时以更具体且仍有效的一方为准。
> `README.md` 是架构 / API / 环境变量 / 部署 / 已知边界的权威说明；本文件只引用不复制。

## 0. 项目定位
法飞飞 AI · 商业合同与劳动用工工具 —— 面向企业经营者、HR、法务、律师与商务人员，涵盖商业合同审查/批注与起草、用工咨询、劳动合同/劳务派遣分析、劳动仲裁答辩。员工手册及医疗期/养老测算等通用工具页仍需独立业务实现，页面入口不等于功能已完成。线上站点 <https://www.flylegal.cn/>；本地代码不代表线上已部署。

产品与设计文档（只读引用，以磁盘最新版本为准）：
- `docs/prd.md`
- `docs/法飞飞AI-产品PRD.docx`
- `docs/法飞飞AI-技术文档.docx`
- `docs/合同审核与批注工作台-可复用界面设计方案.md`
- `docs/AI合同工作台-一键生成界面设计方案.md`

## 1. 技术栈与结构
| 层 | 技术 | 位置 |
|---|---|---|
| 前端 | React 18 + Vite 5 + React Router 7 + framer-motion | `src/`（`components/` 官网与共享工作台、`pages/` 页面、`utils/` API/状态与纯函数） |
| 后端 | Node 24 + Express 4 + SSE（默认端口 8789） | `server/index.js`、`server/routes/`、`server/services/` |
| 业务工作流与模型 | 各工具独立工作流；合同复用结构分析 / 审查 / 归并 / 修订 Agent，模型调用共用封装 | `server/workflows/`、`server/agents/`、`server/prompts/`、`server/services/llm-client.js` |
| 持久任务与队列 | SQLite 任务/事件/检查点；本地持久队列或 Redis + BullMQ；支持独立 Worker | `server/routes/tasks.js`、`server/services/task-processor.js`、`server/worker.js` |
| 存储与检索 | 业务 SQLite 与知识库分开；知识库 FTS5/BM25，可选 Qdrant 向量 + 重排 | `server/services/business-db.js`、`server/data/`、`server/knowledge-base/` |
| 文件解析 | Mammoth / pdf-parse / Tesseract.js（OCR）/ jszip | — |

## 2. 命令
- 前端：`npm run dev`（5173）、构建 `npm run build`、预览 `npm run preview`
- 后端：`npm run server`（默认8789）；Vite 的 `/api` 代理目标由 `LOCAL_SERVER_PORT` 配置，需与 API 监听端口一致；`npm run worker` 启动独立 Worker，须与 API 共用业务库、上传目录及队列配置，详见 README
- 知识库：`npm run import:templates -- <dir>`（会重建知识库，先备份）、`npm run evaluate:knowledge-base`
- 回归：`npm run test:consolidation`、`npm run test:concurrency`；任务/中断用 `npm run test:tasks`、`npm run test:interrupt`，认证/客户端用 `npm run test:auth`、`npm run test:auth:client`
- 专项：劳动合同 `npm run test:labor-contract-analysis`；仲裁 `node server/scripts/test-arbitration-staged.js`、`node server/scripts/test-labor-arbitration.js`、`node server/scripts/test-arbitration-hardening.js`；起草 `npm run test:contract-draft`，Word 批注 `npm run test:word-annotations`
- 静态检查：`npm run lint` **可用**，仓库已有 ESLint 9 flat config（`eslint.config.js`）；每次报告退出码、errors 和 warnings，不能把退出0写成无警告，不为消除警告批量改代码
- 提交前（README 建议顺序）：`npm run test:consolidation` → `npm run test:tasks` → `npm run test:interrupt` → `npm run build` → `node --check server/routes/contract-rewrite.js` → `node --check server/services/revision-merger.js` → `git diff --check`；按改动范围补充专项回归与 lint
- 隔离检查前先读脚本，核对数据库、知识库、队列、上传目录及模型调用目标；`test:labor-consult` 不直接当成无副作用回归运行。构建默认写 `dist/`，需要保留现役产物时改用新系统临时输出；Vite 插件还会生成/补写根目录 `index.html`，需要完全隔离时使用包含前端引用文件的临时副本，详见 README/HANDOFF

## 3. 任务范围（不预设模块职责）
- **不按模块划分职责**：团队未按人指定长期模块，我的范围随每轮任务而定，与导师对接后确认。
- **默认只动当轮指令点名的文件 / 模块**；需要碰其它文件（尤其接口、公共组件、服务端链路）时，先说明再动。
- **防越界不靠职责表，靠禁用清单**：边界以 §5「未经确认不要改」「不提交」为准——那些是客观的，不随阶段变。
- **需求来源**：与导师对接 + PRD / 技术文档（见 §0）。文档没写清的地方问导师，不自行推断。
- **有疑惑直接问导师**；提问按全局 §3「带方案问，不带问题问」。
- **验收人**：导师 —— 我提交后由导师检查。
- **本版不做**：不自行裁定；每轮与导师对接时确认，写进当轮任务说明。

## 4. 交付流程（团队既定）
1. 与导师对接，明确本轮范围与验收标准
2. 从 `main` 创建功能分支（既有命名风格：`feat/xxx`、`fix/xxx`）
3. 实现并自测（跑 §2 的提交前命令）
4. 提交与推送：一改一提交，提交信息用 `feat:` / `fix:` 前缀
5. 由导师检查；需要 PR 时说明包含变更原因、用户影响、验证方式、剩余风险

> 本项目内 push 属既定流程，视为已授权；但 push 前仍须自查 diff 与验证结果。

## 5. 项目内约束
- 不提交：`.env.local`、真实密钥、临时部署包（`*.zip`）、未经授权的合同素材
- 未经确认不要改：`package-lock.json`、`dist/`
- `server/knowledge-base/` 下的 `index.json`、`templates.db` 视为导入产物：改内容走 `import:templates`，不手工编辑
- `server/knowledge-base/templates/`、`public/` 内为业务素材：删除或批量改名先给清单（路径、原因、影响）再执行
- 模型输出字段变更 → 必须同步服务端校验、前端渲染与回归测试（README「贡献与维护」第 3 条）
- 原文定位坚持"不猜位置"；调整相似度阈值须用真实正反例验证
- 涉及接口、数据结构、知识库格式的改动，先出方案待确认
- `better-sqlite3` 是原生模块：切换 Node 大版本后必须重装依赖（仓库要求 Node 24，见 `.nvmrc`）

## 6. 文档
- 权威说明：`README.md`（架构 / API / 环境变量 / 部署 / 已知边界 / 贡献规范）
- 交接说明：`HANDOFF.md`（交付批次、验证证据、运行条件与待验收）；分支、提交、测试结果和部署状态以现场核对为准，不作为本文件的固定规则
- 产品与设计文档：见 §0 列表
- `design-qa.md`：界面自查记录
- 不新建未约定的文档体系（devdocs / journal）；需要留档先问
