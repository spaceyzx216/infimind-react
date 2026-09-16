import React, { useMemo, useState } from 'react'
import { ArrowRight, CheckCircle2, Eye, EyeOff, LockKeyhole, UserRound } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../components/AuthProvider'
import './AuthPage.css'

export default function AuthPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { login, register, authError } = useAuth()
  const initialMode = params.get('mode') === 'register' ? 'register' : 'login'
  const [mode, setMode] = useState(initialMode)
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState({ identifier: '', username: '', email: '', password: '', inviteCode: '' })
  const redirect = useMemo(() => {
    const value = params.get('redirect') || '/tools'
    return value.startsWith('/') && !value.startsWith('//') ? value : '/tools'
  }, [params])

  const switchMode = (next) => {
    setMode(next)
    setError('')
    setNotice('')
    const copy = new URLSearchParams(params)
    copy.set('mode', next)
    setParams(copy)
  }

  const updateField = (name, value) => setForm((current) => ({ ...current, [name]: value }))

  const submit = async (event) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    setNotice('')
    try {
      if (mode === 'login') {
        await login({ identifier: form.identifier.trim(), password: form.password })
        navigate(redirect, { replace: true })
      } else {
        await register({
          inviteCode: form.inviteCode.trim(),
          username: form.username.trim(),
          email: form.email.trim(),
          password: form.password
        })
        setForm((current) => ({ ...current, password: '', inviteCode: '' }))
        setNotice('注册成功，请使用用户名或邮箱登录。')
        setMode('login')
        const copy = new URLSearchParams(params)
        copy.set('mode', 'login')
        setParams(copy)
      }
    } catch (submitError) {
      setError(submitError.message || (mode === 'login' ? '登录失败，请稍后重试' : '注册失败，请检查填写内容'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-story" role="img" aria-label="法飞飞 AI：让法律更简单，让企业更安心。专业可靠、高效便捷、值得信赖。" />

      <section className="auth-panel">
        <Link to="/" className="auth-back">返回官网 <ArrowRight size={17} /></Link>
        <div className="auth-form-wrap">
          <div className="auth-tabs" role="tablist">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')} type="button">登录</button>
            <button className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')} type="button">邀请码注册</button>
          </div>
          <div className="auth-heading">
            <h2>{mode === 'login' ? '欢迎回来' : '创建法飞飞账户'}</h2>
            <p>{mode === 'login' ? '登录后继续使用你的工具和历史任务。' : '使用团队提供的邀请码完成注册。'}</p>
          </div>
          {(error || authError) && <p className="auth-error" role="alert">{error || authError}</p>}
          {notice && <p className="auth-success" role="status">{notice}</p>}
          <form onSubmit={submit}>
            {mode === 'register' && <label>邀请码<input required value={form.inviteCode} onChange={(event) => updateField('inviteCode', event.target.value)} placeholder="请输入邀请码" autoComplete="off" /></label>}
            {mode === 'register' && <label>用户名<input required minLength={2} maxLength={32} value={form.username} onChange={(event) => updateField('username', event.target.value)} placeholder="请输入用户名" autoComplete="username" /></label>}
            {mode === 'register' && <label>邮箱<input required type="email" value={form.email} onChange={(event) => updateField('email', event.target.value)} placeholder="请输入常用邮箱" autoComplete="email" /></label>}
            {mode === 'login' && <label>用户名或邮箱<div className="auth-icon-field"><UserRound size={22} aria-hidden="true" /><input required autoComplete="username" value={form.identifier} onChange={(event) => updateField('identifier', event.target.value)} placeholder="请输入用户名或邮箱" /></div></label>}
            <label>密码<div className="password-field auth-icon-field"><LockKeyhole size={22} aria-hidden="true" /><input required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} maxLength={128} type={showPassword ? 'text' : 'password'} value={form.password} onChange={(event) => updateField('password', event.target.value)} placeholder={mode === 'login' ? '请输入密码' : '至少 8 位'} /><button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
            <button className="auth-submit" type="submit" disabled={submitting}>{submitting ? '处理中…' : mode === 'login' ? '登录并继续' : '完成注册'} <ArrowRight size={18} /></button>
          </form>
          {mode === 'register' && <div className="auth-invite-note"><CheckCircle2 size={17} /><span>邀请码由法飞飞团队审核后发放，每个邀请码只能注册一个账户。</span></div>}
          <div className="auth-options"><span className="auth-session-note">登录状态保留 7 天</span><a className="auth-apply" href="https://jsj.top/f/NctQWw" target="_blank" rel="noopener noreferrer">没有邀请码？申请体验</a></div>
          <p className="auth-prototype-note">账号数据由服务端安全保存，退出登录后需要重新登录。</p>
        </div>
      </section>
    </main>
  )
}
