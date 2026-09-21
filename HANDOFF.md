# HANDOFF · 法飞飞 AI「用工咨询」功能

> 更新时间：2026-09-20（第四轮：模型配置统一 + 多轮记忆 + 检索词改写 + 附件多选）
> 工作区：`/Users/ypc/Desktop/归档项目/infimind-react`
> **⚠️ 当前目录不是 Git 仓库**（归档副本，`git rev-parse` 会失败）。详见第 6.8 节纪律。
> 本文档写给**完全没有上下文的新会话**。读完这一份即可开工。

---

## 1. 我们在做什么任务

给「法飞飞 AI」增加**第三个工作台：用工咨询**——面向企业方的劳动法问答，区别于已有的两个合同工作台（合同审查 `/contract-rewrite`、合同起草 `/contract-draft`）。

**产品定位**：站在企业家立场的劳动仲裁/用工风险咨询。

**核心工程命题只有一条：消灭"模型编造法条"。**
法律 AI 最致命的一类错误是援引不存在的法条，因此本功能的全部设计围绕「模型输出不可信，服务端给可信事实」展开。这条原则也贯穿合同链路——任何 Agent 产物进页面/进库前必须过服务端校验。

**技术栈**：React 18 + Vite（前端）/ Express 4 ESM（后端 8789）/ better-sqlite3（本地知识库）/ Qdrant（合同知识库向量库）/ 硅基流动 SiliconFlow（embedding + rerank）/ DeepSeek（生成）。

---

## 2. 已完成什么

### 2.0 总览

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| S0 | 提示词 + 咨询页 + SSE 接口 | ✅ |
| S1 | 法规白名单 + 引用校验 | ✅ |
| S2 | 典型案例库 | ✅ |
| S3 | 五册实务资料入库（764 条） | ✅ |
| — | 混合检索（语义+全文）+ 模型重排 | ✅ |
| — | 性能修复（合同链路 120s 阻塞） | ✅ |
| — | 检索可靠性修复（内层并行 / 超时总预算 / 降级可见） | ✅ |
| — | Qdrant 部署 + 向量索引灌库 | ✅ |
| — | embedding 切 Pro 档（解决排队） | ✅ |
| — | 向量索引可诊断性 + 跨进程缓存失效 | ✅ |
| — | **模型配置统一（两档 flash + 档位区分 + 输出上限）** | ✅ 第四轮 |
| — | **思考过程可见（SSE 透传 + 折叠面板）** | ✅ 第四轮 |
| — | **多轮记忆（追问改写 + 附件会话归档）** | ✅ 第四轮 |
| — | **附件多选修复（三个工作台）** | ✅ 第四轮 |

### 2.1 S0｜提示词 + 咨询页 + 接口

| 交付 | 文件 |
| --- | --- |
| 系统提示词（含三处法律事实修正、当前日期注入、法规时效基准、引用纪律） | `server/prompts/labor-consult.js` |
| 咨询页（多会话、SSE、证据抽屉、引用核实面板、双模式、附件上传） | `src/pages/LaborConsultPage.jsx` / `.css` |
| 接口：`POST /api/labor-consult`(SSE)、`POST /api/labor-consult/verify`、`GET /api/labor/status`、`GET /api/labor/laws` | `server/routes/labor-consult.js` |
| 路由与导航 | `src/App.jsx`、`src/components/Header.jsx`（「劳动用工工具」分组） |

**修正的三处法律事实错误**（原提示词有误，会直接诱导模型编造法条）：

| 原文 | 事实 |
| --- | --- |
| 延迟退休「2026.1.1 开始正式实行」 | **自 2025-01-01 起施行**（2024-09-13 全国人大常委会决定，已生效） |
| 必须引用「《劳动合同法》2025年修订版第38条」 | **不存在 2025 年修订版**；现行为 2012 年修正、2013-07-01 施行 |
| 拒绝引用「2019年版《职工带薪年休假条例》」 | 该条例为国务院令第514号，2008-01-01 施行，**现行有效，从未废止** |

> 提示词里「使用搜索工具验证法规」是**空指令**——本项目 LLM 层没有 Function Calling，也没接搜索工具。
> 已改为服务端注入时效基准 + 输出后引用校验，这才是可落地的实现。

### 2.2 S1｜法规白名单 + 引用校验

| 交付 | 文件 |
| --- | --- |
| 白名单（19 部核心劳动法规，含时效字段） | `server/services/law-whitelist.js` |
| 引用校验器（抽取→逐条核实→去重） | `server/services/citation-verifier.js` |
| 运营核对清单工具 | `server/scripts/verify-law-whitelist.js` |

**核心机制：不在白名单里的法规，一律标注「未收录，需人工核实」。**
这把风险从"模型判断法规是否有效"（不可控）转移到"白名单覆盖度"（可度量、可审计）。
失败模式是**拒绝引用**（安全），而不是**错误引用**（危险）。

校验分级：`verified` / `provisional`(已收录待复核) / `superseded` / `repealed` / `expired` / `not_found`。

**实测六种情形全部正确**：

| 输入 | 判定 |
| --- | --- |
| 《劳动合同法》第三十八条 | ✅ 已核实（2012年修正，2013-07-01 施行） |
| 《劳动合同法》**2025年修订版**第三十八条 | ❌ 版本号未见于白名单记录 ← **防幻觉关键能力** |
| 《合同法》第一百零七条 | ❌ 已废止，由《民法典》取代 |
| 《劳动争议调解仲裁法》第二十七条 | ✅ 已收录（待复核） |
| 《虚构法》第一条 | ❌ 未收录，需人工核实 |
| 劳动合同法第三十九条（无书名号） | ✅ 已核实 |

### 2.3 S2｜典型案例库

`server/knowledge-base/labor-cases-seed.js` —— 人社部、最高法《劳动人事争议典型案例（第四批）》
（人社部函〔2025〕28号）**5 例忠实转录**，含争议焦点、裁判要点、适用法条、来源链接。

> 案例刻意保留了对企业不利的裁判口径（孕期调岗降薪、社保补缴、竞业限制适格主体等）——
> 站在企业方做风险判断，**必须先知道对己不利的官方口径**，否则给不出可执行建议。

### 2.4 S3｜五册实务资料入库

用户提供的五册《用工风险》实务资料 → 解析入库：

| 册 | 条目数 |
| --- | --- |
| 第一册 | 151 |
| 第二册 | 218 |
| 第三册 | 121 |
| 第四册 | 145 |
| 第五册 | 129 |
| **合计** | **764 条，正文 1,092,312 字** |

**其中 268 条（35%）含真实裁判文书案号**，平均答案长度 1430 字。

| 交付 | 文件 |
| --- | --- |
| 解析器（目录/正文切分、层级映射、页眉剥离、跨页断句修复） | `server/services/labor-book-parser.js` |
| 问答库（建表、幂等导入、检索） | `server/services/labor-kb.js` |
| 导入脚本（内置种子 / 外部 JSON / 脱敏校验 / `--list` / `--dump`） | `server/scripts/import-labor-books.js` |
| 归一化文本（可重新切分，原始 docx 不在仓库） | `server/knowledge-base/labor-books/*.txt`（5 册，3.1 MB） |

### 2.5 附件上传

输入框支持上传材料（与合同工作台一致）：PDF/Word/Excel/PPT/RTF/文本/图片，单个 ≤80MB，一次 ≤6 个。
共享配置抽到 `server/services/upload-config.js`。

行为设计：单个附件解析失败**不中断**整轮咨询；附件正文超 4 万字符**按比例截断**（保留每份开头）；
支持**仅传附件、不写提问**；新增 `consult.progress` 事件反馈解析进度。

### 2.6 混合检索（语义 + 全文）+ 模型重排

```
用户提问
  ├─ 路① 实务问答（主力）
  │     词法召回  FTS5（2-gram 短语查询）+ 标题 LIKE 补齐   → 30 条
  │     语义召回  bge-m3 向量 + 暴力余弦（1024 维）        → 30 条
  │        └ RRF 融合 1/(60+rank) → 取 top 24
  │              └ 模型重排 bge-reranker-v2-m3
  │                    └ 阈值过滤（重排原始分 < 0.05 丢弃，保底 2 条）
  │     返回 top 6
  ├─ 路② 合同知识库（次要信号）
  └─ 路③ 案例库
三路并行执行
```

| 交付 | 文件 |
| --- | --- |
| 硅基流动客户端（embedding + rerank，重试/超时/**降级遥测**） | `server/services/siliconflow-client.js` |
| 向量索引（BLOB 存储 + 暴力余弦 + 内容哈希判重） | `server/services/labor-vector.js` |
| 索引构建脚本 | `server/scripts/build-labor-embeddings.js` |

**⭐ 存储决策：用工咨询刻意不引入 Qdrant。** 764 条 × 1024 维 ≈ 3MB，暴力余弦亚毫秒完成。
而 Qdrant 需要额外服务——**项目现状正是因为它没部署，导致合同知识库的向量路长期静默失效**。

**效果（30 题 LLM 判定 + 采样 120 条确定性评测）**：

| 指标 | 纯词法 | **混合 + 重排** |
| --- | --- | --- |
| precision@1 | 50.0% | **66.7%** |
| precision@6 | 23.3% | **33.9%** |
| hitrate@5 | 80.0% | **93.3%** |
| 标题 Recall@1 / @10 | 89.0% / 98.4% | **99.2% / 100.0%** |
| 内容 Recall@1 / @10（严格） | 55.2% / 73.8% | **76.9% / 92.3%** |

### 2.7 性能修复（第一轮，既有缺陷）

**症状**：一次用工咨询耗时数分钟。根因在 `server/services/vector-store.js`（合同审查链路共用）：

1. `searchVectorEvidence` **先做 embedding 再查 Qdrant** —— 而 Qdrant 从未部署，embedding 白做一遍并丢弃。
2. 这些 `fetch` **全都没有超时**（`vector-store.js` 4 处 + `evidence-reranker.js` 1 处）。上游 5xx 时无限等待，实测单路径阻塞 **120 秒**。

**修复**：Qdrant 探活（30s 缓存，不可达即跳过）+ 全部外部请求加超时 + 外层三路检索改 `Promise.allSettled` 并行。

**效果**：检索阶段 **120s+ → 1.2~1.5s**；端到端 **数分钟 → 14.4s**。

> ⚠️ **这一轮只修了外层。** 见 2.8。

### 2.8 ⭐ 检索可靠性修复（第二轮）

第一轮留下了三个洞，本轮补齐。

#### (1) 内层两路仍串行

`retrieveLaborEvidence` 里两次 `await searchEvidence(...)` 顺序执行。外层并行了，**内层没有**。

| | 实测 |
| --- | --- |
| 改前（串行） | **986ms** |
| 改后（`Promise.allSettled`） | **533ms** |

安全性：两路只读同一 SQLite 连接，候选集各自为局部变量，无共享可变状态。better-sqlite3 是同步的，所以收益全部来自两次 rerank 外部调用重叠。

#### (2) 超时 ≠ 总预算（**最隐蔽的一个**）

`siliconflow-client.js` 的 `requestWithRetry` 把 `AbortController` 建在**重试循环体内**——每次重试都拿到一个全新的 30s 窗口。于是「加了超时」只是把无限等变成有限等：

```
限流(429)路径:  4 × 30s + 退避(2+4+8s)     = 134s
超时/网络路径:  4 × 30s + 退避(0.8+1.6+2.4s) = 124.8s
```

**与修复前的 120s 阻塞是同一量级。** 已改为 deadline-aware：新增 `SILICONFLOW_TOTAL_TIMEOUT_MS`（默认 = `REQUEST_TIMEOUT_MS` = 30s）与 `MIN_ATTEMPT_MS`（500ms），每次尝试超时取 `min(单次上限, 剩余预算)`，预算不足即放弃。

实测（2000ms 单次 / 5000ms 总预算 / 4 次重试）：**12800ms → 4813ms**。
快速失败（上游立刻返回 5xx）的重试行为不受影响——那正是重试真正有用的场景。

#### (3) 合同侧降级完全不可见（违反项目红线）

`knowledge-base.js` 的向量降级与 `evidence-reranker.js` 的重排降级**只打一行 `console.warn`**，且异常在 `searchEvidence` 内部就被吞掉 → 接口层永远不 reject → `warnings` 一条都不会出现。**这条路径 100% 降级却对用户与监控完全不可见。**

这是本项目吃过两次亏的同一个模式（"以为在跑混合检索、实际是坏掉的单路词法"）的合同侧版本。

已补齐三件事：**health 计数器** + **结构化分类**（`rate_limit`/`network`/`auth`/`server`/`qdrant_unreachable`…）+ **写入用户可见 `warnings`**，并翻译成人话（`qdrant_unreachable` → 「向量库未部署或不可达」）。

新增查询入口：`GET /api/labor/status` 返回 `evidence: { vector, rerank }` 计数。

### 2.9 Qdrant 部署

| 项 | 值 |
| --- | --- |
| 容器 | `infimind-contract-rag`，`restart: unless-stopped` |
| 版本 | Qdrant **1.19.1** |
| 端口 | 6333（HTTP）/ 6334（gRPC） |
| collection | `contract_knowledge_evidence`，**2057 points** / 1024 维 / Cosine / green |
| 编排文件 | `docker-compose.rag.yml`（项目自带，本次直接用它） |

**部署路径（国内网络）**：Docker Hub 直连不通（`registry-1.docker.io` → HTTP 000），
走 `docker.m.daocloud.io` 镜像源拉取后 tag 为 `qdrant/qdrant:latest`，再用 compose 启动。

**灌库过程中发现并修复的缺陷**（`vector-store.js`）：

| 缺陷 | 后果 |
| --- | --- |
| `embedTexts` **完全没有重试** | 2057 条要发 65 批请求，一批慢就前功尽弃。实测 **4/65 批触发重试** |
| 复用检索热路径的 8s 超时 | 批量灌库（32 条全文/批）根本不够，直接 AbortError |

修复：拆出独立预算 `RAG_EMBEDDING_TIMEOUT_MS`(120s) / `RAG_EMBEDDING_BATCH_SIZE`(32) / `RAG_EMBEDDING_MAX_RETRIES`(3)，并加进度上报（分钟级操作必须可观测）。

**效果**：降级警告消失；证据数 **4 → 9**；`evidence.vector: {attempted, ok, degraded:0, available:true}`。

> ⚠️ 同步向量**不要**跑 `npm run import:templates` —— 它会 `resetKnowledgeBase()` 全量重建，
> 若源目录不完整会丢数据。要用定向同步：`syncVectorIndex(listIndexableEvidence(), { rebuild: true })`。

> ℹ️ `indexed_vectors_count: 0` 是正常的：2057 × 1024 × 4B ≈ 8.4MB，低于 Qdrant 默认 20MB 的 HNSW 建索引阈值，
> 当前走暴力检索，此规模下亚毫秒级。数据量涨上去会自动建索引。

### 2.10 ⭐ embedding 切 Pro 档（解决排队）

**问题**：免费共享档 `BAAI/bge-m3` 会排队。

**实测（30 轮交错发送，排除平台负载随时间漂移）**：

| 模型 | 维度 | p50 | max | 异常 | >10s |
| --- | --- | --- | --- | --- | --- |
| `BAAI/bge-m3`（免费共享） | 1024 | 0.4s | **120.1s** | **HTTP 500** | 1/30 |
| **`Pro/BAAI/bge-m3`**（现用） | **1024** | **0.3s** | **1.2s** | 无 | 0/30 |
| `Qwen/Qwen3-Embedding-4B` | 2560 | 0.8s | 2.2s | 无 | 0/30 |

免费档 **30 次请求就有约 7% 异常率**，与灌库时 4/65 批重试吻合。

**为什么选 Pro 而不是 Qwen**：`Pro/BAAI/bge-m3` 是**同一模型权重的专属实例**，实测同文本向量余弦相似度 **1.000000**，维度同为 1024 → 避开 Qwen 的 2560 维迁移（`DIM_EXPECTED` 失配、764 条作废、2057 条重建）。且 Qwen p50 慢一倍（0.8s vs 0.3s）。

**效果**：灌库每批 **8.6s → 0.3s（快约 29 倍）**；重建 764 条仅 **19.2s**、0 失败 0 降级。

**⚠️ 切换时必须重建索引**：`labor-vector.js` 用**模型名字符串作为向量的键**（`WHERE model = ?`）。
改了 `RAG_EMBEDDING_MODEL` 而不重建 → 查询 0 行 → `index_empty` → 语义召回静默降级。
这是**良好设计**（拒绝混用不同模型的向量），但必须知道。

**重排器刻意未切**：同档位实测免费档 `BAAI/bge-reranker-v2-m3` 25 次 max 0.72s、零错误，完全干净。
这反而让诊断更精确：**同为免费档，重排器不排队、embedding 排队** → 是 bge-m3 这个**模型**的争用（平台上最热门的 RAG embedding），不是免费档整体限流。

### 2.11 评测体系

| 脚本 | 用途 |
| --- | --- |
| `server/scripts/evaluate-labor-kb.js` | 确定性指标：标题/内容召回、2-gram 分词对照、真实提问抽样。支持 `--sample N` |
| `server/scripts/evaluate-labor-kb-precision.js` | **准确率**：LLM 逐对判定相关性，含 precision@k/hitrate@k 曲线与阈值分析。**带判定缓存** |
| `server/scripts/tune-labor-kb.js` | 参数扫描（基于判定缓存，不重复调模型） |
| `server/scripts/test-labor-consult.js` | 回归测试 **55 项**（不调用模型；第二轮扩了 5 项，见 2.12） |

**判定缓存**在 `server/knowledge-base/labor-kb-labels.json`（已加入 `.gitignore`）：
打分函数调优可复用同一批判定，成本几乎为零，且结论可比。

**耗时构成**：检索 ~2.0s + 模型生成 ~13s。**大头是模型生成，不是检索。**

### 2.12 ⭐ 向量索引可诊断性修复（第三轮）

**问题**：`语义召回（index_empty）已降级` 频繁出现且无法自诊断。根因是三个耦合：
模型名既是**索引键**又是**环境变量**又被**进程内缓存**，且 `.env.local` 不随仓库走。

| # | 缺陷 | 后果 |
| --- | --- | --- |
| 1 | **空索引被永久缓存**（`loadIndex()` 把 `count:0` 写进 `indexCache`，只在本进程写入时失效） | `npm run build:labor-embeddings` 是**独立进程**，服务器无从感知 → **必须重启服务器**语义召回才恢复 |
| 2 | 状态只返回**配置**的模型名，不返回库内实际的 | 改过 `RAG_EMBEDDING_MODEL` 却没重建时，只表现为 `embedded=0`，看不出原因 |
| 3 | `index_empty` 不分场景 | 「从没建过」与「模型名对不上」报同一条消息，但处置动作不同 |

**修复**：

- **`PRAGMA data_version` 做跨进程缓存失效**：该 pragma 只在**其它连接**提交修改后变化（已实测：同连接读写不变、跨进程写入 2→3），语义正好匹配。空索引也连同版本一起缓存，因此既不重复查库、又能被外部改动失效。重建开销实测 **+1.12ms**，只在库被外部改动时发生一次。
- **状态暴露 `storedModels` + `modelMismatch`**：`GET /api/labor/status` → `kb.search.vector` 现在能看到「库内实际是什么模型」。启动日志直接打印警告与修复命令。
- **区分四种原因**：`model_mismatch` / `index_empty` / `index_corrupt` / `dim_mismatch`，各自映射中文标签写入用户可见 `warnings`。
- **启动时打印向量索引状态**（`server/index.js`），让问题在启动阶段而非首次提问时暴露。

**端到端验证**：服务器启动时索引为空 → 第一次咨询把空索引缓存 → **独立进程重建** → **不重启服务器**，下一次咨询语义召回自动恢复（改前会一直卡在 `index_empty` 直到重启）。

**顺带修掉的既有缺陷**（code review 发现）：

| 缺陷 | 危害 |
| --- | --- |
| `loadIndex()` 用 `rows[0].dim` 作所有行的步长，不校验一致性 | 混维时 `row.dim > dim` **越界写入甚至抛 RangeError 打断检索**；`row.dim < dim` 留下空洞使相似度恒为 0 → **排序静默错误**。现检测到混维即**拒绝加载**（降级为可见的 `index_corrupt`），并给出 `--force` 重建命令 |
| `buildEmbeddings` 遇到维度异常**只 warn 却照样入库** | 正是上面脏数据的上游。现改为**跳过不入库** |
| `saveEmbedding` 对 `Float32Array` 跳过归一化（`searchVector` 却总是归一化） | 隐含假设"Float32Array 必然已归一化"，无任何保证。当前不可达（唯一调用方传 `number[][]`），属潜在陷阱。已改为无条件归一化（实测现有向量范数精确为 1.000000，改动幂等） |
| `getLaborVectorStatus()` 的 `dim` 查询缺 `WHERE model` 条件 | 库内存在其它模型向量时会报出错误维度。已补上 |

**新增回归测试 5 项**（总计 **55 项**）：状态暴露模型名、`modelMismatch` 不误报、`dimension` 按模型过滤、`resetIndexCache` 不改变结果、`PRAGMA data_version` 语义前提。

> ⚠️ 跨进程失效依赖 `PRAGMA data_version` 的语义。若 SQLite/better-sqlite3 升级改变该行为，缓存将永不失效或每次都失效——已加回归断言守护。

**效果核验**（三次运行，同一确定性样本）：

| 指标 | 基线 | 本轮 #1 / #2 / #3 |
| --- | --- | --- |
| 标题 Recall@1（索引健康度） | 99.2% | **99.2% / 99.2% / 99.2%** |
| 标题 Recall@10 | 100.0% | **100.0% / 100.0% / 100.0%** |
| 严格 Recall@10 | 92.3% | 90.8% / 92.3% / **92.3%** |
| 严格 Recall@1 | 76.9% | 73.8% / 75.4% / 75.4% |

> 严格 Recall@1 在 65 条样本上波动 ±1.6pt（= 1 条），**两次同代码运行就有此差异**（重排器偶发 `rate_limit` 重试）。
> 索引健康度指标（标题 Recall）三次均与基线精确一致——那正是本轮改动触及的路径。
> 对比时必须用同一脚本、同一参数、同一缓存状态。

### 2.13 模型配置统一（第四轮）

**产品决策**：不再用 pro 模型做深度思考，两个模式统一走 `deepseek-flash`，只靠**思考档位**区分。

| 模式 | 模型 | `reasoning_effort` | `max_tokens` | 实测耗时 |
| --- | --- | --- | --- | --- |
| 快速 | `deepseek-flash` | `high` | 393216 | ~40s |
| 深度思考 | `deepseek-flash` | `max` | 393216 | ~168s |

**⭐ 过程中撞到一个必现故障：`max_tokens` 与思考共用预算。**

按原配置（快速 4096 / 深度 8192）改完档位后，**深度思考档 100% 失败**：

```
reasoning=19949字, content=0字, finish=length   ⚠️ 无正文输出
```

模型在**思考阶段就撞上 token 上限**被 `finish=length` 截断，一个字正文都没输出。快速档（high）思考较短所以侥幸没触发。**所以「把 `max_tokens` 给到最大值」不是保险，而是让 max 档能工作的必要条件。**

- API 明确回包：`valid range of max_tokens is [1, 393216]`；**上下文窗口 1,048,576 tokens**，且校验 `messages + completion ≤ 窗口`。
- 最坏输入约 12.4 万字符 ≈ 83K tokens，占剩余输入预算（655K）的 **13%** —— 余量充足，`max_tokens=393216` 不会撑爆上下文。
- 两个模式统一用 `MAX_OUTPUT_TOKENS`（可被 `LABOR_MAX_TOKENS` 覆盖）。

**`.env.local` 模型名改为官方名**：`DEEPSEEK_FLASH_MODEL=deepseek-flash`。
此前写的是 `deepseek-v4-flash` —— 传它能返回 200，但响应里是 `deepseek-flash`，且 API 报错信息只列 `deepseek-flash, deepseek-v4-pro`。**那是个未文档化的别名，不该依赖。**

### 2.14 思考过程可见（第四轮）

深度思考要等 168 秒，缺乏反馈。现在把思考流式展示出来。

- **后端 `consult.reasoning` 单独成路**，**绝不并入 `answer`** —— 引用校验只针对正文。思考里出现的法条常是模型自我排除的候选（甚至是被否定的错误版本），混进去会产生大量假的"未收录"告警。实测引用校验 6 处全部来自正文。
- **前端 `ReasoningPanel`**：流式期间自动展开 + 跟随滚动 + 底部渐隐，**正文一到自动折叠**。视觉刻意做弱（灰底小字、无重边框），正文始终是唯一主体。
- **只在首块自动展开**，之后不干预——否则用户手动收起会被下一块内容强行顶开。
- **持久化裁剪到 8000 字**：单条思考可达 4.7 万字，而 `writeStorage` 的 catch 是**静默**的，一旦超出 localStorage 配额**整个会话历史会停止保存且没有任何提示**。

**`llm-client` 诊断增强**（靠它才定位到 `max_tokens` 那个故障）：

```
[llm-client] Starting stream with model: deepseek-flash, thinking: enabled, reasoning_effort: max, input ~25386 chars
[llm-client] Stream done. tokens=47727, chunks=12375, reasoning=47552字, content=3965字, finish=stop
```

原来只记 `chunks`，无法区分"模型没答"与"流断了"。现在 `content=0` 会直接标 `⚠️ 无正文输出（思考可能耗尽了预算）`。

### 2.15 ⭐ 多轮记忆与追问检索（第四轮）

**修复前实测的两个硬伤**（HANDOFF 曾把"多轮检索"列为"未测"，实际是**设计上就坏的**）：

| 问题 | 证据 |
| --- | --- |
| **追问检索不使用上下文** | `retrievalQuery = message` 只用本轮。「那这种情况怎么办」被分词器抽成 **`况怎么办`** 这类碎片词，召回的是工作交接、恢复劳动关系等**与上文毫无关系**的条目 |
| **附件正文追问时丢失** | 前端只存 `{name, size}`，正文从不进入 message；下一轮 `files` 为空 → **模型看不见第一轮上传的合同** |

#### (1) 追问检索改写（query rewriting）

新增 `server/services/query-rewriter.js`：一次短 LLM 调用把追问改写成**自足**的检索查询。

**实测效果**（这是本次最直观的改善）：

| | 检索结果 |
| --- | --- |
| 改写前 | 工作交接、恢复劳动关系、协商解除 —— **全无关** |
| 改写后 | 竞业限制协议效力、竞业限制义务、违法解除 —— **全命中** |

- **只在有上文时改写**（首轮无可解析的指代，实测 `attempted=false, reason=no_context`，不浪费调用）
- **实测延迟 412~1330ms**，远低于预估的 2s —— 显式关闭 thinking，输出只有 12~17 tokens
- **启发式降为 fallback**，不是死代码：`buildHeuristicQuery` 在改写不可用时仍是唯一路径
- **失败必须回退**：实测伪造无效 Key → `used=false, reason=auth_failed` → **回退后咨询照常完成**
- **拒绝垃圾输出**：`validateRewrite` 剥前缀/引号/代码块，并拒绝超长、多句成段、复述提示词标记的输出
- 可用 `LABOR_QUERY_REWRITE=off` 关闭（省下每轮约 0.4~1.3s，代价是长句纯指代仍会跑偏）

#### (2) 附件正文纳入会话记忆

新增 `server/services/consult-material-store.js`：按客户端生成的会话 id 归档材料，追问轮复用。
生命周期沿用 `review-session-store.js` 的范式（TTL 2h + 总量 200 + 单会话 40000 字符上限）。

**为什么存服务端而不是塞进对话历史**：正文可达数万字，塞进 `history` 会随每轮请求重复上传；塞进前端会迅速吃满 localStorage（且超限是静默的）。

配套：新增 `POST /api/labor-consult/forget`，前端删除会话时调用——否则被删会话的合同原文会在内存里留 2 小时（隐私相关）。

实测：三轮追问 `attachments` 始终为 `["测试合同.txt"]` ✅

### 2.16 附件多选修复（第四轮）

用户反馈"附件只能上传一份"。**根因与"多格式"无关**——代码里本来就有 6 份上限、28 种格式、`multiple` 属性。真正的问题是一行：

```js
setFiles(accepted)   // ← 整体替换，不是追加
```

分几次选文件时上一次的选择被整个丢掉。一次框选多份反而是好的，这让问题容易被误判成"数量限制"。

**顺带修掉两个相关问题**：

| 问题 | 说明 |
| --- | --- |
| **无扩展名文件被前端放行、后端 400 拒绝** | `ACCEPTED.includes(ext)` 在无扩展名时变成 `includes('')`，**空串是任何字符串的子串 → 恒为 true** |
| **格式白名单三处副本已漂移** | 用工咨询页 164 字符（含 `.markdown`），两个合同页 154 字符（不含）。而 `upload-config.js` 注释写着"避免两处定义漂移"，前端却从未 import 过它 |

**三个工作台是同一个 bug**，已一并修复（只修一个会留下不一致）。新增 `src/utils/file-selection.js` 统一：
追加而非替换、精确格式校验、共享白名单（实测 Vite 可正常打包纯常量模块，前端 +2.1kB）、分别说明"格式不支持"与"超出数量"的拒绝文案。

行为约定：同名 + 同大小 + 同修改时间 → 视为重复选择忽略；同名但内容变了 → 视为修订版**就地替换且不占新名额**。用三要素而非仅文件名判定，否则用户改了合同再重选会被误判为重复。

---

## 3. 当前卡在哪儿

### 3.1 阻塞项（需人工决策或人工操作）

| # | 事项 | 影响 | 处理方式 |
| --- | --- | --- | --- |
| 1 | **法规白名单 15/19 条待人工核对** | 未核对条目的引用只标注「已收录（待复核）」，可信度打折 | `npm run verify:laws` 拿清单，核对后 `npm run verify:laws -- --confirm "法规全称" 姓名` |
| 2 | **五册资料的著作权** | 归一化文本 3.1MB 在仓库内，若仓库对第三方可见需确认授权 | 确认授权范围，或将 `server/knowledge-base/labor-books/` 加入 `.gitignore` 改为部署时导入 |
| 3 | **`Pro/` 档是否计费待确认** | 免费额度可能不覆盖 Pro 档，产生费用 | 查硅基流动账户账单 |
| 4 | **工作目录不是 Git 仓库** | 全部改动无版本控制兜底 | 尽早同步到真实 clone（`git@github.com:spaceyzx216/infimind-react.git`） |
| 5 | ~~**8789 服务需重启**~~ **已解决** | 服务已重启（PID 63759），启动日志确认 `model=Pro/BAAI/bge-m3 764/764`；实测合同侧向量路已生效（`searchEvidence` 1210ms → **9 条**证据，来源 `clause:1 / risk_rule:8`），Qdrant `status=green points=2057` | 若再次改动依赖，记得重启 `npm run server` |

### 3.2 内容缺口（检索已尽力，语料确实没有）

30 题评测中**仅剩 1 个**未命中，经诊断**为语料缺口而非检索缺陷**：

| 提问 | 诊断 |
| --- | --- |
| 员工主动辞职，公司还需要支付经济补偿吗 | **库内确无该主题**（现有条目均为"特定情形下辞职可获补偿"） |
| ~~未签书面劳动合同，二倍工资最多支持几个月~~ **已修复** | 混合检索 + 模型重排后首位命中「应签未签无固定期合同的2倍工资最长支付多久？」（`Pro/` 档切换后复测确认） |
| ~~员工连续旷工三天按严重违纪解除~~ **已修复** | 首位命中「出勤类违纪解除败诉节点与风险防范」 |

**补齐方式**：追加资料，或用 `npm run import:labor-books -- --dump "关键词"` 验证后补充同义词。

### 3.3 未完成的验证

| 事项 | 说明 |
| --- | --- |
| **参数扫描未跑完** | 上轮中断了后台扫描（并发量打爆 SiliconFlow 限额），需在服务空闲时重跑，且一次只扫一个参数 |
| ~~thinking 模式端到端未测~~ **已测** | 第四轮实测：深度思考（max 档）~168s、思考 4.7 万字、正文 3965 字、`finish=stop`；快速（high 档）~40s |
| ~~多轮对话检索未测~~ **已修复并实测** | 原为**设计缺陷**（`retrievalQuery` 只用本轮 + 附件不进入记忆），见 2.15。现已接入 LLM 改写 + 会话材料存储 |
| **前端视觉未人工验收** | 证据抽屉、引用核实面板、附件上传、**思考过程折叠面板**的视觉效果需浏览器确认 |
| **Pro 档长期稳定性未验证** | 30 次样本、几分钟窗口，未覆盖跨时段波动 |
| **跨进程缓存失效的跨进程部分未自动化** | 已验证 `PRAGMA data_version` 的**同连接不变**语义（有回归断言），但"其它连接改动后失效"只做了手动验证——回归测试里做 DB 变更风险过高 |
| **思考档位的质量差异未评估** | 已知 `max` 比 `high` 思考更长（4.7 万字 vs 6.7 千字）、更慢（168s vs 40s），但**回答质量是否更好没有评测**。现有 `evaluate:labor-kb-precision` 只评检索、不评生成 |

### 3.4 已知残留缺陷（未修，优先级低）

| 事项 | 说明 |
| --- | --- |
| **`kbStatus` 槽位从未注入** | `buildLaborConsultSystemPrompt` 定义了 `kbStatus` 参数但调用时没传 → **降级信息只给用户看，模型不知道**。降级轮次里模型仍以为拿到了完整证据。改动最小、收益明确 |
| **`region` 是死参数** | 后端支持 `req.body.region`，前端从不发送 → `searchCases` 的地区加成永远不生效 |
| **history 配置三层不一致** | 前端 `slice(-6)`、后端 `MAX_HISTORY=12`、`llm-client` 又 `slice(-12)`。真正生效的是前端的 6，后两处永远不触发 |
| **历史按字符硬截断且无提示** | 每条 6000 字符，长回答会被腰斩，可能把一条法条引用切成两半，模型看到的是残缺文本 |
| **历史里不含证据与引用** | 模型看不到自己上轮引用了哪些法条/案例，多轮里容易口径漂移 |
| **collection 空时无告警** | Qdrant collection 存在但为空 → `used:true, count:0`，**不触发降级警告**（`count:0` 只体现在 `retrieval` 元信息里）。失败模式仍安全（collection 不存在时查询 404 → 会正确标降级） |
| **两套 rerank 客户端并存** | `siliconflow-client.js::rerank()`（有重试/health/分类）vs `evidence-reranker.js::siliconFlowRerank()`（无重试、独立 8s 超时）。同模型同上游，合同侧那套能力弱一档 |
| **无检索总预算** | 当前靠各自超时约束，没有端到端硬上界（如 3s race） |
| **合同知识库中文分词仍是坏的** | `templates.db` 词汇召回 14.8%。本功能用的是 `labor.db`（已用 2-gram 修好）。诊断与方案见 `docs/知识库优化方案.md`，**尚未实施** |
| `saveEmbedding` 的 `ON CONFLICT(entry_id)` 会覆盖 model 列 | 若同一 `entry_id` 曾被别的模型写过，重建时会被改写为当前模型——这是期望行为，但意味着库里可能残留其它模型的孤儿行（不影响检索，按 model 过滤） |

---

## 4. 下一步计划（按优先级）

### P0｜上线前必做

1. **核对法规白名单**（15 条，`npm run verify:laws`）—— 这是引用可信度的基础
2. **确认 Pro 档计费方式**（第 3.1 节第 3 项）
3. **确认五册资料著作权处理方式**（第 3.1 节第 2 项）
4. **前端人工验收**：浏览器打开 `/labor-consult`，跑通
   「纯提问 / 带附件（**多选多种格式**）/ 追问（**看思考面板折叠**）/ 引用核实面板 / 证据抽屉四个页签」

### P1｜效果提升

5. **注入 `kbStatus`**（第 3.4 节）—— 让模型知道本轮证据是否降级，改动最小、收益明确
6. **补齐内容缺口**（第 3.2 节）—— 追加资料或补同义词
7. **参数调优**（服务空闲时单参数扫描）：
   ```bash
   npm run tune:labor-kb -- --only=blend      # 重排融合权重
   npm run tune:labor-kb -- --only=pool       # 重排池大小
   npm run tune:labor-kb -- --only=minrerank  # 阈值
   ```
   当前阈值 0.05 的依据：误杀相关仅 2 条、滤掉不相关 20 条、相关保留率 97.4%
8. **评估思考档位的真实收益**（第 3.3 节末项）：`max` 档比 `high` 慢 4 倍、思考长 7 倍，**但回答质量是否更好没有评测**。若收益不明显，默认档位应回到 `high`
9. **embedding 模型质量 A/B**（如果要评估 Qwen3-Embedding-4B）：
   用 `evaluate:labor-kb-precision` + 判定缓存量化对比，**不要靠 MTEB 榜单推断**

### P2｜体验优化

10. **生成侧提速**（现在绝大部分时间在这里，且深度思考档已到 168s）：评估「深度思考档改用 `high`」或「减少注入材料量」，见第 3.3 节最后一项——**先确认 max 档是否真的换来质量提升，再决定要不要付这个延迟**
11. **检索侧**：合同知识库两路对用工咨询只是次要信号，可设总预算或改为可选；缓存查询向量
12. **产品矩阵扩展**（`docs/prd.md` 规划的另外几个用工工具：劳动合同分析、劳动仲裁答辩、员工手册诊断、医疗期计算）

### 已知但暂不处理

- `npm run lint` 不可用（ESLint 9 但缺 `eslint.config.*`，既有配置缺口）
- `npm run test:word-annotations` 失败：需 LibreOffice 解析旧版 `.doc` 批注，本机未装（`spawn libreoffice ENOENT`）。**与用工咨询改动无关**（`file-parser.js` 未被触碰，`.doc` 正文转换单独验证正常）

---

## 5. 快速上手

### 5.1 启动

```bash
# 0. Qdrant（合同知识库向量库，首次需启动 Docker Desktop）
docker compose -f docker-compose.rag.yml up -d
curl -s http://127.0.0.1:6333/collections        # 期望 HTTP 200

# 1. 后端 8789
npm run server

# 2. 前端（本项目通常是 5174，不是 5173——5173 可能是别的项目）
npm run dev
```

打开 `http://localhost:5174/labor-consult`。

### 5.2 常用命令

```bash
# 数据
npm run import:labor-books <资料目录>          # 导入实务资料（幂等）
npm run import:labor-books -- --list           # 查看问答库状态
npm run import:labor-books -- --dump "关键词"   # 检索验证
npm run import:labor-cases                     # 导入典型案例
npm run verify:laws                            # 法规白名单核对清单
npm run build:labor-embeddings                 # 构建/增量更新向量索引
npm run build:labor-embeddings -- --status     # 只看状态

# 评测 / 回归
npm run test:labor-consult                     # 回归 50 项（不调模型）
npm run evaluate:labor-kb                      # 召回率（确定性，可用 --sample N 采样）
npm run evaluate:labor-kb-precision            # 准确率（LLM 判定，有缓存）
npm run tune:labor-kb                          # 参数扫描
```

**改代码前先跑回归**：`test:labor-consult` + `test:consolidation` + `test:concurrency` + `npm run build`。

### 5.3 文件地图

**服务端**

| 文件 | 职责 |
| --- | --- |
| `server/routes/labor-consult.js` | 全部接口 + 三路并行检索编排 + 降级告警 + 中文降级标签 |
| `server/prompts/labor-consult.js` | 系统提示词 + 时效基准注入 + 证据装配 |
| `server/services/labor-kb.js` | 混合检索主流程（词法+语义+RRF+重排+阈值） |
| `server/services/labor-vector.js` | 向量索引（BLOB + 暴力余弦；**按模型名为键**） |
| `server/services/siliconflow-client.js` | 硅基流动客户端（重试/总预算/降级遥测） |
| `server/services/knowledge-base.js` | 合同知识库检索 + `getEvidenceRetrievalHealth()` |
| `server/services/vector-store.js` | Qdrant 客户端（探活/超时/embedding 重试/进度） |
| `server/services/evidence-reranker.js` | 合同侧重排 + health 计数 |
| `server/services/labor-book-parser.js` | 五册资料解析器 |
| `server/services/law-whitelist.js` | 法规白名单 + 案例库（同一个 `labor.db`） |
| `server/services/citation-verifier.js` | 引用抽取与校验 |
| `server/services/cjk-tokenizer.js` | 中文 2-gram 分词 + 词典 + 同义词扩展 + 关键词抽取 |
| `server/services/query-rewriter.js` | **追问检索词改写**（LLM 改写 + 输出清洗校验 + 失败分类） |
| `server/services/consult-material-store.js` | **会话材料存储**（附件正文按会话归档，追问轮复用；TTL + 总量上限） |
| `server/services/llm-client.js` | DeepSeek 客户端（**带总预算超时**、思考档位解析、流式诊断日志） |

**数据**

| 路径 | 内容 |
| --- | --- |
| `server/knowledge-base/labor.db` | 法规白名单 + 案例 + 764 条问答 + 向量（18MB） |
| `server/knowledge-base/templates.db` | 合同知识库（9.8MB，中文分词仍是坏的） |
| Qdrant `contract_knowledge_evidence` | 合同证据向量（2057 点） |
| 内存（进程内） | 会话材料（TTL 2h）· 合同审查会话（TTL 2h）· 向量索引缓存（随 `data_version` 失效） |

**前端**

| 文件 | 职责 |
| --- | --- |
| `src/pages/LaborConsultPage.jsx` / `.css` | 咨询页（含 `ReasoningPanel` 思考折叠面板） |
| `src/utils/file-selection.js` | **附件选择共享逻辑**（三个工作台共用，含格式白名单） |

### 5.4 环境变量（`.env.local`，已 Git 忽略）

| 键 | 当前值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_FLASH_MODEL` | `deepseek-flash` | **两档统一用它**。曾写别名 `deepseek-v4-flash`（能用但未文档化），已改官方名 |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | 现仅合同链路使用（4 个 agent + 合同审查/起草） |
| `LABOR_MAX_TOKENS` | 默认 393216 | 输出上限，**必须是 API 最大值**：思考与正文共用该预算，给少了 max 档会没正文（见 2.13） |
| `LABOR_QUERY_REWRITE` | 默认开 | 设 `off` 关闭追问改写（省 0.4~1.3s，代价见 2.15） |
| `LABOR_FOLLOWUP_QUERY_MAX_CHARS` | 默认 20 | 启发式回退路径的短提问阈值 |
| `DEEPSEEK_CHAT_TIMEOUT_MS` | 默认 60000 | 非流式（改写）总预算 |
| `DEEPSEEK_STREAM_TIMEOUT_MS` | 默认 1800000 | 流式总预算，只兜住"永久挂起" |
| `RAG_EMBEDDING_MODEL` | `Pro/BAAI/bge-m3` | **改了这个必须重建 labor 向量索引** |
| `RAG_RERANKER_MODEL` | `BAAI/bge-reranker-v2-m3` | 免费档实测干净，无需 Pro |
| `RAG_VECTOR_URL` | `http://127.0.0.1:6333` | Qdrant |
| `RAG_VECTOR_COLLECTION` | `contract_knowledge_evidence` | |
| `RAG_VECTOR_REBUILD_ON_IMPORT` | `false` | 见 2.9 的警告 |
| `RAG_EMBEDDING_TIMEOUT_MS` | 默认 120000 | 批量灌库预算（可覆盖） |
| `RAG_EMBEDDING_BATCH_SIZE` | 默认 32 | |
| `RAG_EMBEDDING_MAX_RETRIES` | 默认 3 | |
| `SILICONFLOW_TOTAL_TIMEOUT_MS` | 默认 = `SILICONFLOW_TIMEOUT_MS`(30s) | 一次逻辑请求的总预算 |
| `SILICONFLOW_MIN_ATTEMPT_MS` | 默认 500 | 剩余预算低于此值不再重试 |

### 5.5 文档

| 文档 | 内容 |
| --- | --- |
| `docs/用工咨询功能方案.md` | **本功能主文档**（十五节：数据源调研、实现记录、评测报告、检索策略、混合检索与性能修复） |
| `docs/知识库优化方案.md` | 合同知识库（`templates.db`）的诊断与优化方案（**尚未实施**） |
| `docs/prd.md` | 产品需求（含邀请码注册、异步任务、产品矩阵规划） |

---

## 6. 绝对不要再踩的坑

### 6.1 法律事实（会直接导致编造法条）

1. **延迟退休是 2025-01-01 施行，不是 2026-01-01**（已生效）。男职工与原55周岁女职工每 4 个月延迟 1 个月；原50周岁女职工每 2 个月延迟 1 个月；最低缴费年限自 2030-01-01 起由 15 年逐步提至 20 年。
2. **《劳动合同法》不存在"2025 年修订版"**。现行为 2012 年修正、2013-07-01 施行。
3. **《职工带薪年休假条例》从未废止，也没有"2019 年版"**（国务院令第514号，2008-01-01 施行）。
4. **不要用 `flk.npc.gov.cn`（国家法律法规数据库）做自动化采集**。它的 `robots.txt` 明确 `Disallow: /` 并注明"禁止使用任何自动化工具、脚本、爬虫程序采集或复制网站数据"。人工网页查询可以，程序调用不可以。**此前一度推荐过它，那是错的，已撤回。**
5. 提示词里不要写「用搜索工具验证法规」——本项目 LLM 层没有 Function Calling，这是**空指令**。

### 6.2 检索工程

6. **FTS5 的 `unicode61` 不切分中文**。连续汉字串被当成一个 token，`MATCH '"付款"'` 在包含"付款"的文本上命中 **0 条**。新表必须用 2-gram（`cjk-tokenizer.js` 的 `toIndexText`/`toQueryTerm`）。合同知识库（`templates.db`）**仍是坏的，尚未修**。
7. **关键词兜底不能对整句滑窗**。会产生「等特殊工」「条件下的」这类碎片词，作为 OR 条件稀释有效术语。只在词典未覆盖区间取片段，并过滤首尾功能字与虚词。
8. **同义词表的「键」必须并入匹配词表**。否则用户说的「竞争对手」「取证」「业绩」既匹配不上词典，也就永远触发不了同义词扩展。
9. **打分要大小写不敏感**。标题写 `Offer`、用户写 `offer`，区分大小写会直接漏掉。
10. **英文与数字也是有效检索词**（Offer、N+1、2N）。早期只抽中文，导致「offer发出后反悔要赔多少」抽不出任何检索词、**返回 0 条结果**。
11. **同义词扩展词要低权重**（0.45 < 字面 1.0）。等权会稀释字面匹配精度（实测标题召回从 89.7% 掉到 87.4%）。
12. **⭐ 调参必须在生产候选池规模下验证**。曾用 30 条候选（对应 FTS 池 180 条）做离线调参，测出"章节路径+标题覆盖率"能提升 1.8pt，应用到生产后**反而降低指标**——因为生产是 `limit×6=36` 条，排序信号的效力随候选池大小变化。**这是踩过的坑。**
13. **阈值要基于重排「原始分」而非归一化分**。归一化分是池内相对的（每轮最低者恒为 0），不能跨查询比较。

### 6.3 性能与外部依赖

14. **所有外部 `fetch` 必须加超时**。项目里曾有 5 处裸 `fetch`（`vector-store.js` 4 处 + `evidence-reranker.js` 1 处）导致单路径阻塞 **120 秒**。
15. **⭐ 超时 ≠ 总预算**。`AbortController` 若建在重试循环**体内**，每次重试都是一个新的超时窗口，真实上界是 `MAX_RETRIES × 单次超时 + 退避`。必须传 deadline，每次尝试取 `min(单次上限, 剩余预算)`，预算不足即放弃。
16. **调外部 API 前先探活**。`searchVectorEvidence` 原本"先 embedding 再查 Qdrant"，Qdrant 没部署时 embedding 白做一遍并丢弃。**先探活，不可达直接跳过。**
17. **不要在服务运行时跑大量并发外部调用**。曾用参数扫描（约 1500 次请求）把 SiliconFlow 打出 500，进而触发上面的无限等待。调参放服务空闲时，一次一个参数。
18. **互不依赖的检索路径要并行**（`Promise.allSettled`），串行会让耗时相加。
19. **⭐ 修了外层并行 ≠ 修了内层并行**。`retrieveLaborEvidence` 外层被并行化了，内部两次 `await searchEvidence` 仍串行（986ms）。**改并行时要往下多看一层。**
20. **⭐ 批量灌库不能复用检索热路径的超时**。`VECTOR_TIMEOUT_MS = 8s` 对单条查询很宽裕，对"32 条条款全文一批"根本不够，直接 AbortError。批量路径需要独立且宽松得多的预算。
21. **⭐ 批量外部调用必须有重试**。`vector-store.js` 的 `embedTexts` 曾**完全没有重试**——65 批里一批慢就前功尽弃。实测 4/65 触发重试。
22. **分钟级操作要报进度**，否则看起来像卡死。
23. **⭐ `llm-client.js` 的 `deepseekFetch` 也曾经没有超时**（裸 `fetch`，无 `AbortController`）。在检索路径上插入一次 LLM 调用后，这个洞会变成"改写挂住 → 整轮咨询卡死"。补超时时注意：**流式生成可以合法跑 168 秒**，所以非流式与流式必须用不同预算（60s vs 30min），且定时器要活到**流读取结束**才释放。

### 6.4 降级必须可见（项目吃过两次亏）

24. 此前向量检索 `fetch failed`、重排器 429 **都只打一行 `console.warn` 就静默回落**，导致"以为在跑混合检索、实际是坏掉的单路词法"持续数月无人察觉。
25. 强制三件事：**降级计入 `health` 计数器**、**结构化 warn 并区分原因**（`rate_limit`/`network`/`auth`/`server`/`qdrant_unreachable`…）、**检索结果带 `retrieval` 元信息且降级写入用户可见的 `warnings`**。新增任何外部依赖必须沿用这套机制。
26. **⭐ 异常在模块内部被吞掉 = 接口层永远不知道**。`searchEvidence` 内部 catch 了向量异常所以从不 reject，导致上层 `warnings` 一条都不出现，**这条路径 100% 降级却完全不可见**。降级要么向上传递，要么写进返回值的元信息。
27. **⭐ `enabled: true` / `hybrid-ready` 是配置层判断，不代表服务在跑**。`getVectorStatus().enabled` 只看 URL/key 是否有值。配置齐全但服务缺席时，只看这个字段就会以为向量路健康。**必须探活。**
28. **降级原因要给用户看人话**。`qdrant_unreachable` 这类内部标记推到前端对用户没有意义，但要可见——翻译成「向量库未部署或不可达」。

### 6.5 向量存储与模型

29. **⭐ 项目里有套互不相干的向量存储，别混淆**：
    - **Qdrant**（`contract_knowledge_evidence`）—— 服务**合同知识库** `templates.db`，需要外部服务
    - **`labor.db` 内嵌向量**（BLOB + 暴力余弦）—— 服务**用工咨询实务问答**，不依赖任何外部服务

    「向量库未部署」只对合同侧成立；用工咨询的语义召回是独立的、一直是好的。**降级警告文案里必须写清是哪一路。**
30. **⭐ `labor-vector.js` 按模型名字符串作为向量的键**（`WHERE model = ?`）。改了 `RAG_EMBEDDING_MODEL` 而不重建索引 → 查询 0 行 → `index_empty` → 语义召回静默降级。**改模型名后必须 `npm run build:labor-embeddings`。**
31. **⭐ 免费共享档模型会排队，这是真问题**。`BAAI/bge-m3` 免费档实测 30 次请求出现 1 次 120.1s + 1 次 HTTP 500（约 7% 异常率）。**重试是必需而非可选。** 切 `Pro/` 档后 max 1.2s、零错误。
32. **同档位不同模型的排队行为不同**：免费档重排器 25 次 max 0.72s 完全干净，而免费档 embedding 会排队。**不要因为一个模型排队就断定整个免费档不可用**，逐个测。
33. **`Pro/X` 与 `X` 是同权重的不同服务档**，实测同文本向量余弦相似度 1.000000。但**不要靠"改标签"绕过索引重建**——重建才 19.2s。
34. **不要用 `npm run import:templates` 做向量同步** —— 它会 `resetKnowledgeBase()` 全量重建，源目录不完整就丢数据。用定向同步 `syncVectorIndex(listIndexableEvidence(), { rebuild: true })`。
35. **Qdrant collection 存在但为空时不会告警**（`used:true, count:0`）。失败模式仍安全（不存在时查询 404 → 正确标降级），但要知道这个盲区。
36. **⭐ 进程内缓存必须能被其它进程失效**。`loadIndex()` 曾把**空索引**也永久缓存，而 `build:labor-embeddings` 是独立进程——于是"服务器跑着 → 你重建索引 → 警告不消失"极易被误判为"重建没生效"。现用 `PRAGMA data_version` 失效（只在**其它连接**提交后变化；同连接写入需显式 `resetIndexCache()`）。**任何进程内缓存都要问一句：别的进程改了数据，我怎么知道？**
37. **⭐ 索引加载失败的原因要分场景**。「从没建过」（`index_empty`）与「模型名对不上」（`model_mismatch`）处置动作完全不同，报同一条消息等于没有诊断信息。
38. **⭐ 状态查询要同时给"配置值"和"实际值"**。只返回配置的模型名，模型不匹配时仅表现为 `embedded=0`，看不出原因。`storedModels` + `modelMismatch` 才是可行动的。
39. **⭐ 变长数据做步长时必须校验一致性**。`loadIndex()` 用 `rows[0].dim` 当所有行的步长：`row.dim > dim` 会**越界写入甚至抛 RangeError**，`row.dim < dim` 留下空洞让相似度恒为 0 → **静默的错误排序**。这类"看似正常实则错误"比拒绝服务危险得多，**宁可拒绝加载**。
40. **归一化要无条件、不能靠调用方约定**。`saveEmbedding` 曾写成"Float32Array 就跳过归一化"，隐含"传入的必然已归一化"这一无保证的假设；而检索端用的是点积，一旦假设破裂就是相似度被缩放、排序静默失真。

### 6.5b 生成与推理参数（第四轮新增）

41. **⭐ `max_tokens` 与思考（reasoning）共用预算**。`reasoning_effort` 越高，思考越长，而它和正文抢同一个上限。实测 `max` 档 + 8192 上限 → 思考 1.3~2.0 万字后 `finish=length`，**正文 0 字，连续三次全失败**。输出上限必须给足（API 允许的最大值 393216）；`max_tokens` 是**上限而非目标**，只按实际生成量计费，给足不增加成本。
42. **⭐ 思考内容绝不能并入正文**。`verifyOutput` 只应校验正文：思考里出现的法条常是模型自我排除的候选（甚至是被否定的错误版本），混进去会产生大量假的"未收录"告警。SSE 也必须分成 `consult.reasoning` / `consult.delta` 两路。
43. **⭐ 模型名要用官方名，不要用别名**。`deepseek-v4-flash` 传了也返回 200，但响应里是 `deepseek-flash`，且 API 报错只列 `deepseek-flash, deepseek-v4-pro`。别名随时可能失效。
44. **上下文窗口与输出上限是两个独立限制**，且 API 会校验 `messages + completion ≤ 窗口`（实测窗口 1,048,576 tokens，`max_tokens` 合法区间 `[1, 393216]`）。这两个数字都可以让 API 自己报出来——传一个越界值读报错信息即可，不必翻文档。

### 6.5c 多轮与前端状态（第四轮新增）

45. **⭐ 检索必须理解多轮语境**。`retrievalQuery` 只用本轮 `message` 时，追问「那这种情况怎么办」会被抽成 **`况怎么办`** 这类碎片词，召回与上文完全无关的条目——"证据驱动"在多轮下直接失效。靠**长度阈值**的启发式有明确失效边界（长句纯指代识别不了），真正的解法是 LLM 改写。
46. **⭐ 附件正文不会自动进入多轮记忆**。前端只存 `{name, size}`，正文从不进 message，下一轮 `files` 为空 → **模型看不见第一轮上传的合同**。要按会话归档到服务端（`consult-material-store.js`），而不是塞进 `history`（正文数万字，会随每轮重复上传，塞前端还会撑爆 localStorage）。
47. **⭐ `setFiles(本次选择)` 是整体替换，不是追加**。用户分几次选文件时上一次的会被丢掉，表现出来就是"只能上传一份"。三个工作台都犯过。**一次框选多份反而是好的，这让问题容易被误判成"数量限制"。**
48. **⭐ 判断扩展名不要用字符串 `includes`**。`ACCEPTED.includes(ext)` 在无扩展名时是 `includes('')`，而**空串是任何字符串的子串 → 恒为 true**，于是无扩展名文件前端放行、后端 400 拒绝。用 `Set` 做精确成员判断。
49. **同一份名单散在多处必然漂移**。格式白名单曾有三份副本（用工咨询页含 `.markdown`、两个合同页不含），尽管 `upload-config.js` 的注释写着"避免两处定义漂移"，前端却从未 import 过它。**注释里的约定不等于代码里的约束。**
50. **localStorage 超限是静默的**。`writeStorage` 的 `catch {}` 会吞掉配额错误——**一旦超限，整个会话历史停止保存且毫无提示**。往后端 message 里加任何大字段（如思考过程）都必须先裁剪。
51. **流式 UI 的自动展开/折叠只能在"首次"触发**。每次数据块都强制展开会顶掉用户的手动收起；每次正文到达都折叠则会打断阅读。**只做一次，之后交给用户。**

### 6.6 数据处理

52. **解析文档时，正文里引用的法条款号（如「（一）…」）不能被当成章节标题**。否则会把答案从中间截断——实测产生过 25 字的残缺条目。**层级取自目录，正文只按问题标记切分。**
53. **目录里存在页码换行的条目，形态与正文一致**。不能用"遇到第一个不带页码的问题行就停"判断目录结尾（第二册因此只解析出 21/218 条）。用"最后一个目录样式问题行之后即正文"。
54. **重复页眉必须剥离**。页眉插在句子中间会把"经济"切成"工经/济也"，**2-gram 索引会直接丢失该词**。要按句末标点修复跨页断句。
55. 案例数据只导入**公开发布且允许引用**的（政府/法院发布的典型案例、指导性案例，或依法公开的裁判文书），导入脚本已内置手机号/身份证号脱敏校验。

### 6.7 合同链路红线（文件未被用工咨询改动触碰，但红线仍然有效）

56. **`notice` 语义不可退化**：原文不需改动时用 `notice` 且 `replacementText` 为空，禁止把 `targetQuote` 原样填入替换文本。模型输出必须先在服务端 `revision-merger` 规范化，不能只在前端用字符串相等判断掩盖。
57. **`nearestQuoteMatch` 的返回 `targetQuote` 可能因定位器上下文与模型入参不同**；识别"原样照抄"应比较模型传入的 `rawEdit.targetQuote` 与 `replacementText`。
58. **`annotation-locator` 对可精确定位的 quote 有至少 6 个规范化字符的安全阈值**。测试片段太短会触发既有 fallback，不代表逻辑失效。
59. **SSE 不得先聚合再返回**。Nginx `proxy_buffering off` + `X-Accel-Buffering: no` 必须保留。
60. **模型输出永远不可信**。任何 Agent 产物进页面/进库前必须过服务端校验——这是项目最重要的工程原则，`annotation-locator` / `finding-consolidator` / `revision-merger` 三个服务不可绕过。

### 6.8 工程纪律

61. **当前目录不是 Git 仓库**。不要假定 `git status`/提交/回滚可用；**不要执行 `git reset --hard`、`git checkout -- .`、`git clean -fd`、`rm -rf` 等破坏性命令**；不要 `git add .` 全量暂存。开工前先把改动同步到真实 clone。
62. **不要删除 `.codegraph/`**。源文件改动后执行 `codegraph sync .`。
63. **⭐ CodeGraph MCP 的默认 project 指向另一个代码库**（DSH checkout，227 文件）。查本项目必须显式传 `projectPath="/Users/ypc/Desktop/归档项目/infimind-react"`（70 文件），否则返回无关文件。
64. **CodeGraph 的 "no covering tests found" 是假阴性**。它对 `searchLaborKb`/`verifyOutput`/`mergeRevisions` 全部标注无覆盖，但 `test-labor-consult.js` 确实 import 了这些生产模块（含 120 处 `assert`）。**别被这个标记误导去补测试，先跑 `npm run test:labor-consult` 看真实结果。**
65. **密钥永不入库入码**。`SILICONFLOW_API_KEY` / `DEEPSEEK_API_KEY` 只放 `.env.local`（已被 Git 忽略）。
66. **改代码前先跑回归**：`npm run test:labor-consult` + `test:consolidation` + `test:concurrency` + `npm run build`。
67. **⭐ 不要在用户正在跑的服务上做验证**。Node 无热重载，改了代码用户那个进程不会生效。用 `LOCAL_SERVER_PORT=8791 node server/index.js` 另起临时实例验证，用完 kill 掉；**不要未经同意 kill 用户的进程**。
68. **国内网络**：Docker Hub 直连不通（`registry-1.docker.io` → 000）。镜像走 `docker.m.daocloud.io`。github.com 也不通。
69. **验证后清理临时文件**。本会话习惯用 `.tmp-*.mjs` 放在项目根（为了相对 import 能解析），用完必须删。

---

## 7. 关键基线（回归对比用）

改动检索相关代码后，用这些数字判断是变好还是变坏：

| 指标 | 基线值 | 复现命令 |
| --- | --- | --- |
| 回归测试 | **72 / 72 通过** | `npm run test:labor-consult` |
| consolidation / concurrency | 通过 | `npm run test:consolidation` / `test:concurrency` |
| 问答库条目 | 764（含案号 268） | `npm run import:labor-books -- --list` |
| 劳动向量索引 | 764 / 764（100%），1024 维，`Pro/BAAI/bge-m3` | `npm run build:labor-embeddings -- --status` |
| Qdrant collection | 2057 points，1024 维，green | `curl -s http://127.0.0.1:6333/collections/contract_knowledge_evidence` |
| 法规白名单 | 19 条（已核对 4 / 待核对 15） | `npm run verify:laws` |
| 典型案例 | 5 条 | `GET /api/labor/status` |
| precision@1 | 66.7% | `npm run evaluate:labor-kb-precision` |
| precision@6 | 33.9% | 同上（看 k=6 行） |
| hitrate@5 | 93.3% | 同上 |
| 标题 Recall@1 | 99.2% | `npm run evaluate:labor-kb -- --sample 120` |
| 内容 Recall@1（严格） | 76.9% | 同上 |
| 检索阶段耗时 | ~2.0s（端到端检索） | 见 5.1 启动后页面实测；SSE `consult.start` 里的 `retrieval.totalMs` |
| 追问改写耗时 | 412~1330ms | 服务端日志 `检索词改写 Nms`；SSE `retrieval.queryRewrite.elapsedMs` |
| 端到端作答耗时 | 快速 ~40s / 深度思考 ~168s | 页面实测；服务端 `Stream done` 日志 |
| 证据条数 | 8~9 条 | 同上（Qdrant 未上线时是 4） |
| 引用核实 | 应无 ❌（除模型引用未收录法规） | 页面右侧「引用核实」面板 |

**各轮修复的对照数字**：

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 合同知识库内层两路 | 986ms（串行） | **533ms**（并行） |
| 单次逻辑请求最坏耗时 | 12800ms | **4813ms**（受总预算约束） |
| 灌库每批耗时 | 8.6s（免费档，4/65 重试） | **0.3s**（Pro 档，0 失败） |
| 降级可见性 | 仅 console.warn，用户零提示 | SSE `warnings` + `/api/labor/status` 计数 |
| 追问检索质量 | 召回与上文**完全无关**的条目 | 全部命中主题（见 2.15） |
| 附件记忆 | 追问轮**丢失**第一轮的合同 | 全程保留（`attachments` 三轮一致） |
| 附件多选 | 分次选择只保留最后一份 | 追加，上限 6 份 |

> 注：召回率的采样评测有抽样误差；准确率评测有模型判定随机性（判定结果已缓存，可用于可比性）。
> **对比同一指标时必须用同一脚本、同一参数、同一缓存状态。**

> ⚠️ 检索耗时从 650~969ms 涨到 ~2.0s **不是退化**——之前那个"快"是因为 Qdrant 探活失败直接跳过、向量路根本没干活。现在它真在做 embedding + 向量查询，并多召回了 5 条证据。

---

## 8. 一句话总结

**功能已完成并可用，检索链路与多轮记忆的硬伤都已修复**：混合检索 + 模型重排让 precision@1 从 50% 提升到 66.7%；
修掉了内层串行（986ms→533ms）、超时总预算（最坏 12800ms→4813ms）、合同侧静默降级（违反项目红线）；
部署了 Qdrant（2057 点）并把 embedding 切到 Pro 档（灌库每批 8.6s→0.3s，异常率 7%→0）。

**第四轮补齐了四处会直接损害可用性的缺陷**：

1. **两档统一 `deepseek-flash`** —— 过程中发现 `max_tokens` 与思考共用预算，8K 上限会让 `max` 档**正文 0 字、100% 失败**，因此输出上限必须给到 API 最大值；
2. **追问检索改写** —— 原先追问「那这种情况怎么办」会被抽成 `况怎么办` 这类碎片词、召回与上文完全无关的条目；接入 LLM 改写后全部命中主题（+0.4~1.3s/轮）；
3. **附件纳入会话记忆** —— 原先追问时模型**看不见第一轮上传的合同**，现已按会话归档复用；
4. **附件多选修复** —— 三个工作台的 `setFiles(本次选择)` 是整体替换，导致"只能上传一份"。

**上线前待办**：人工核对 15 条法规白名单、确认 Pro 档计费、确认五册资料著作权、前端验收（含思考折叠面板与多格式附件）。

**技术上最大的两个遗留**：
- 合同知识库（`templates.db`）的中文分词仍是坏的，尚未修复（`docs/知识库优化方案.md` 有方案）；
- **深度思考档要等 168 秒，但"是否换来了质量提升"没有评测** —— 若收益不明显，默认档位应回到 `high`。
