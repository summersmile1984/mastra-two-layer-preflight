import { useState } from 'react';
import { signIn, signUp } from '../lib/api';

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      if (mode === 'in') await signIn(email, password);
      else await signUp(name || email.split('@')[0], email, password);
      onDone();
    } catch (e: any) {
      setErr(mode === 'in' ? '登录失败，请检查邮箱和密码' : '注册失败，邮箱可能已存在');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-bg)] p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-8"
      >
        <h1 className="mb-1 text-xl font-semibold">两层 Agent</h1>
        <p className="mb-6 text-sm text-[var(--color-mut)]">
          {mode === 'in' ? '登录以进入你的房间' : '创建一个账号'}
        </p>

        {mode === 'up' && (
          <label className="mb-3 block">
            <span className="mb-1 block text-xs text-[var(--color-mut)]">昵称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="怎么称呼你"
              className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
            />
          </label>
        )}
        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-[var(--color-mut)]">邮箱</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
          />
        </label>
        <label className="mb-5 block">
          <span className="mb-1 block text-xs text-[var(--color-mut)]">密码</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 8 位"
            className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
          />
        </label>

        {err && <p className="mb-3 text-sm text-red-500">{err}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-full bg-[var(--color-fg)] py-2.5 font-medium text-[var(--color-bg)] disabled:opacity-50"
        >
          {busy ? '请稍候…' : mode === 'in' ? '登录' : '注册'}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'in' ? 'up' : 'in');
            setErr('');
          }}
          className="mt-4 w-full text-center text-sm text-[var(--color-mut)] hover:text-[var(--color-fg)]"
        >
          {mode === 'in' ? '没有账号？去注册' : '已有账号？去登录'}
        </button>
      </form>
    </div>
  );
}
