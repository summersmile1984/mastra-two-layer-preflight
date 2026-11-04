import { useEffect, useRef, useState } from 'react';
import type { Member, Message, User } from '../lib/api';
import { listMessages, sendMessage, addMember } from '../lib/api';

function initials(name?: string | null) {
  const s = (name ?? '').trim();
  return s ? s.slice(0, 1).toUpperCase() : '?';
}

function Bubble({ m, members, me }: { m: Message; members: Member[]; me: User }) {
  const isUser = m.role === 'user';
  const isSelf = isUser && m.user_id === me.id;
  const sender = members.find((x) => x.user_id === m.user_id);
  const label = isUser ? (isSelf ? '我' : sender?.name || sender?.email || '成员') : '助手';

  return (
    <div className={`flex gap-2.5 ${isSelf ? 'justify-end' : ''}`}>
      {!isSelf && (
        <div
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            isUser ? 'bg-[var(--color-acc)] text-white' : 'bg-[var(--color-fg)] text-[var(--color-bg)]'
          }`}
        >
          {isUser ? initials(label) : '助'}
        </div>
      )}
      <div className={`max-w-[78%] ${isSelf ? 'items-end' : 'items-start'} flex flex-col`}>
        <div className="mb-0.5 px-1 text-[11px] text-[var(--color-mut)]">{label}</div>
        <div
          className={`whitespace-pre-wrap break-words rounded-[18px] px-3.5 py-2.5 ${
            isSelf
              ? 'rounded-br-[6px] bg-[var(--color-me)] text-[var(--color-mefg)]'
              : 'rounded-bl-[6px] bg-[var(--color-bot)] text-[var(--color-fg)]'
          }`}
        >
          {m.content}
        </div>
      </div>
    </div>
  );
}

export function Chat({
  roomId,
  roomName,
  me,
  members,
  onMembersChanged,
}: {
  roomId: string;
  roomName: string;
  me: User;
  members: Member[];
  onMembersChanged: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [invite, setInvite] = useState('');
  const [inviteMsg, setInviteMsg] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string>('');

  // 加载 + 轮询
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    async function poll() {
      try {
        const { messages: fresh, busy: b } = await listMessages(roomId, lastIdRef.current || undefined);
        if (stop) return;
        if (fresh.length) {
          lastIdRef.current = fresh[fresh.length - 1].id;
          setMessages((prev) => {
            const freshIds = new Set(fresh.map((x) => x.id));
            // 先移除已被服务端确认的乐观副本（临时 id 且角色+内容一致），再追加服务端权威消息
            const kept = prev.filter((x) => !freshIds.has(x.id));
            for (const s of fresh) {
              const idx = kept.findIndex(
                (x) => (x.id.startsWith('local-') || x.id.startsWith('a-')) && x.role === s.role && x.content === s.content,
              );
              if (idx >= 0) kept.splice(idx, 1);
            }
            return [...kept, ...fresh];
          });
        }
        setBusy(b);
      } catch {}
      if (!stop) timer = window.setTimeout(poll, 4000);
    }
    setMessages([]);
    lastIdRef.current = '';
    poll();
    return () => {
      stop = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [roomId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages.length, streaming]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const localId = `local-${Date.now()}`;
    setMessages((p) => [
      ...p,
      { id: localId, room_id: roomId, user_id: me.id, role: 'user', content: text, created_at: Date.now() },
    ]);
    setStreaming('…');
    await sendMessage(roomId, text, {
      onDelta: (t) => setStreaming((s) => (s === '…' ? t : s + t)),
      onDone: (full) => {
        setStreaming('');
        const content = full || '（空回复）';
        setMessages((p) => {
          // 轮询可能已拉回服务端持久化的助手消息（真实 id）；已有同内容则不再插乐观副本
          if (p.some((x) => x.role === 'assistant' && x.content === content)) return p;
          return [
            ...p,
            { id: `a-${Date.now()}`, room_id: roomId, user_id: null, role: 'assistant', content, created_at: Date.now() },
          ];
        });
      },
      onError: (e) => {
        setStreaming('');
        setMessages((p) => [
          ...p,
          { id: `e-${Date.now()}`, room_id: roomId, user_id: null, role: 'system', content: `出错了：${e}`, created_at: Date.now() },
        ]);
      },
    });
  }

  async function inviteMember(e: React.FormEvent) {
    e.preventDefault();
    const email = invite.trim();
    if (!email) return;
    setInviteMsg('');
    try {
      await addMember(roomId, email);
      setInviteMsg(`已邀请 ${email}`);
      setInvite('');
      onMembersChanged();
    } catch (e: any) {
      setInviteMsg(e.message === 'user not found' ? '该邮箱尚未注册' : '邀请失败');
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-[var(--color-line)] px-6 py-3.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-acc)] text-sm font-semibold text-white">
          {initials(roomName)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{roomName}</div>
          <div className="text-xs text-[var(--color-mut)]">
            {members.length} 位成员{busy ? ' · 后台处理中' : ''}
          </div>
        </div>
        <form onSubmit={inviteMember} className="flex items-center gap-2">
          <input
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder="按邮箱邀请"
            className="w-44 rounded-full border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-xs outline-none focus:border-[var(--color-acc)]"
          />
          <button
            type="submit"
            className="rounded-full border border-[var(--color-line)] px-3 py-1.5 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
          >
            邀请
          </button>
        </form>
      </header>
      {inviteMsg && <div className="px-6 pt-2 text-xs text-[var(--color-mut)]">{inviteMsg}</div>}

      <div id="thread" className="thin-scroll flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3">
          {messages.length === 0 && !streaming && (
            <div className="py-12 text-center text-sm text-[var(--color-mut)]">
              在这个房间里说点什么吧
            </div>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} m={m} members={members} me={me} />
          ))}
          {streaming && (
            <div className="flex gap-2.5">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-fg)] text-xs font-semibold text-[var(--color-bg)]">
                助
              </div>
              <div className="flex max-w-[78%] flex-col items-start">
                <div className="mb-0.5 px-1 text-[11px] text-[var(--color-mut)]">助手</div>
                <div className="whitespace-pre-wrap break-words rounded-[18px] rounded-bl-[6px] bg-[var(--color-bot)] px-3.5 py-2.5 text-[var(--color-fg)]">
                  {streaming === '…' ? (
                    <span>
                      <span className="typing-dot" style={{ animationDelay: '0ms' }} />
                      <span className="typing-dot" style={{ animationDelay: '200ms' }} />
                      <span className="typing-dot" style={{ animationDelay: '400ms' }} />
                    </span>
                  ) : (
                    streaming
                  )}
                </div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <footer className="px-6 pb-6">
        <form onSubmit={send} className="mx-auto flex max-w-[760px] items-center gap-2 rounded-3xl border border-[var(--color-line)] bg-[var(--color-bg)] py-2 pl-5 pr-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="发消息…"
            className="flex-1 bg-transparent text-[var(--color-fg)] outline-none"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-fg)] text-[var(--color-bg)] disabled:opacity-40"
          >
            ↑
          </button>
        </form>
      </footer>
    </div>
  );
}
