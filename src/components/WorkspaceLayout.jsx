import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { CalendarHeart, FileCheck2, FilePenLine, FileSearch, Gavel, HandCoins, Home, LogOut, MessageCircle, PanelLeft, Settings2, UserRound, X } from 'lucide-react'
import { useAuth } from './AuthProvider'
import { WorkspaceContext } from './WorkspaceContext'
import WorkspaceConversationMenu from './WorkspaceConversationMenu'
import AccountUsagePanel from './AccountUsagePanel'
import WorkspaceToolsMenu from './WorkspaceToolsMenu'
import WorkspaceToolRail from './WorkspaceToolRail'
import WorkspaceSettings from './WorkspaceSettings'
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings'
import { translateWorkspace } from './workspace-language'
import './WorkspaceLayout.css'
import './WorkspaceTheme.css'

const tools = [
  { label: '用工咨询', icon: MessageCircle, path: '/labor-consult', aliases: ['/tools/labor-consult'] },
  { label: '商业合同审查', icon: FileSearch, path: '/contract-rewrite', aliases: ['/tools/contract-review'] },
  { label: '商业合同起草', icon: FilePenLine, path: '/contract-draft', aliases: ['/tools/contract-draft'] },
  { label: '劳动合同分析', icon: FileCheck2, path: '/tools/labor-contract', aliases: [] },
  { label: '劳动仲裁答辩', icon: Gavel, path: '/tools/arbitration', aliases: [] },
  { label: '医疗期计算器', icon: CalendarHeart, path: '/tools/medical-calculator', aliases: [], defaultPinned: false, formOnly: true },
  { label: '养老保险测算', icon: HandCoins, path: '/tools/pension-calc1', aliases: ['/tools/pension-calc2'], defaultPinned: false, formOnly: true }
]

const readPinnedPaths = (key) => {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null')
    if (Array.isArray(saved)) return [...new Set(saved.filter((path) => tools.some((tool) => tool.path === path)))]
  } catch { /* Use the default tools when local storage is unavailable. */ }
  return tools.filter((tool) => tool.defaultPinned !== false).map((tool) => tool.path)
}

const readMeta = (key) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

export default function WorkspaceLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { user, logout, authError } = useAuth()
  const { settings, updateSettings, theme } = useWorkspaceSettings(user.id)
  const t = useCallback((text) => translateWorkspace(text, settings.language), [settings.language])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const workspaceRef = useRef(null)
  const pinnedToolsKey = `fafee-workspace-pinned-tools-v1:${user.id}`
  const [pinnedPaths, setPinnedPaths] = useState(() => readPinnedPaths(pinnedToolsKey))
  const pinnedTools = useMemo(() => pinnedPaths.map((path) => tools.find((tool) => tool.path === path)).filter(Boolean), [pinnedPaths])
  const [initialConversationId] = useState(() => new URLSearchParams(window.location.search).get('sideChat') || '')
  const isSideChat = Boolean(initialConversationId)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => isSideChat || window.matchMedia('(max-width: 760px)').matches)
  const [conversationActions, setConversationActions] = useState(null)
  const [conversationMenuRequest, openConversationMenu] = useState(null)
  const metadataKey = `fafee-workspace-conversation-meta-v1:${user.id}`
  const [conversationMeta, setConversationMeta] = useState(() => readMeta(metadataKey))
  const [sideChat, setSideChat] = useState(null)
  const [accountOpen, setAccountOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const accountRef = useRef(null)
  const accountButtonRef = useRef(null)
  const current = tools.find((tool) => tool.path === pathname || tool.aliases.includes(pathname))
  const formOnly = Boolean(current?.formOnly)
  const CurrentIcon = current?.icon || MessageCircle
  const toggleToolPin = (path) => {
    setPinnedPaths((previous) => {
      const next = previous.includes(path) ? previous.filter((item) => item !== path) : [...previous, path]
      try { localStorage.setItem(pinnedToolsKey, JSON.stringify(next)) } catch { /* Keep this selection for the current session. */ }
      return next
    })
  }
  const reorderTools = useCallback((paths) => {
    setPinnedPaths(paths)
    try { localStorage.setItem(pinnedToolsKey, JSON.stringify(paths)) } catch { /* Keep this order for the current session. */ }
  }, [pinnedToolsKey])
  const updateConversationMeta = useCallback((key, patch) => {
    setConversationMeta((previous) => {
      const saved = readMeta(metadataKey)
      const base = { ...previous, ...saved }
      const next = { ...base, [key]: { ...base[key], ...patch } }
      try { localStorage.setItem(metadataKey, JSON.stringify(next)) } catch { /* Keep changes available in this session. */ }
      return next
    })
  }, [metadataKey])
  const workspace = useMemo(() => ({ settings, updateSettings, t, sidebarCollapsed, setSidebarCollapsed, conversationMeta, updateConversationMeta, setConversationActions, openConversationMenu, isSideChat, initialConversationId }), [settings, updateSettings, t, sidebarCollapsed, conversationMeta, updateConversationMeta, isSideChat, initialConversationId])

  useEffect(() => {
    const sync = (event) => { if (event.key === metadataKey) setConversationMeta(readMeta(metadataKey)) }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [metadataKey])

  const createSideChat = () => {
    const id = crypto.randomUUID()
    setSideChat({ path: pathname, id, open: true, label: current?.label })
  }

  useEffect(() => { openConversationMenu(null) }, [pathname])

  useEffect(() => {
    if (!accountOpen) return
    const close = (event) => {
      if (event.key === 'Escape') {
        setAccountOpen(false)
        accountButtonRef.current?.focus()
      } else if (event.type === 'pointerdown' && !accountRef.current?.contains(event.target)) {
        setAccountOpen(false)
      }
    }
    document.addEventListener('keydown', close)
    document.addEventListener('pointerdown', close)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('pointerdown', close)
    }
  }, [accountOpen])

  useEffect(() => {
    const keys = (event) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
      const inDialog = event.target.closest?.('[role="dialog"], dialog')
      const textarea = event.target.closest?.('.composer textarea')
      if (textarea && event.key === 'Enter' && !event.shiftKey && !event.altKey) {
        const command = event.metaKey || event.ctrlKey
        const send = settings.sendKey === 'enter' ? !command : command
        event.stopImmediatePropagation()
        if (send) {
          event.preventDefault()
          textarea.closest('.composer')?.querySelector('.voice-send:not(:disabled)')?.click()
        }
        return
      }
      if (inDialog || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const action = Object.entries(settings.shortcuts).find(([, key]) => key !== 'disabled' && key === event.key.toLowerCase())?.[0]
      // Suppress the old fixed search shortcut after remapping, preserving text editing.
      const editing = event.target.matches?.('input, textarea, [contenteditable="true"]')
      if (!action) { if (event.key.toLowerCase() === 'k') event.stopImmediatePropagation(); return }
      if (editing && action !== 'search' && action !== 'settings') return
      if (formOnly && action !== 'settings') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (action === 'settings') { setAccountOpen(false); setSettingsOpen(true) }
      if (action === 'history') setSidebarCollapsed((value) => !value)
      if (action === 'newChat') conversationActions?.createNew?.()
      if (action === 'search' && !isSideChat) {
        setSidebarCollapsed(false)
        requestAnimationFrame(() => workspaceRef.current?.querySelector('.sidebar-search input, .prototype-history-search input')?.focus())
      }
    }
    const links = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = event.target.closest?.('.conversation a[href], .document-column a[href], .prototype-messages a[href]')
      if (!link || link.hasAttribute('download') || !/^https?:/i.test(link.href)) return
      // Keep the normal browser link behavior (including popup rules and modifier keys).
      link.target = settings.links === 'new-tab' ? '_blank' : '_self'
      link.rel = 'noopener noreferrer'
    }
    window.addEventListener('keydown', keys, true)
    document.addEventListener('click', links, true)
    return () => { window.removeEventListener('keydown', keys, true); document.removeEventListener('click', links, true) }
  }, [settings.sendKey, settings.shortcuts, settings.links, conversationActions, isSideChat, formOnly])

  const signOut = async () => {
    setLoggingOut(true)
    try {
      if (await logout()) navigate('/auth?mode=login', { replace: true })
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <WorkspaceContext.Provider value={workspace}>
      <div ref={workspaceRef} lang={settings.language} data-theme={theme} data-steps={settings.steps} data-analysis-panel={settings.analysisPanel} style={{ '--workspace-chat-font-size': `${settings.fontSize}px` }} className={`app-workspace${sidebarCollapsed ? ' is-history-collapsed' : ''}${isSideChat ? ' is-side-chat' : ''}`}>
        <aside className="app-workspace-rail" aria-label={t("工作空间导航")}>
          <Link className="app-workspace-brand app-workspace-icon" to="/" aria-label={t("返回官网")}>
            <Home size={21} strokeWidth={1.7} aria-hidden="true" />
            <span className="app-workspace-tooltip" aria-hidden="true">{t("返回官网")}</span>
          </Link>
          <WorkspaceToolRail tools={pinnedTools.map((tool) => ({ ...tool, label: t(tool.label) }))} pathname={pathname} onReorder={reorderTools} onNavigate={() => setAccountOpen(false)} />
          <WorkspaceToolsMenu key={pathname} tools={tools.map((tool) => ({ ...tool, label: t(tool.label) }))} pinnedPaths={pinnedPaths} pathname={pathname} onTogglePin={toggleToolPin} onNavigate={() => setAccountOpen(false)} />
          <span className="workspace-rail-divider" aria-hidden="true" />
          <div className="app-workspace-account" ref={accountRef}>
            <button ref={accountButtonRef} className="app-workspace-icon" type="button" aria-label={t("账户菜单")} aria-haspopup="dialog" aria-expanded={accountOpen} aria-controls="workspace-account-menu" onClick={() => setAccountOpen((open) => !open)}>
              <UserRound size={21} strokeWidth={1.7} aria-hidden="true" />
              <span className="app-workspace-tooltip" aria-hidden="true">{user?.username || t("账户")}</span>
            </button>
            {accountOpen && <section className="app-workspace-account-menu" id="workspace-account-menu" role="dialog" aria-label={t("账户")}>
              <div className="workspace-account-profile">
                <span className="workspace-account-avatar" aria-hidden="true">{Array.from(user?.username || t("法"))[0].toUpperCase()}</span>
                <div><strong>{user?.username}</strong><small>{user?.email}</small></div>
              </div>
              <AccountUsagePanel />
              <div className="workspace-account-divider" />
              <button type="button" onClick={() => { setAccountOpen(false); setSettingsOpen(true) }}><Settings2 size={16} aria-hidden="true" />{t("设置")}</button>
              <Link to="/"><Home size={16} aria-hidden="true" />{t("返回官网")}</Link>
              <button type="button" onClick={signOut} disabled={loggingOut}><LogOut size={16} aria-hidden="true" />{loggingOut ? t("正在退出…") : t("退出登录")}</button>
              {authError && <p role="alert">{authError}</p>}
            </section>}
          </div>
        </aside>
        <header className="app-workspace-topbar">
          {!formOnly && <button className="app-workspace-icon app-workspace-history-toggle" type="button" aria-label={sidebarCollapsed ? t("展开历史会话") : t("收起历史会话")} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>
            <PanelLeft size={19} strokeWidth={1.7} aria-hidden="true" />
          </button>}
          {!formOnly && <span className="app-workspace-topbar-divider" aria-hidden="true" />}
          <div className="app-workspace-page-title"><CurrentIcon size={18} strokeWidth={1.7} aria-hidden="true" /><strong>{t(current?.label || '法律工具')}</strong></div>
          {!formOnly && <WorkspaceConversationMenu key={pathname} actions={conversationActions} contextRequest={conversationMenuRequest?.path === pathname ? conversationMenuRequest : null} onCreateSide={createSideChat} />}
        </header>
        <div className={`app-workspace-stage${sideChat?.open && sideChat.path === pathname ? ' has-side-chat' : ''}`}>
          <div className="app-workspace-content"><Outlet /></div>
          {sideChat && <section className="workspace-side-chat" aria-label={t("侧边聊天")} hidden={!sideChat.open || sideChat.path !== pathname}>
            <header><span><MessageCircle size={16} aria-hidden="true" />{t("侧边聊天")}<span className="workspace-side-tool">{t(sideChat.label)}</span></span><button type="button" aria-label={t("关闭侧边聊天")} onClick={() => setSideChat((side) => ({ ...side, open: false }))}><X size={18} aria-hidden="true" /></button></header>
            <iframe key={sideChat.id} src={`${sideChat.path}?sideChat=${encodeURIComponent(sideChat.id)}`} title={t("侧边聊天")} />
          </section>}
        </div>
        {settingsOpen && <WorkspaceSettings onClose={() => { setSettingsOpen(false); accountButtonRef.current?.focus() }} />}
      </div>
    </WorkspaceContext.Provider>
  )
}
