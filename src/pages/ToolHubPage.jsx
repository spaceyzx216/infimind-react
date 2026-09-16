import React, { useEffect, useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowRight, BookOpen, Brain, Building2, Calculator, FileEdit,
  FilePenLine, FileText, Home, LayoutGrid, LogOut, Scale, User
} from 'lucide-react'
import { useAuth } from '../components/AuthProvider'
import './ToolHubPage.css'

const featuredTools = [
  { id: 'contract-review', icon: FileEdit, title: '商业合同审查与批注', desc: '识别付款、违约、交付等关键风险，生成逐条批注。', path: '/contract-rewrite' },
  { id: 'contract-draft', icon: FilePenLine, title: '商业合同智能起草', desc: '根据交易主体、标的和诉求生成可编辑合同初稿。', path: '/contract-draft' }
]

const toolGroups = [
  {
    title: '用工管理', desc: '覆盖入职、在职、离职及争议处理场景', tools: [
      { id: 'ai-assistant', icon: Brain, title: '用工风险助手', desc: '围绕调岗、解除、工时等问题梳理风险和处理步骤。', path: '/tools/ai-assistant' },
      { id: 'labor-contract', icon: FileText, title: '劳动合同分析', desc: '检查期限、试用期、薪酬、解除等核心条款。', path: '/tools/labor-contract' },
      { id: 'arbitration', icon: Scale, title: '劳动仲裁答辩', desc: '整理仲裁请求、事实经过和证据缺口，形成答辩思路。', path: '/tools/arbitration' },
      { id: 'handbook', icon: BookOpen, title: '员工手册诊断', desc: '检查奖惩、考勤、离职等制度的合规性与制定程序。', path: '/tools/handbook' }
    ]
  },
  {
    title: '专项测算', desc: '结合适用条件展示计算过程与结果', tools: [
      { id: 'medical-calculator', icon: Calculator, title: '医疗期计算器', desc: '输入地区、工龄和病休日期，计算医疗期并展示依据。', path: '/tools/medical-calculator' },
      { id: 'pension-calc1', icon: Building2, title: '企业职工养老保险测算', desc: '结合地区、基数和缴费年限估算缴费与待遇。', path: '/tools/pension-calc1' },
      { id: 'pension-calc2', icon: User, title: '灵活就业保险测算', desc: '比较不同缴费档位，了解灵活就业参保成本。', path: '/tools/pension-calc2' }
    ]
  }
]

export default function ToolHubPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { user, logout: logoutUser } = useAuth()
  const highlighted = params.get('tool')
  const highlightedTitle = useMemo(() => {
    const allTools = [...featuredTools, ...toolGroups.flatMap((group) => group.tools)]
    return allTools.find((tool) => tool.id === highlighted)?.title
  }, [highlighted])

  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }) }, [])

  const logout = async () => {
    if (await logoutUser()) navigate('/auth?mode=login')
  }

  return (
    <main className="workspace-shell">
      <aside className="workspace-sidebar">
        <Link className="workspace-logo" to="/"><img src="/法飞飞标题.webp" alt="法飞飞 AI" /></Link>
        <nav className="workspace-nav" aria-label="工具台导航">
          <Link className="active" to="/tools"><LayoutGrid size={19} />工具总览</Link>
          <Link to="/"><Home size={19} />返回官网</Link>
        </nav>
        <div className="workspace-account">
          {user ? (
            <><span className="workspace-avatar">{user.username.slice(0, 1)}</span><div><strong>{user.username}</strong><small>{user.email}</small></div><button type="button" onClick={logout} aria-label="退出登录"><LogOut size={17} /></button></>
          ) : (
            <Link to="/auth?mode=login"><span className="workspace-avatar">访</span><div><strong>登录 / 注册</strong><small>使用邀请码开通</small></div><ArrowRight size={17} /></Link>
          )}
        </div>
      </aside>

      <section className="workspace-main">
        <header className="workspace-heading">
          <div><h1>今天要处理什么？</h1><p>选择合适的法律 AI 工具，开始合同处理、用工分析或专项测算。</p></div>
        </header>

        {highlightedTitle && <div className="workspace-context">你刚才查看了：<strong>{highlightedTitle}</strong></div>}

        <section className="workspace-featured" aria-labelledby="contract-tools-title">
          <div className="workspace-section-title"><div><h2 id="contract-tools-title">商业合同工具</h2><p>围绕合同审查和起草，快速进入对应的 AI 工作空间。</p></div></div>
          <div className="featured-grid">
            {featuredTools.map((tool) => {
              const Icon = tool.icon
              return (
                <article className={`featured-tool ${highlighted === tool.id ? 'highlighted' : ''}`} key={tool.id}>
                  <span className="featured-icon"><Icon size={30} /></span>
                  <div><h3>{tool.title}</h3><p>{tool.desc}</p></div>
                  <Link to={tool.path}>开始使用 <ArrowRight size={18} /></Link>
                </article>
              )
            })}
          </div>
        </section>

        <section className="workspace-upcoming" aria-label="法律工具">
          {toolGroups.map((group) => (
            <div className="upcoming-group" key={group.title}>
              <div className="workspace-section-title"><div><h2>{group.title}</h2><p>{group.desc}</p></div><span>{group.tools.length} 项</span></div>
              <div className="upcoming-grid">
                {group.tools.map((tool) => {
                  const Icon = tool.icon
                  return (
                    <Link className={`upcoming-tool ${highlighted === tool.id ? 'highlighted' : ''}`} key={tool.id} to={tool.path}>
                      <Icon size={23} /><div><h3>{tool.title}</h3><p>{tool.desc}</p></div><span>开始使用 <ArrowRight size={14} /></span>
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </section>
      </section>
    </main>
  )
}
