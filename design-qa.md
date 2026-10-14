# 动态摘要条设计核对

final result: passed

## 证据

- 视觉来源：`/Users/ypc/.codex/generated_images/01a11acc-ee98-7050-b2d8-18d021e375bb/exec-ec977ebe-1312-48be-8eb2-c7781fd65c11.png`，用户选择的第三个方案。
- 实现截图：`/tmp/fafee-reasoning-desktop-final.png`。
- 整体并排比较：`/tmp/fafee-reasoning-comparison-final.png`。
- 组件细节并排比较：`/tmp/fafee-reasoning-detail-comparison.png`。
- 手机浅色／深色：`/tmp/fafee-reasoning-mobile-final.png`、`/tmp/fafee-reasoning-mobile-dark.png`。
- 桌面 CSS 视口 960×640，截图 960×640，devicePixelRatio 1。来源 1536×1024 等比缩小至 960×640 后并排比较。手机 CSS 视口 390×844，截图 390×844。
- 比较状态：上方默认收起、下方展开、分析进行中。临时检查页使用实际 ReasoningSummary 组件及真实品牌／工作区主题 CSS，样例文本只用于 UI 验证。

## 五项检查

- 字体：沿用原生系统字体；桌面标题 14px，手机标题 12px，分析正文 14px／1.8 行高。正文比正式回答弱一级，长片段单行省略。没有把概念图中的展示说明写入正式页面。
- 布局：44px 高的摘要条、10px 圆角、图标及标题细分隔；展开内容直接放在页面，用左侧细线区分。正文独立滚动，上限 260px。390px 视口未出现横向溢出。
- 配色：使用项目暖白／暖灰／品牌橙变量；深色模式自动使用同一组工作区主题变量，文字及分隔线可辨认。
- 图像与图标：概念中没有独立位图资产。使用现有 Lucide PenLine 和 ChevronDown，保持矢量清晰度；没有手工 SVG 或绘制图标。
- 文案：进行中为“正在分析”，静止为“分析记录”。片段直接摘取实际分析内容，不使用概念图中的固定摘要或伪造完成状态。

## 比较历史

- 第一次细节对照发现图标与标题之间少一个分隔、标题较小且图标呼吸透明度过低。已补充细分隔，标题调至 14px，呼吸最低透明度调至 0.65。
- 修改后再次捕获、并排查看完整视图及组件细节。没有剩余可执行的 P0/P1/P2 设计问题。
- 有意保留：组件比概念图略紧凑；示例用户消息继续遵循本项目右侧对齐；摘录文字来自实际内容；完成后的图标降为次要色。概念图中的两份交互状态仅用于检查，不复制到正式会话。

## 交互验证

- Enter 展开、Space 收起；底部收起按钮把焦点返回摘要条。
- 收起时没有分析正文 DOM。41,400 字的进行中分析只渲染尾部 20,000 字及提示，高度 260px。
- 用户按 Home 向上阅读后，新流式片段到达仍保持 scrollTop 0；摘录随实际片段更新。
- 停止流式后能回看完整文本，标签变为“分析记录”，呼吸动画清理。
- 中文／English、浅色／深色切换通过；简洁展示隐藏组件。
- 组件检查页控制台没有 error 或 warn。
- npm run build 通过；新组件 ESLint 无错误／警告；原咨询页仍有 3 个已有警告。

## 适用范围

本次验证覆盖组件渲染和浏览器交互，未发起收费模型请求。正式页已接入同一组件，现有流式缓冲、任务接口、历史保存逻辑继续使用。标准展示默认收起；详细展示仍按用户设置展开。回答首次开始后收起一次，之后尊重手动展开。

## 实施清单

- [x] 替换原思考过程组件及样式
- [x] 保留长文本限量渲染、rAF 滚动及手动阅读行为
- [x] 接入主题、语言及展示偏好
- [x] 完成键盘、流式、长文本、手机与视觉对照
- [x] 构建通过

## 后续微调

无阻断项。真实模型的文字片段可能比示例更长，摘要条使用单行省略；完整内容通过展开查看。

---

# 侧栏图标与上下文用量面板核对

final result: passed

## 变更
- 侧栏（`src/components/WorkspaceLayout.jsx` 的 `tools` 数组，由 `WorkspaceToolRail` 渲染）前五个工具图标改为按“功能动作”选，避免四个“文件 + 小标记”图标在 20px 下难以区分：
  - 用工咨询 `MessageCircle` → `MessagesSquare`（多轮咨询问答）
  - 商业合同审查 `FileSearch` → `ScanSearch`（逐条排查风险）
  - 商业合同起草 `FilePenLine` 保留（文件 + 笔，五个里最有辨识度）
  - 劳动合同分析 `FileCheck2` → `ClipboardCheck`（要素完整性核对清单）
  - 劳动仲裁答辩 `Gavel` → `Scale`（争议裁决；与站点其它入口的仲裁图标一致）
- 上下文用量面板改为 `infimind-react-main` 版本：`src/components/ToolComposerControls.jsx` 的 `ContextUsage`（环形 + 状态词「充足／渐满／接近上限」+ 悬停/点击浮层）及 `src/components/ToolComposerControls.css` 的 `.tool-context*` 样式块；`src/components/workspace-language.js` 补 9 条对应英文词条。其余逻辑不变。

## 证据
- 侧栏图标：`design-qa-assets/sidebar-icons.png`（视口 1500×950，devicePixelRatio 2，裁剪 150×420）。
- 上下文用量浮层：`design-qa-assets/context-usage-panel.png`（同上视口，裁剪 420×210）。
- 浏览器断言（系统 Chrome，API 全拦截）：侧栏 SVG 类名为 `lucide-messages-square`／`lucide-scan-search`／`lucide-file-pen-line`／`lucide-clipboard-check`／`lucide-scale`，旧 `lucide-gavel`／`lucide-file-search`／`lucide-file-check-2` 均已不存在；面板触发器文案 ∈ {充足, 渐满, 接近上限}，悬停后浮层出现 `.tool-context-illustration` 与「会话空间…」标题。
- `npx vite build` 隔离输出目录通过（2343 modules，仓库 `index.html` 未改动）；`npx eslint .` 0 errors（警告数与基线一致）。

## 未做的部分
- 站点首页 `ProductSection.jsx`、顶部 `Header.jsx` 的同类图标未改（本次只改侧栏）。
- 面板的百分比数值不再显示（main 版只给状态词与环形）；如需百分比需另行确认。

## 补充：侧栏悬停小卡片（同一批次）
- 问题：悬停卡片**一直存在但被会话面板盖住**，用户实际看不到。根因是排序动画（gsap）会给每个图标写入 `transform`，`transform` 使图标自身成为层叠上下文，卡片上的 `z-index: 60` 无法越过同级后续面板。截图证据：`design-qa-assets/sidebar-tooltip-card.png`（修复后）。
- 修复：`src/components/WorkspaceLayout.css` 中 `:hover`／`:focus-visible` 时把整个图标抬到 `z-index: 65`（拖拽中的图标是 70，不受影响）；卡片改为应用统一的小卡片形态（圆角 12、`--fafee-surface` 底、边框、轻投影、12.5px 中粗标题），副行「拖动排序」降为 10.5px 的浅色小字；补 `prefers-reduced-motion` 关闭过渡。
- 覆盖范围：工具导航五项 + 返回官网 + 账户 + 更多功能 + 历史会话开关（均使用 `.app-workspace-icon`）。
- 浏览器断言：五个功能的悬停卡片逐个可见且文字为对应功能名；键盘聚焦同样弹出；`返回官网`／`账户` 卡片可见。
- 说明：卡片保留了「拖动排序」副行用于发现排序能力；如只要功能名可去掉该行。

## 补充：搜索栏统一 & 商业合同审查移除「更多」
### 搜索栏统一
- 新增 `src/components/SidebarSearch.jsx`：统一放大镜图标（原来是 `History` 时钟箭头，语义偏“历史”而非“搜索”）、输入框结构、快捷键提示写法（跟随 `settings.shortcuts.search`，关闭时整块不显示）。
- 替换 7 处调用：`LaborConsultPage`、`ContractRewritePage`、`ContractDraftPage`、`LaborContractAnalysisPage`、`LaborArbitrationPage`、`HandbookDiagnosisPage`、`ToolConversationPage`；各页删除未再使用的 `History` 导入，`LaborContractAnalysisPage` 顺带删掉只为旧提示服务的 `searchShortcutLabel`。
- 文案按功能微调：搜索历史咨询／审查／草稿／分析／案件／诊断／会话；语言包补 5 条英文词条（含此前缺失的「搜索历史诊断」）。
- 证据：`design-qa-assets/sidebar-search-review.png`、`design-qa-assets/sidebar-search-consult.png`。浏览器断言：7 条路由的占位文案、`svg.lucide-search` 存在且 `svg.lucide-history` 为 0、`kbd` 统一为「⌘ / Ctrl K」；`Ctrl+K` 仍能聚焦搜索框（`WorkspaceLayout` 的 `.sidebar-search input` 选择器未受影响的验证）。

### 商业合同审查移除输入器「更多」
- 移除 `ContractRewritePage` 输入器内的「更多」按钮（`ToolComposerControls` 不再传 children，改为自闭合）。
- 该按钮是「新审查任务」弹窗的**唯一入口**，故一并移除弹窗、`createTask` 与 `taskModalOpen/taskTitle/taskPrompt` 状态及 `Menu` 图标导入，避免留下不可达死 UI。
- 影响：不再有命名任务表单；历史任务列表与直接发送开始审查的路径不变。
- 证据：`design-qa-assets/composer-without-more.png`（`+` / 深度思考 / 上下文环）。
- 构建 2344 modules 通过、`index.html` 未改动、`npx eslint .` 0 errors（104 warnings 与基线一致）。

---

# 批注稿人工编辑与「最终确认意见」导出核对

final result: passed

## 变更
- 商业合同审查与劳动合同分析的批注稿：每条批注（编号就近批注卡 + 新增/删除/修订紧凑卡）都可就地改写「处理方式 / 建议文字 / 批注说明 / 完整条款建议」，改后标「已人工修改」，可单条「恢复 AI 原稿」或标题栏「已人工修改 N 条 · 全部恢复」。
- 编辑只覆盖意见字段，`lineStart`/`quoteSpans` 等服务端定位数据不变；页面渲染、复制、「下载 Word」共用 `buildDisplayRevisions(revisions, annotationEdits)`，复制与下载导出的都是最后确认的版本。服务端批注 ID 是位置序号，同一任务重跑可能换条款，因此每条编辑记录写入时的锚点指纹（处理方式+行号+原片段），锚点对不上就丢弃，标题栏计数只算仍然生效的编辑。
- 新增 `src/utils/revision-annotations.js`（纯函数：编辑表校验、展示派生、批注挂行/高亮合并、纯文本批注稿）；`ContractRewritePage.jsx` 的文档头「复制」由复制原文改为复制含最终意见的批注稿，标题与提示说明同步改写；劳动合同分析的编辑按报告任务 ID 存浏览器本地存储，不写回服务端任务结果，删除会话时同步清理。

## 证据
- 编辑表单：`design-qa-assets/annotation-edit-form.png`（处理方式下拉、建议修改为、批注说明、完整条款建议、只读原片段、保存批注/取消）。
- 改后状态：`design-qa-assets/annotation-edit-saved.png`（商业审查：卡片标「已人工修改 · 编辑 · 恢复 AI 原稿」，标题栏「已人工修改 1 条 · 全部恢复」，汇总条说明复制/下载取改后意见）、`design-qa-assets/annotation-edit-labor-saved.png`（劳动合同分析同样形态）。
- 恢复后状态：`design-qa-assets/annotation-edit-commercial.png`、`design-qa-assets/annotation-edit-labor.png`。
- 浏览器断言（系统 Chrome，`/api/**` 全拦截，虚构合同）：两条批注都出现「编辑」；保存后卡片文字与「已人工修改」标记同时变化；复制内容含「三十个自然日内付款（财务已确认）」与「其中 1 条已人工修改」，下载的 `.doc` 同样含改后文字、含「完整条款建议」且不含模型原文；同一会话重跑后位置序号相同但条款不同时，旧意见在卡片、标题栏计数与复制文本里都失效；刷新后编辑仍在；「恢复 AI 原稿」与「全部恢复」回到模型意见；劳动合同分析同样通过（含按任务 ID 的本地存储还原）；同一份原文重跑分析出的新报告（相同位置序号批注 ID）不会带出上一版的人工意见；用户输入的 `**加粗** <b>标签</b> & "引号"` 在 `.doc` 里被转义（`&`/`<` → 实体），不会变成真标签；390px 视口仍能打开编辑表单且无横向溢出。
- 纯函数回归 `npm run test:annotation-edits` 10 个场景：编辑只覆盖展示字段、定位数据不变、编号稳定、无 `findingId` 时按展示序号兜底且互不覆盖、复制文本取最终意见、非法持久化数据被丢弃。
- `npx eslint .` 0 errors（104 warnings 与基线一致）；`npx vite build` 隔离输出目录通过（2345 modules，比上一批多 1 个新 util；仓库 `index.html` 哈希未变）。

## 复查中发现并修复
- 劳动合同分析的编辑表是「任务 ID → 批注 ID → 补丁」两层结构，最初按单层 patch 解析，导致刷新后人工意见全部丢失。补 `normalizeAnnotationEditStore` 与对应纯函数场景；浏览器回归的「刷新后编辑仍在」断言先捕获到该缺陷。
- 编辑分桶键最初取 `result.sourceTaskId`（原文所属任务）。重跑分析（`reanalyze`/`restart-analysis`）会复用同一个 `sourceTaskId`，而劳动合同批注 ID 是位置序号（`finding-N-local-M`），上一版的人工意见会被套到新报告位置相同的另一条批注上。改为按「产出批注的报告任务 ID」分桶后修复；浏览器回归用「同一原文、同序号、不同意见」的第二份报告锁定该行为（改回旧键会失败）。
- 分桶键写成 `reportViewTask.id` 时未加空值保护，报告面板未打开会导致整页渲染崩溃（ErrorBoundary）。已改为 `reportViewTask?.id || ''`。
- 独立复查（Playwright 实跑，非本次会话）指出：按任务分桶只解决「新任务」这一种重跑；同一任务/消息重新落一份结果（`applyRecoveredTask`、恢复订阅、失败重试）时，位置序号批注 ID 不变而条款可能已变，旧人工意见仍会被当成新条款的最终意见导出。已按复查建议补锚点指纹校验：`annotationTargetOf`（处理方式+行号+插入锚点+原片段）随编辑一起存，渲染时不一致就丢弃该补丁；旧的无指纹记录仍按原样生效，不因升级丢已保存意见。同时把 Word 导出的「完整条款建议」判定与卡片/复制统一（原判定只在 `finding-fallback`/`handbook-notice` 时输出，人工改过的整条建议会在 `.doc` 里静默丢失），并把 `anchorText` 也走转义。
- 复查提出的「空保存产生幽灵编辑」经核对为可接受行为：表单逐字段与当前值比较，模型值为空时清空不会写入补丁；清空非空字段本身就是编辑意图（卡片会退回通用兜底文案），因此保留「已人工修改」标记。

## 未做的部分
- 员工手册诊断批注稿（`HandbookAnnotatedDocument`）复用同组件但未接线编辑，保持只读；本次范围只含商业合同审查与劳动合同分析。
- 劳动合同分析的编辑保存在本浏览器（按报告任务 ID），不写回服务端任务结果，因此换设备或换浏览器看不到人工修改；如需跨端一致要在任务库上加保存接口，属接口改动需另行确认。
- 复制按钮不再单独提供「复制原文」；无批注时仍逐字复制原文。
