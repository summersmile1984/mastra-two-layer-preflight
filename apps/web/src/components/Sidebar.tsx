import { useState } from 'react';
import type { Room, User } from '../lib/api';

function initials(name?: string | null) {
  const s = (name ?? '').trim();
  return s ? s.slice(0, 1).toUpperCase() : '?';
}

function timeAgo(ts?: number | null) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

export function Sidebar({
  rooms,
  activeId,
  me,
  onSelect,
  onNewRoom,
  onSignOut,
}: {
  rooms: Room[];
  activeId: string | null;
  me: User;
  onSelect: (id: string) => void;
  onNewRoom: (name: string) => void;
  onSignOut: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  function submitNew(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    onNewRoom(n);
    setName('');
    setCreating(false);
  }

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-side)]">
      <div className="px-4 pt-5">
        <h1 className="text-[17px] font-semibold">房间</h1>
      </div>

      <div className="mt-4 flex items-center justify-between px-4">
        <div className="text-xs text-[var(--color-mut)]">我的房间</div>
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded-full border border-[var(--color-line)] px-2.5 py-0.5 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
        >
          + 新建
        </button>
      </div>

      {creating && (
        <form onSubmit={submitNew} className="mx-3 mt-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="房间名称"
            className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-acc)]"
          />
        </form>
      )}

      <div className="thin-scroll mt-2 flex-1 overflow-y-auto">
        {rooms.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-mut)]">
            还没有房间，点「新建」开始
          </div>
        )}
        {rooms.map((r) => (
          <button
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={`flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--color-line)] ${
              activeId === r.id ? 'bg-[var(--color-line)]' : ''
            }`}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-acc)] text-sm font-semibold text-white">
              {initials(r.name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">{r.name}</span>
                <span className="shrink-0 text-[11px] text-[var(--color-mut)]">{timeAgo(r.last_message_at)}</span>
              </div>
              <div className="truncate text-xs text-[var(--color-mut)]">
                {r.last_message ?? '暂无消息'}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--color-line)] px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-fg)] text-xs font-semibold text-[var(--color-bg)]">
          {initials(me.name || me.email)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{me.name || me.email}</div>
          <div className="truncate text-[11px] text-[var(--color-mut)]">{me.email}</div>
        </div>
        <button
          onClick={onSignOut}
          className="rounded-full border border-[var(--color-line)] px-2.5 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
        >
          退出
        </button>
      </div>
    </aside>
  );
}
