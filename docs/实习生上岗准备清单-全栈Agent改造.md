# 实习生上岗准备清单 · 全栈开发（Agent 应用网站改造）

> 项目：法飞飞 AI（infimind-react）→ 全面改造为 Agent 应用网站
> 准备时间：即日起至下周一（约 4 天，可自行压缩/顺延）
> 上岗标准：**能独立跑通项目、读懂核心链路、说清每个模块在做什么**。不要求现在就会改，但周一布置任务后必须能快速进入代码。

---

## 1. 先搞清楚你要加入的项目（第 1 件事）

这个项目现在是一个已上线的法律 AI 产品（www.flylegal.cn），由两部分组成：

1. **品牌官网**：产品介绍、案例、咨询入口（纯展示页）。
2. **两个 AI 工作台**：
   - `/contract-rewrite` 合同审查与批注：上传合同 → 多 Agent 审查 → 可追溯的修订批注稿 → 导出 Word；
   - `/contract-draft` 合同智能起草：描述需求 → 生成合同初稿 → 持续追问/重写。

它的核心技术价值在于一套**自研多 Agent 审查管线**（没有用 LangChain 等框架，全部用 Node.js 手写编排）：

```
上传合同 → 文件解析/OCR
  → Agent 1 结构分析 → 知识库检索(RAG)
  → Agent 2 最多三轮增量审查 → 代码级定位与去重
  → Agent 4 问题归并 → Agent 3 生成修订
  → 服务端校验(不信任模型输出，失败就回退) → 页面批注 + Word 导出
```

接下来我们要把它**全面改造成通用的 Agent 应用网站**（多场景、多 Agent、用户体系、任务持久化）。所以你要准备的知识 = 现有技术栈 + Agent 工程的通用能力。

### 必读文档（按顺序，全在仓库里）

| 顺序 | 文档 | 目的 |
| --- | --- | --- |
| 1 | `README.md` | 全局认知：架构、工作流、技术栈、部署 |
| 2 | `HANDOFF.md` | 最新交接状态、已知坑、"绝对不要再踩的坑"一节 |
| 3 | `docs/prd.md` | 产品需求 |
| 4 | `docs/` 下其余设计/技术方案文档 | 界面与技术设计思路 |

---

## 2. 环境准备（Day 1 之内完成，跑不起来后面都免谈）

### 2.1 安装工具

- [ ] **nvm + Node.js 24**（项目有 `.nvmrc`；`better-sqlite3` 是原生模块，切 Node 大版本后必须重新 `npm ci`）
- [ ] Git、VS Code（建议装 ESLint 插件）、Chrome
- [ ] Docker Desktop（可选，只用来看 Qdrant 向量库；不用向量检索可以先不装）
- [ ] 一个可用的 LLM API Key（公司提供，配在本地 `.env.local`，**永远不要提交、不要写进代码**）

### 2.2 跑起来

```bash
git clone git@github.com:spaceyzx216/infimind-react.git
cd infimind-react
nvm use && npm ci
cp .env.example .env.local    # 填入 DEEPSEEK_API_KEY 等最小配置
```

两个终端分别执行：

```bash
npm run server   # Express API，http://localhost:8789
npm run dev      # Vite 前端，http://localhost:5173
```

- [ ] 打开 `http://localhost:5173/`（官网）、`/contract-rewrite`（审查）、`/contract-draft`（起草）
- [ ] 健康检查：`curl http://localhost:8789/api/health`
- [ ] **完整体验一遍核心流程**：上传一份真实/脱敏合同 → 选深度模式 → 看完三轮审查进度 → 查看批注稿 → 导出 Word。这一步比看任何文档都重要。

### 2.3 跑一遍回归脚本（了解项目怎么保证质量）

```bash
npm run test:consolidation   # 问题归并回归
npm run test:word-annotations # Word 批注回归
npm run test:concurrency     # 并发会话隔离
npm run build                # 生产构建
```

### 2.4 已知环境坑（提前知道，别到时候自己卡一天）

- 端口：Vite 把 `/api` 代理到 `LOCAL_SERVER_PORT`（默认 8789），两边必须一致。
- DOC/Office 转换依赖系统工具：macOS 自带 `textutil`；Linux 要装 LibreOffice + 中文字体。
- OCR（Tesseract.js）首次运行要下载中英文语言模型，需要网络。
- SSE 流式接口经过 Nginx 时必须关代理缓冲（了解即可，本地开发无感）。
- 注意：你拿到的这份本地目录可能**不是 Git 仓库**（归档副本），一切以你自己 clone 的仓库为准；不要在归档副本里跑任何清理/重置类命令。

---

## 3. 技术栈总览

### 3.1 项目现有技术栈（必须熟悉）

| 层 | 技术 | 在本项目中的位置 |
| --- | --- | --- |
| 前端框架 | React 18（函数组件 + Hooks）、React Router 7 | `src/App.jsx`、`src/pages/` |
| 构建 | Vite 5、PostCSS（原生 CSS 响应式，**没用 Tailwind**） | `vite.config.js`、各页面 `.css` |
| UI 渲染 | react-markdown + remark-gfm、Lucide 图标、Framer Motion | 模型输出渲染、官网动效 |
| 前端状态 | 手写会话状态管理 + localStorage 持久化 | `src/utils/thread-request-state.js` |
| 后端 | Node.js 24 + Express 4、Multer 文件上传、CORS | `server/index.js`、`server/routes/contract-rewrite.js` |
| 流式 | **SSE（Server-Sent Events）** 双向配合 | 服务端 `res.write` 事件流；前端 fetch 流式解析 |
| 数据库 | SQLite（better-sqlite3）+ FTS5 全文检索/BM25 | `server/knowledge-base/`、`server/services/knowledge-base.js` |
| LLM 接入 | OpenAI-compatible Chat Completions（当前 DeepSeek 快速/深度双模型） | `server/services/llm-client.js` |
| 多 Agent | 4 个 Agent + 协议化提示词，纯 Node 编排 | `server/agents/`、`server/prompts/` |
| RAG（可选） | Qdrant 向量库 + bge-m3 Embedding + bge-reranker 重排 + RRF 混合召回 | `server/services/vector-store.js`、`evidence-reranker.js` |
| 文件解析 | pdf-parse、mammoth、jimp、Tesseract.js OCR、LibreOffice | `server/services/file-parser.js` |
| 部署 | pm2（`ecosystem.config.cjs`）、Nginx 反代、docker-compose（Qdrant） | 仓库根目录 |

### 3.2 改造为通用 Agent 应用网站会新增的东西（提前了解方向）

- **用户体系与鉴权**：注册/登录、JWT 或 Session、接口鉴权（现在是匿名 + 浏览器 localStorage）。
- **服务端会话与任务持久化**：现在审查会话是内存态、2 小时过期，历史全在前端 → 要落库（表设计、迁移）。
- **异步任务队列**：长耗时的 Agent 任务后台执行、进度推送、断线重连、并发控制。
- **Agent 通用能力**：Function Calling / Tool Use、多轮规划（ReAct 思想）、记忆与上下文管理、成本与限流。
- **可配置的 Agent 应用**：不同场景 = 不同 Agent 编排 + 提示词 + 知识库组合。

---

## 4. 必须掌握的知识点（按优先级）

> 标注了对应的项目文件，学完立刻去代码里印证。**P0 = 周一之前必须过一遍；P1 = 上岗第一周边干边学；P2 = 了解概念即可。**

### P0 前端（约 1 天）

- [ ] JavaScript ES6+：解构、展开运算符、async/await、Promise、模块化（ESM）
- [ ] React 核心：函数组件、`useState/useEffect/useRef/useMemo/useCallback`、条件渲染、列表与 key、受控表单；理解"状态驱动视图"
- [ ] React Router：路由配置、嵌套路由、编程式导航（`src/App.jsx`）
- [ ] **SSE 客户端**：用 `fetch` + `ReadableStream` reader 逐块解析 `data:` 事件（重点看 `ContractRewritePage.jsx` 怎么消费 `stage.*` / `*.delta` 事件）
- [ ] Vite：dev server、`/api` 代理、环境变量、生产构建
- [ ] 原生 CSS：flex/grid 布局、响应式（项目不用 UI 组件库和 Tailwind，手写 CSS 能力是刚需）
- [ ] 浏览器 DevTools：Network 看流式请求、Console、React 调试

### P0 后端（约 1 天）

- [ ] Node.js 基础：模块系统、`fs/path`、Buffer/Stream、EventLoop 与异步
- [ ] Express：路由、中间件链、错误处理、`res.write` 手写 SSE（`server/routes/contract-rewrite.js` 是最好的教材）
- [ ] Multer：内存存储、文件大小/数量白名单校验
- [ ] SQLite + FTS5：建表、插入、MATCH 全文检索、BM25 排序（看 `server/services/knowledge-base.js`）
- [ ] dotenv 环境变量管理；密钥只放服务端
- [ ] 用 `node xxx.js` + `assert` 写回归脚本的习惯（`server/scripts/` 里有现成例子）

### P0 LLM / Agent 工程（约 1 天，改造工作的核心）

- [ ] Chat Completions API 通用范式：`messages/role/system`、`temperature`、`max_tokens`、**流式 delta**；OpenAI-compatible 意味着换模型只换 base_url + key
- [ ] **提示词工程**：系统提示词协议化、强制 JSON 结构化输出、输出格式约束、少样本示例、提示词注入防御（精读 `server/prompts/agent-1` 到 `agent-4` 四个文件）
- [ ] **多 Agent 编排**：任务分解 → 各 Agent 职责单一 → Agent 间通过结构化数据（而非自由文本）传递 → 服务端做校验
- [ ] **结构化输出的可靠性**：模型输出不可信 —— JSON 解析容错、字段级校验、越界/缺失时确定性回退（精读 `server/services/revision-merger.js`、`annotation-locator.js`、`finding-consolidator.js`）。这是本项目最重要的设计思想："模型建议"与"服务端可信事实"分离
- [ ] RAG 基础概念：文档切分 → Embedding → 向量检索 → 重排 → 混合召回（BM25 + 向量 RRF 融合）；对应 `knowledge-processor.js`、`vector-store.js`、`evidence-reranker.js`
- [ ] 文件解析管线常识：PDF/DOCX 抽文本、图片 OCR 前的放大/灰度/对比度预处理（`file-parser.js`）

### P1（上岗第一周补，先知道概念）

- [ ] JWT/Session 鉴权、密码哈希（bcrypt）、接口中间件鉴权
- [ ] 数据库设计：用户、会话、任务、消息的表结构；better-sqlite3 事务
- [ ] 任务队列思想：后台任务、进度事件、失败重试、幂等
- [ ] Function Calling / Tool Use 协议（OpenAI tools 格式）
- [ ] pm2 进程管理、Nginx 反向代理配置（SSE 场景）
- [ ] Docker 基本操作（compose 起服务）

### P2（了解即可）

- Qdrant 的 collection/向量维度管理；SiliconFlow embedding/reranker API
- Framer Motion 动效、postcss-px-to-viewport 移动端适配
- Token 计费与成本控制、限流

---

## 5. 代码阅读路线（配着第 4 节学，效果最好）

**前端一条线**：`src/main.jsx` → `src/App.jsx`（路由）→ `src/pages/ContractRewritePage.jsx`（重点，SSE 消费 + 多会话 + 批注渲染 + Word 导出）→ `src/pages/ContractDraftPage.jsx` → `src/utils/thread-request-state.js`

**后端一条线**：`server/index.js`（入口）→ `server/routes/contract-rewrite.js`（所有 API 编排）→ `server/services/llm-client.js`（模型调用）→ `server/services/file-parser.js`

**Agent 一条线**：`server/agents/contract-analyzer.js` → `contract-reviewer.js` → `contract-consolidator.js` → `contract-rewriter.js`，对照 `server/prompts/agent-*.js` 逐个读；再看 `annotation-locator.js`、`finding-consolidator.js`、`revision-merger.js` 三个"可信性"服务。

**知识库一条线**：`server/services/knowledge-base.js`（SQLite FTS5）→ `knowledge-processor.js`（切分/入库）→ `vector-store.js` + `evidence-reranker.js`（可选向量链路）→ `server/scripts/evaluate-knowledge-base.js`（RAG 也能评测）。

### 核心词汇表（读代码前先背下来）

| 术语 | 含义 |
| --- | --- |
| finding | 一条已定位的风险：等级、标题、原文摘录、字符区间、风险说明与建议 |
| revision group | 需要在同一修改目标中共同处理的一个或多个 finding |
| localizedEdit | `replace` / `delete` / `insert-after` / `notice` 类型的最小局部编辑（notice = 只提醒不改原文） |
| revision | 完整修订条款 + 局部编辑数组 + 服务端定位字段 |
| SSE 事件 | `stage.start/progress`、`*.delta`（流式文本）、`review.round`、`rewrite.result`、`error` |
| 确定性回退 | 模型输出不合规时不渲染错误锚点，回退到服务端已验证的 finding/quote span |

---

## 6. 四天准备计划（打卡用）

**Day 1（周四）：环境 + 全局**
- [ ] 装好 Node 24 / VS Code / 克隆仓库 / `npm ci` / 配 `.env.local`
- [ ] 前后端跑起来，健康检查通过
- [ ] 通读 `README.md` + `HANDOFF.md`
- [ ] 完整体验合同审查 + 起草两个工作台全流程，导出一次 Word
- [ ] 产出：一页"产品流程图"（自己画，标出每步对应哪个 API）

**Day 2（周五）：前端线**
- [ ] React Hooks 补课（官方教程过一遍即可，别陷进去）
- [ ] 读完 `ContractRewritePage.jsx`，弄懂 SSE 是怎么被消费、会话状态怎么管理
- [ ] 跑 `npm run build` 确认无报错
- [ ] 产出：SSE 事件流时序图（从 `POST /api/contract-rewrite` 到页面渲染）

**Day 3（周六）：后端 + Agent 线**
- [ ] Express/SSE 服务端写法看懂 `contract-rewrite.js`
- [ ] 精读 4 个 Agent 提示词 + 4 个 agent 文件，理解管线如何串联
- [ ] 理解"服务端校验 + 确定性回退"思想（revision-merger / annotation-locator）
- [ ] 产出：多 Agent 管线图（含每个 Agent 的输入/输出/失败回退）

**Day 4（周日）：知识库 + 查漏**
- [ ] SQLite FTS5 检索链路 + RAG 概念过一遍
- [ ] 跑通 3 个回归脚本
- [ ] 补 P0 清单里没完成的项目
- [ ] 产出：一份「我理解的项目现状 vs Agent 应用网站改造需要补的能力」清单（周一讨论用）

---

## 7. 周一上岗自查（全部打勾才算准备好）

- [ ] 能在 10 分钟内从零启动前后端并复现一次完整审查
- [ ] 能不看资料说出：一次审查请求依次经过哪些 Agent、哪些服务端校验、失败怎么回退
- [ ] 能说清 SSE 事件如何从服务端产生、在前端被消费
- [ ] 能解释 finding / revision / localizedEdit / notice 四个概念
- [ ] 能指出任何一个 API 对应的前端触发点和后端处理文件
- [ ] 知道三个绝对红线（见下）

## 8. 红线与纪律

1. **密钥永不入库入码**：API Key 只存在于 `.env.local`，该文件被 Git 忽略；发现硬编码立即报告。
2. **不跑破坏性命令**：不使用 `git reset --hard`、`rm -rf`、强制清理类操作；改动前先确认在哪个目录、哪个分支。
3. **模型输出永远不可信**：任何 Agent 输出在进页面/进库前必须过服务端校验；这是本项目最重要的工程原则。
4. **改代码前先跑回归**：`test:consolidation` / `test:word-annotations` / `test:concurrency` + `npm run build` 是提交前的标准动作。
5. 遇到卡点超过 1 小时自行解决不了，带着"我做了什么、预期 vs 实际、报错原文"来问。

## 9. 学习资源（官方文档为准）

- React：https://react.dev （有中文）
- Vite：https://cn.vite.dev
- Express：https://expressjs.com
- Node.js：https://nodejs.org/docs
- MDN（JS/CSS/ fetch 流）：https://developer.mozilla.org/zh-CN
- SQLite FTS5：https://www.sqlite.org/fts5.html
- DeepSeek API 文档：https://api-docs.deepseek.com/zh-cn （OpenAI-compatible 用法相同）
- Qdrant：https://qdrant.tech/documentation
- SSE 概念：MDN "Server-sent events" 词条
