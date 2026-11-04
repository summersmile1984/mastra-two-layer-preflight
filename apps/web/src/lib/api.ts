/** API 客户端：better-auth + rooms/messages + SSE 流。同源 cookie 会话。 */

export type User = { id: string; email: string; name?: string };
export type Room = {
  id: string;
  name: string;
  created_by: string | null;
  updated_at: number;
  role?: string;
  last_message?: string | null;
  last_message_at?: number | null;
};
export type Member = { user_id: string; role: string; name?: string; email?: string };
export type Message = {
  id: string;
  room_id: string;
  user_id: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: number;
};

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const b = await r.json();
      if (b?.error) msg = b.error;
    } catch {}
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  credentials: 'same-origin',
  body: body === undefined ? undefined : JSON.stringify(body),
});

// ---------- auth ----------

export async function getSession(): Promise<User | null> {
  try {
    // disableRefresh：跳过会话滚动续期写库（并发下会竞态出 500）；超时兜底避免卡死在加载态
    const r = await fetch('/auth/get-session?disableRefresh=true', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const s = await r.json();
    return s?.user?.id ? (s.user as User) : null;
  } catch {
    return null;
  }
}

export async function signIn(email: string, password: string): Promise<User> {
  const r = await fetch('/auth/sign-in/email', jsonInit('POST', { email, password }));
  const s = await j<{ user: User }>(r);
  return s.user;
}

export async function signUp(name: string, email: string, password: string): Promise<User> {
  const r = await fetch('/auth/sign-up/email', jsonInit('POST', { name, email, password }));
  const s = await j<{ user: User }>(r);
  return s.user;
}

export async function signOut(): Promise<void> {
  await fetch('/auth/sign-out', jsonInit('POST')).catch(() => {});
}

// ---------- rooms ----------

export async function listRooms(): Promise<Room[]> {
  const r = await fetch('/rooms', { credentials: 'same-origin' });
  return (await j<{ rooms: Room[] }>(r)).rooms;
}

export async function createRoom(name: string): Promise<Room> {
  const r = await fetch('/rooms', jsonInit('POST', { name }));
  return (await j<{ room: Room }>(r)).room;
}

export async function getRoom(id: string): Promise<{ room: Room; members: Member[] }> {
  const r = await fetch(`/rooms/${id}`, { credentials: 'same-origin' });
  return j(r);
}

export async function addMember(roomId: string, email: string): Promise<void> {
  const r = await fetch(`/rooms/${roomId}/members`, jsonInit('POST', { email }));
  await j(r);
}

export async function listMessages(roomId: string, after?: string): Promise<{ messages: Message[]; busy: boolean }> {
  const q = after ? `?after=${encodeURIComponent(after)}` : '';
  const r = await fetch(`/rooms/${roomId}/messages${q}`, { credentials: 'same-origin' });
  return j(r);
}

// ---------- 聊天流 ----------

export type SseHandlers = {
  onDelta: (text: string) => void;
  onDone: (full: string) => void;
  onError: (err: string) => void;
};

/** POST 发消息并消费 SSE 流（自定义事件：delta / done）。 */
export async function sendMessage(roomId: string, text: string, h: SseHandlers): Promise<void> {
  const r = await fetch(`/rooms/${roomId}/messages`, {
    ...jsonInit('POST', { text }),
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
  });
  if (!r.ok || !r.body) {
    let msg = `HTTP ${r.status}`;
    try {
      const b = await r.json();
      if (b?.error) msg = b.error;
    } catch {}
    h.onError(msg);
    return;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (!line || line === '[DONE]') continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'delta') {
        full += ev.text ?? '';
        h.onDelta(ev.text ?? '');
      } else if (ev.type === 'done') {
        full = ev.text ?? full;
        h.onDone(full);
      } else if (ev.type === 'error') {
        h.onError(ev.message ?? 'error');
      }
    }
  }
}
