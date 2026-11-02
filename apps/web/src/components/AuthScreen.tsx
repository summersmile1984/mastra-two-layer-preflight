import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Mode = 'signin' | 'signup' | 'otp'

export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [otp, setOtp] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  async function submit() {
    setBusy(true)
    setErr('')
    try {
      let r
      if (mode === 'signup') {
        r = await api('/api/auth/sign-up/email', {
          email,
          password,
          name: name.trim() || email.split('@')[0],
        })
      } else if (mode === 'signin') {
        r = await api('/api/auth/sign-in/email', { email, password })
      } else {
        r = await api('/api/auth/sign-in/email-otp', { email, otp: otp.trim() })
      }
      if (r.ok) onAuthed()
      else setErr(r.j.message || r.j.error || `失败 ${r.status}`)
    } finally {
      setBusy(false)
    }
  }

  async function sendOtp() {
    if (!email.trim()) return setErr('请先填邮箱')
    const r = await api('/api/auth/email-otp/send-verification-otp', {
      email: email.trim(),
      type: 'sign-in',
    })
    if (!r.ok) return setErr(r.j.message || r.j.error || `失败 ${r.status}`)
    setErr('')
    const d = await api<{ otp?: string }>(`/api/dev/otp?email=${encodeURIComponent(email.trim())}`)
    if (d.ok && d.j.otp) {
      setOtp(d.j.otp)
      setHint('开发模式：验证码已自动填入')
    } else setHint('验证码已发送')
  }

  const tabs: { id: Mode; label: string }[] = [
    { id: 'signin', label: '密码登录' },
    { id: 'signup', label: '注册' },
    { id: 'otp', label: '验证码' },
  ]

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-5">
      <div className="w-full max-w-[380px] rounded-2xl border border-line bg-panel p-7 shadow-[var(--shadow-md)]">
        <h1 className="m-0 text-xl font-semibold">管家 · 群聊</h1>
        <p className="mt-1 text-sm text-mut">登录后与管家私聊，或邀请朋友进群一起聊</p>
        <div className="mt-4 mb-3 flex gap-1.5">
          {tabs.map((t) => (
            <Button
              key={t.id}
              type="button"
              variant={mode === t.id ? 'default' : 'soft'}
              className="flex-1"
              onClick={() => {
                setMode(t.id)
                setErr('')
                setHint('')
              }}
            >
              {t.label}
            </Button>
          ))}
        </div>
        <label className="mb-1 block text-xs font-medium text-mut">邮箱</label>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          className="mb-2.5"
        />
        {mode === 'signup' && (
          <>
            <label className="mb-1 block text-xs font-medium text-mut">昵称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="群里显示的名字"
              className="mb-2.5"
            />
          </>
        )}
        {mode !== 'otp' && (
          <>
            <label className="mb-1 block text-xs font-medium text-mut">密码</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 位"
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              className="mb-2.5"
            />
          </>
        )}
        {mode === 'otp' && (
          <div className="mb-2.5 flex gap-2">
            <Input
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              placeholder="6 位验证码"
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <Button type="button" variant="ghost" onClick={sendOtp}>
              发送验证码
            </Button>
          </div>
        )}
        <Button className="mt-1 w-full" disabled={busy} onClick={submit}>
          {mode === 'signup' ? '注册并登录' : '登录'}
        </Button>
        <div className={cn('mt-2 min-h-[18px] text-sm', err ? 'text-err' : 'text-ok')}>
          {err || hint}
        </div>
      </div>
    </div>
  )
}
