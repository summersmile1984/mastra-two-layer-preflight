import { useEffect, useState } from 'react';
import type { Persona } from '../lib/api';
import { getPersona, updatePersona } from '../lib/api';

export function SettingsPanel({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (p: Persona) => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [style, setStyle] = useState('');
  const [mainRoomName, setMainRoomName] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPersona()
      .then((p) => {
        setName(p.name);
        setRole(p.role);
        setStyle(p.style);
        setMainRoomName(p.main_room_name);
      })
      .catch(() => setErr('加载配置失败，请稍后重试'))
      .finally(() => setLoading(false));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const p = await updatePersona({ name, role, style, main_room_name: mainRoomName });
      onSuccess(p);
    } catch {
      setErr('保存失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={submit}
        className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-8"
      >
        <h1 className="mb-1 text-xl font-semibold">秘书设置</h1>
        <p className="mb-6 text-sm text-[var(--color-mut)]">调整秘书的人格与主会话</p>

        {loading ? (
          <div className="py-10 text-center text-sm text-[var(--color-mut)]">加载中…</div>
        ) : (
          <>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>秘书名称</span>
                <span>{name.length}/200</span>
              </span>
              <input
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                placeholder="怎么称呼秘书"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>身份角色</span>
                <span>{role.length}/500</span>
              </span>
              <input
                value={role}
                maxLength={500}
                onChange={(e) => setRole(e.target.value)}
                placeholder="如 24 小时贴身秘书、管家与伴侣"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>语调风格</span>
                <span>{style.length}/1000</span>
              </span>
              <textarea
                value={style}
                maxLength={1000}
                rows={4}
                onChange={(e) => setStyle(e.target.value)}
                placeholder="语调与性格要点"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-5 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>主会话名称</span>
                <span>{mainRoomName.length}/50</span>
              </span>
              <input
                value={mainRoomName}
                maxLength={50}
                onChange={(e) => setMainRoomName(e.target.value)}
                placeholder="主会话显示名"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
          </>
        )}

        {err && <p className="mb-3 text-sm text-red-500">{err}</p>}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-full border border-[var(--color-line)] py-2.5 font-medium text-[var(--color-mut)] hover:text-[var(--color-fg)]"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy || loading}
            className="flex-1 rounded-full bg-[var(--color-fg)] py-2.5 font-medium text-[var(--color-bg)] disabled:opacity-50"
          >
            {busy ? '请稍候…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
