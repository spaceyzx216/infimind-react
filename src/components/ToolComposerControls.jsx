import { useWorkspaceText } from './WorkspaceContext'
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Brain, MessageCircle, Plus } from 'lucide-react'
import { CONTEXT_WINDOW_TOKENS, estimateTokens } from '../utils/context-budget.js'
import './ToolComposerControls.css'

export function ContextUsage({ messages = [], question = '', hasPendingFiles = false }) {
  const t = useWorkspaceText()
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const open = !dismissed && (pinned || hovered || focused)
  const panelId = useId()
  const root = useRef(null)
  const panel = useRef(null)
  const dismiss = () => { setPinned(false); setDismissed(true) }
  const latest = [...messages].reverse().find((message) => message.result?.contextUsage || message.result?.usage || message.usage)
  const usage = latest?.result?.usage || latest?.usage
  const promptTokens = latest?.result?.contextUsage ? latest.result.contextUsage.promptTokens : usage?.prompt_tokens
  const estimated = 3000 + estimateTokens(question) + messages.filter((message) => !message.failed)
    .reduce((sum, message) => sum + estimateTokens(message.content || message.result?.reviewReport || message.result?.answer || '') + 16, 0)
  // Context measures input, not total_tokens (which also contains generated output).
  const actual = !question.trim() && !hasPendingFiles && Number.isFinite(promptTokens)
  const tokens = actual ? promptTokens : estimated
  const fraction = Math.max(0, tokens / CONTEXT_WINDOW_TOKENS * 100)
  const state = fraction >= 90 ? 'near-limit' : fraction >= 70 ? 'filling' : 'roomy'
  const status = t(state === 'near-limit' ? '接近上限' : state === 'filling' ? '渐满' : '充足')
  const heading = t(state === 'near-limit' ? '会话空间接近上限' : state === 'filling' ? '会话空间逐渐用满' : '会话空间充足')
  const description = t(state === 'near-limit' ? '建议新建会话，继续处理问题' : state === 'filling' ? '可以继续交流，长材料建议另开会话' : '可以继续交流')
  useEffect(() => {
    if (!open) return undefined
    const outside = (event) => {
      if (!root.current?.contains(event.target)) { setPinned(false); setDismissed(true) }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useLayoutEffect(() => {
    if (!open) return undefined
    const position = () => {
      const card = panel.current
      card.style.left = ''
      const rect = card.getBoundingClientRect()
      const offset = Math.max(12 - rect.left, Math.min(0, window.innerWidth - 12 - rect.right))
      if (offset) card.style.left = `${card.offsetLeft + offset}px`
    }
    position()
    window.addEventListener('resize', position)
    return () => window.removeEventListener('resize', position)
  }, [open])
  const progress = { '--context-progress': `${Math.min(100, fraction)}%` }
  return <div ref={root} className="tool-context" data-space={state}
    onPointerEnter={(event) => { if (event.pointerType !== 'touch') { setHovered(true); setDismissed(false) } }}
    onPointerLeave={() => setHovered(false)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    onKeyDown={(event) => { if (event.key === 'Escape') { dismiss(); event.stopPropagation() } }}>
    <button type="button" className="tool-context-trigger" aria-label={heading} aria-expanded={open} aria-controls={panelId}
      onFocus={() => { setFocused(true); setDismissed(false) }}
      onClick={() => { if (pinned) dismiss(); else { setPinned(true); setDismissed(false) } }}>
      <span className="tool-context-ring" style={progress} aria-hidden="true" /><span>{status}</span>
    </button>
    <div ref={panel} id={panelId} className="tool-context-popover" hidden={!open}>
      <span className="tool-context-illustration" aria-hidden="true">
        <span className="tool-context-ring tool-context-ring-large" style={progress} />
        <MessageCircle size={23} strokeWidth={1.65} />
      </span>
      <div className="tool-context-copy"><strong>{heading}</strong><span>{description}</span></div>
    </div>
  </div>
}

export default function ToolComposerControls({ onUpload, uploadLabel = '上传材料', disabled = false, modeDisabled = disabled, mode, onModeChange, messages, question, hasPendingFiles, children }) {
  const t = useWorkspaceText()
  return <div className="composer-tools tool-composer-controls">
    {onUpload && <button type="button" aria-label={uploadLabel} title={uploadLabel} onClick={onUpload} disabled={disabled}><Plus size={20} /></button>}
    {onModeChange && <button type="button" className={`tool-thinking-toggle${mode === 'thinking' ? ' active' : ''}`} aria-pressed={mode === 'thinking'} title={mode === 'thinking' ? t("深度思考已开启，点击关闭") : t("点击开启深度思考")} onClick={() => onModeChange(mode === 'thinking' ? 'fast' : 'thinking')} disabled={modeDisabled}><Brain size={16} />{t("深度思考")}</button>}
    <ContextUsage messages={messages} question={question} hasPendingFiles={hasPendingFiles} />
    {children}
  </div>
}
