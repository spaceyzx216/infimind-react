import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitLawCitations } from '../utils/law-citations.js'
import './MarkdownBody.css'

/**
 * 备忘化的 Markdown 正文渲染。
 *
 * 为什么必须 `React.memo` 而不是直接写 `<ReactMarkdown>`：
 * Markdown 解析是"解析整篇"，且开销随正文长度线性增长。流式期间每来一块增量
 * 都会触发一次页面级重渲染，若正文内联在页面里，**全部历史消息**都会被重新解析一遍 ——
 * 一轮问答下来就是 O(消息数 × 提交次数 × 文本长度) 的解析量。
 *
 * 实测（性能压测：`node perf/render-pressure.mjs`）：合同审查链路接入节流前
 * 每 3,800 个流式事件产生 3,707 次提交，脚本执行累计 2.3 秒，其中绝大多数耗在
 * 反复重解析未变动的正文上。按 `content` 比较后，只有真正在流式增长的那一条消息
 * 会重新解析，历史消息的解析开销降为 0。
 *
 * 与页面解耦成独立组件，是为了让「用工咨询 / 合同审查 / 合同起草」三个工作台
 * 共用同一份实现 —— 此前只有用工咨询页做了这层备忘化，另外两个页面因此成为
 * 渲染荷载的主要来源。
 *
 * 注意：组件只渲染 Markdown 本身，**不额外包一层容器**。调用方各自的外层
 * 容器（`.assistant-content`、`.labor-answer`、`.draft-markdown`）及其样式
 * 依赖现有 DOM 结构，这里不能改变层级。
 */

/**
 * 把法规引用包成 `<lawcite>`，由 components 映射渲染为标红元素。
 *
 * 为什么用"渲染时标记"而不是"生成结束后改写文本"：
 *  - 它是声明式的——标红结果永远等于当前文本的识别结果，流式期间文本每增长一次
 *    就重新计算一次，**不存在"标记与实际文本不同步"的状态**；
 *  - 也因此不需要在流式过程中做增量 DOM 手术（那才是风险与工程量所在）；
 *  - 历史消息（从本地存储读回来的）走的是同一条渲染路径，自动获得同样的标红，
 *    不必额外回填。
 *
 * 实现上是遍历 HAST 的**文本节点**：记法符号（`**`、`#`）在解析阶段已被剥离，
 * 拿整篇原文的下标去映射渲染结果会错位；而法规引用是连续纯文本，
 * 单个文本节点内必然完整。
 */
function markLawCitations(node) {
  if (!node || !Array.isArray(node.children)) return
  const next = []
  for (const child of node.children) {
    if (child.type === 'text') {
      const parts = splitLawCitations(child.value)
      if (!parts) {
        next.push(child)
        continue
      }
      for (const part of parts) {
        next.push(part.isCitation
          ? {
            type: 'element',
            tagName: 'lawcite',
            properties: {},
            children: [{ type: 'text', value: part.text }]
          }
          : { type: 'text', value: part.text })
      }
      continue
    }
    // 元素节点继续向下遍历；文本之外的类型（注释等）原样保留
    markLawCitations(child)
    next.push(child)
  }
  node.children = next
}

/** rehype 插件：在 HAST 上做一次纯结构变换，不引入任何新依赖 */
const rehypeLawCitations = () => (tree) => { markLawCitations(tree) }

/**
 * 法规引用的渲染结果。
 *
 * 用 `<mark>` 而不是 `<span>`：它在语义上就是"为便于查阅而标出的内容"，
 * 屏幕阅读器与"朗读所标记内容"类辅助功能能识别。默认的黄底黑字由 CSS 覆盖。
 */
function LawCitation({ children }) {
  return <mark className="law-cite" title="法规引用，便于人工定位核对">{children}</mark>
}

/**
 * 表格：包一层可横向滚动的容器。
 *
 * 为什么必须包一层：模型输出的核对表格列数不受控（要素核查、条款对照都可能 4～6 列）。
 * 直接渲染 `<table>` 时表格会按内容宽度撑破气泡，把整页顶出横向滚动条；
 * 包一层 `overflow-x: auto` 后，窄屏只在表格内部滚动，页面布局不受影响。
 * 样式在 MarkdownBody.css 中定义（不在这里内联，方便深色主题统一覆盖）。
 */
function MarkdownTable({ children, ...props }) {
  return <div className="markdown-table-wrap"><table {...props}>{children}</table></div>
}

// 提到模块作用域：避免每次渲染都新建数组/对象，让 ReactMarkdown 拿到稳定引用
const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeLawCitations]
const COMPONENTS = { lawcite: LawCitation, table: MarkdownTable }

const MarkdownBody = React.memo(function MarkdownBody({ content }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  )
})

export default MarkdownBody
