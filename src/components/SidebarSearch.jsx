import { Search } from 'lucide-react'
import { useWorkspaceLayout, useWorkspaceText } from './WorkspaceContext'

/**
 * 各功能侧栏统一的搜索栏。
 *
 * 统一的三件事（此前七个页面各写一份、互不一致）：
 *  1. 图标：统一用放大镜 `Search`（原来用的是 `History` 时钟箭头，语义偏“历史”而非“搜索”）；
 *  2. 结构：`label.sidebar-search` + 输入框 + 快捷键提示，样式沿用既有 `.sidebar-search`；
 *  3. 快捷键提示写法：跟随用户设置（`settings.shortcuts.search`），关闭时整块不显示，
 *     文案统一为 `⌘ / Ctrl X`（原来有的页写死 `⌘ K`、有的页只在 Mac 上显示 ⌘）。
 *
 * 文案按功能微调：调用方传入已翻译好的 `placeholder` 即可（同时用作 `aria-label`）。
 */
export default function SidebarSearch({ placeholder, value, onChange, inputRef, name, className = '' }) {
  const t = useWorkspaceText()
  const { settings } = useWorkspaceLayout()
  const label = placeholder || t('搜索历史会话')
  const shortcut = settings?.shortcuts?.search
  return <label className={`sidebar-search${className ? ` ${className}` : ''}`}>
    <Search size={17} aria-hidden="true" />
    <input ref={inputRef} name={name} autoComplete={name ? 'off' : undefined} value={value}
      onChange={onChange} placeholder={label} aria-label={label} />
    {shortcut && shortcut !== 'disabled' && <kbd>⌘ / Ctrl {String(shortcut).toUpperCase()}</kbd>}
  </label>
}
