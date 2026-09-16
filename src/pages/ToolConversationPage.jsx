import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowRight, Brain, History, LogOut, Menu, MessageCircle, PanelLeftClose, PanelLeftOpen, PenLine, Plus, Send, Trash2, Zap } from 'lucide-react'
import { useAuth } from '../components/AuthProvider'
import './ToolConversationPage.css'
import ToolOverviewLink from '../components/ToolOverviewLink'

const toolConfigs = {
  'ai-assistant': { title: '用工风险助手', intro: '描述员工关系中已经发生的情况、你掌握的材料和希望解决的问题。我会帮助你按事实、风险、处理步骤三个层次梳理，并提示还需要补充的信息。', placeholder: '描述你的用工问题和希望解决的重点…', prompts: ['员工拒绝调岗，该怎么处理？', '试用期解除需要准备什么材料？'] },
  'labor-contract': { title: '劳动合同分析', intro: '上传劳动合同或粘贴需要核对的条款。我会检查期限、试用期、薪酬、工时、保密、解除等核心约定，指出可能缺失或表述不清的部分。', placeholder: '上传劳动合同或输入特别关注的条款…', prompts: ['检查试用期和合同期限', '检查薪酬、工时与解除条款'] },
  arbitration: { title: '劳动仲裁答辩', intro: '说明仲裁请求、双方争议经过和现有证据。我会协助拆分争议焦点、整理待核实的事实与证据缺口，并形成答辩准备思路。', placeholder: '描述仲裁请求、事实和证据情况…', prompts: ['梳理争议焦点和证据清单', '从公司角度准备答辩思路'] },
  handbook: { title: '员工手册诊断', intro: '上传员工手册或提供需要检查的制度条款。我会从制度内容、民主程序、告知留痕和实际执行四个方面，提示可能存在的合规风险。', placeholder: '上传员工手册或输入需要检查的制度…', prompts: ['检查奖惩制度是否完整', '检查员工手册制定程序'] },
  'medical-calculator': { title: '医疗期计算器', intro: '请提供员工适用地区、累计工龄、在本单位工龄及病休起止时间。我会列出计算条件、适用规则和医疗期结果，方便你核对后续安排。', placeholder: '输入地区、累计工龄、司龄和病休日期…', prompts: ['计算一名上海员工的医疗期', '需要准备哪些计算信息？'] },
  'pension-calc1': { title: '企业职工养老保险测算', intro: '请提供参保地区、年龄、缴费基数和缴费年限等信息。我会先说明测算需要的条件，再按已知信息整理缴费与待遇的估算结果。', placeholder: '输入地区、年龄、缴费基数和年限…', prompts: ['测算企业职工养老保险', '先列出需要填写的信息'] },
  'pension-calc2': { title: '灵活就业保险测算', intro: '请提供参保地区、年龄和计划选择的缴费档位。我会比较不同档位的缴费成本与预期结果，帮助你确认需要进一步核实的条件。', placeholder: '输入参保地区、年龄和缴费档位…', prompts: ['比较不同缴费档位', '先列出测算所需信息'] }
}

const createId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
const createThread = (tool) => ({ id: createId('thread'), title: '新对话', messages: [{ id: createId('message'), role: 'assistant', content: tool.intro }] })

function readThreads(key, tool) {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || '[]')
    return Array.isArray(value) && value.length ? value : [createThread(tool)]
  } catch {
    return [createThread(tool)]
  }
}

function ToolConversationWorkspace({ toolId, tool }) {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const storageKey = `fafee-history-v2:${user.id}:${toolId}:threads`
  const [threads, setThreads] = useState(() => readThreads(storageKey, tool))
  const [activeId, setActiveId] = useState(() => threads[0].id)
  const [input, setInput] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const endRef = useRef(null)
  const activeThread = threads.find((thread) => thread.id === activeId) || threads[0]
  useEffect(() => { window.localStorage.setItem(storageKey, JSON.stringify(threads)) }, [storageKey, threads])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [activeThread?.messages.length])

  const newConversation = () => {
    const thread = createThread(tool)
    setThreads((items) => [thread, ...items])
    setActiveId(thread.id)
    setInput('')
  }

  const deleteConversation = (event, threadId) => {
    event.stopPropagation()
    const remaining = threads.filter((thread) => thread.id !== threadId)
    const next = remaining.length ? remaining : [createThread(tool)]
    setThreads(next)
    if (activeId === threadId) setActiveId(next[0].id)
  }

  const send = (value = input) => {
    const content = value.trim()
    if (!content) return
    setThreads((items) => items.map((thread) => thread.id === activeId ? {
      ...thread,
      title: thread.title === '新对话' ? content.slice(0, 20) : thread.title,
      messages: [...thread.messages,
        { id: createId('message'), role: 'user', content },
        { id: createId('message'), role: 'assistant', content: `这是“${tool.title}”的会话页面原型。正式功能接入后，会在这里根据你提供的信息展示分析过程和结果。` }
      ]
    } : thread))
    setInput('')
  }

  return (
    <main className={`prototype-chat ${sidebarCollapsed ? 'history-collapsed' : ''}`}>
      <aside className="prototype-chat-sidebar">
        <label className="prototype-history-search"><History size={17} /><input name="history-search" autoComplete="off" placeholder="搜索历史对话" /><kbd>⌘ K</kbd></label>
        <div className="prototype-brand"><img src="/logo.png" alt="" /><strong>法飞飞</strong></div>
        <button className="prototype-new-chat" type="button" onClick={newConversation}><PenLine size={19} />新对话</button>
        <p className="prototype-history-label">{tool.title} · 历史对话</p>
        <nav className="prototype-thread-list">
          {threads.map((thread) => <div className={`prototype-thread ${thread.id === activeId ? 'selected' : ''}`} key={thread.id}><button type="button" onClick={() => setActiveId(thread.id)}><MessageCircle size={15} /><span>{thread.title}</span></button><button className="prototype-thread-delete" type="button" aria-label={`删除对话：${thread.title}`} onClick={(event) => deleteConversation(event, thread.id)}><Trash2 size={13} /></button></div>)}
        </nav>
        <div className="prototype-account"><span>{user.username.slice(0, 1)}</span><div><strong>{user.username}</strong><small>{user.email}</small></div><button type="button" className="prototype-account-logout" onClick={async () => { if (await logout()) navigate('/auth?mode=login') }} aria-label="退出登录" title="退出登录"><LogOut size={16} /></button></div>
      </aside>

      <section className="prototype-chat-main">
        <header className="prototype-chat-header"><div className="prototype-header-actions"><button type="button" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? '展开历史会话栏' : '收起历史会话栏'} title={sidebarCollapsed ? '展开历史会话栏' : '收起历史会话栏'}>{sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}</button><ToolOverviewLink /></div><div><strong>{tool.title}</strong><small>AI 生成内容仅供参考，请结合实际情况判断</small></div><span /></header>
        <div className="prototype-messages">
          <div className="prototype-message-inner">
            {activeThread.messages.map((message) => message.role === 'user' ? <div className="prototype-user-message" key={message.id}>{message.content}</div> : <div className="prototype-assistant-message" key={message.id}>{message.content}</div>)}
            {activeThread.messages.length === 1 && <div className="prototype-prompts">{tool.prompts.map((prompt) => <button type="button" key={prompt} onClick={() => send(prompt)}>{prompt}<ArrowRight size={15} /></button>)}</div>}
            <div ref={endRef} />
          </div>
        </div>
        <div className="prototype-composer-wrap">
          <div className="prototype-composer"><textarea name="tool-input" autoComplete="off" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }} placeholder={tool.placeholder} /><div className="prototype-composer-bottom"><div className="prototype-composer-tools" aria-label="输入能力展示"><span className="prototype-add-file" title="文件上传将在正式版开放"><Plus size={24} /></span><i /><span className="prototype-mode-switch"><span className="prototype-mode active"><Zap size={16} />快速</span><span className="prototype-mode"><Brain size={16} />深度思考</span></span><span className="prototype-more"><Menu size={18} />更多</span></div><button className="prototype-send" type="button" onClick={() => send()} disabled={!input.trim()} aria-label="发送消息"><Send size={19} /></button></div></div>
        </div>
      </section>
    </main>
  )
}

export default function ToolConversationPage() {
  const { toolId } = useParams()
  const tool = useMemo(() => toolConfigs[toolId], [toolId])
  if (!tool) return <Navigate to="/tools" replace />
  return <ToolConversationWorkspace key={toolId} toolId={toolId} tool={tool} />
}
