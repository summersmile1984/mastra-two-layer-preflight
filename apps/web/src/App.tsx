import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthScreen } from '@/components/AuthScreen'
import { ConnectionsModal } from '@/components/ConnectionsModal'
import { SettingsModal, type SettingsTab } from '@/components/SettingsModal'
import { BuilderModal } from '@/components/BuilderModal'
import { TemplatesModal } from '@/components/TemplatesModal'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api, msgText, unagent, unturn } from '@/lib/api'
import { cn } from '@/lib/utils'

type User = { id: string; email: string; name?: string }
type Room = { id: string; name: string; role: string }
type Invite = { id: string; name: string }
type Agent = { id: string; name: string; desc?: string }
type Cur = { type: 'dm' } | { type: 'room'; id: string }
type ChatMsg = {
  who: string
  text: string
  mine: boolean
  bot: boolean
  agentId?: string
  typing?: boolean
}

const DEFAULT_BUTLER = '管家 Orchestrator'
const FALLBACK_NAMES: Record<string, string> = {
  orchestrator: DEFAULT_BUTLER,
  researcher: '调研专家',
  coder: '工程师',
}

function roleLabel(r?: string) {
  return r === 'owner' ? '群主' : r === 'admin' ? '管理员' : '成员'
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [authed, setAuthed] = useState(false)
  const [me, setMe] = useState<User | null>(null)
  const [butlerName, setButlerName] = useState(DEFAULT_BUTLER)
  const [rooms, setRooms] = useState<Room[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [cur, setCur] = useState<Cur | null>(null)
  const [catalog, setCatalog] = useState<Agent[]>([])
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [newRoom, setNewRoom] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const [connOpen, setConnOpen] = useState(false)
  const [setOpen, setSetOpen] = useState(false)
  const [setTab, setSetTab] = useState<SettingsTab>('general')
  const [builderOpen, setBuilderOpen] = useState(false)
  const [tplOpen, setTplOpen] = useState(false)
  const loadDetailRef = useRef<((id: string) => unknown) | null>(null)
  const [detail, setDetail] = useState<{
    members: Array<{ user_id: string; name?: string; email?: string; role: string }>
    agents: Array<{ agent_id: string }>
    pendingInvites: Array<{ id: string; email: string; created_at: string }>
    role?: string
    roomName?: string
  } | null>(null)
  const [invEmail, setInvEmail] = useState('')
  const [invMsg, setInvMsg] = useState('')
  const [addAgentId, setAddAgentId] = useState('')
  const [tasks, setTasks] = useState<Array<{ task_id: string; expert_id: string; state: string; created_at: number }>>([])
  const [renameIn, setRenameIn] = useState('')
  const [confirmKey, setConfirmKey] = useState('')
  const [roomMsg, setRoomMsg] = useState('')
  const msgsRef = useRef<HTMLDivElement>(null)
  const curKey = useMemo(() => JSON.stringify(cur), [cur])

  const aName = useCallback(
    (id: string) => {
      const hit = catalog.find((a) => a.id === id)
      if (id === 'orchestrator') return butlerName
      return hit?.name || FALLBACK_NAMES[id] || id
    },
    [catalog, butlerName],
  )

  const reloadAgents = useCallback(async () => {
    const c = await api<{ agents?: Agent[] }>('/api/agents')
    if (c.ok) setCatalog(c.j.agents || [])
    if (cur?.type === 'room') void loadDetailRef.current?.(cur.id)
  }, [cur])

  const applyButler = useCallback((n?: string | null) => {
    const name = (n && String(n).trim()) || DEFAULT_BUTLER
    setButlerName(name)
    document.title = `${name} · 群聊`
  }, [])

  const loadRooms = useCallback(async () => {
    const { ok, j } = await api<{ rooms?: Room[]; invites?: Invite[] }>('/api/rooms')
    if (!ok) return
    setRooms(j.rooms || [])
    setInvites(j.invites || [])
  }, [])

  const renderFromApi = useCallback(
    (raw: Array<{ role: string; content: unknown }>, current: Cur | null, user: User | null, bName: string) => {
      const list = raw.filter((m) => m.role === 'user' || m.role === 'assistant')
      if (!list.length) return [] as ChatMsg[]
      return list.map((m) => {
        const t = msgText(m.content)
        if (m.role === 'assistant') {
          const g = unagent(t)
          return {
            who: `🤖 ${aName(g.id)}`,
            text: g.text,
            mine: false,
            bot: true,
            agentId: g.id,
          }
        }
        const u = unturn(t)
        const mine =
          current?.type === 'dm' ||
          u.uid === user?.id ||
          (!u.uid && u.who === (user?.name || user?.email))
        return {
          who: `👤 ${u.who || user?.name || '我'}`,
          text: u.text,
          mine,
          bot: false,
        }
      })
    },
    [aName],
  )

  const loadMsgs = useCallback(
    async (current: Cur | null) => {
      if (!current) return
      const key = JSON.stringify(current)
      setLoadingMsgs(true)
      const url = current.type === 'dm' ? '/api/butler/messages' : `/api/rooms/${current.id}/messages`
      const { ok, j } = await api<{ messages?: Array<{ role: string; content: unknown }> }>(url)
      if (key !== JSON.stringify(current) && key !== curKey) {
        /* stale guard best-effort */
      }
      setLoadingMsgs(false)
      if (!ok) {
        setMsgs([])
        return
      }
      setMsgs(renderFromApi(j.messages || [], current, me, butlerName))
      requestAnimationFrame(() => {
        if (msgsRef.current) msgsRef.current.scrollTop = 1e9
      })
    },
    [curKey, me, butlerName, renderFromApi],
  )

  const loadDetail = useCallback(
    async (id: string) => {
      const { ok, j } = await api<{
        room: { name: string }
        role: string
        members: Array<{ user_id: string; name?: string; email?: string; role: string }>
        agents?: Array<{ agent_id: string }>
        pendingInvites?: Array<{ id: string; email: string; created_at: string }>
      }>(`/api/rooms/${id}`)
      if (!ok) return
      setDetail({
        members: j.members || [],
        agents: j.agents || [],
        pendingInvites: j.pendingInvites || [],
        role: j.role,
        roomName: j.room.name,
      })
    },
    [],
  )
  loadDetailRef.current = loadDetail

  const loadTasks = useCallback(async (id: string) => {
    const r = await api<{ tasks?: Array<{ task_id: string; expert_id: string; state: string; created_at: number }> }>(
      `/api/rooms/${id}/tasks`,
    )
    if (r.ok) setTasks(r.j.tasks || [])
    return r.ok ? r.j.tasks || [] : []
  }, [])

  const pendingTasks = tasks.filter((t) => Date.now() - Number(t.created_at) < 600_000).filter((t) => t.state === 'queued' || t.state === 'working' || t.state === 'running' || t.state === 'claimed' || t.state === 'submitted')

  // 有专家任务进行中：每 3s 刷新状态与消息，直到全部完成（异步 L2，不阻塞输入）
  useEffect(() => {
    if (!cur || cur.type !== 'room' || pendingTasks.length === 0) return
    const id = cur.id
    const t = setTimeout(async () => {
      const list = await loadTasks(id)
      const still = list.filter((x) => Date.now() - Number(x.created_at) < 600_000 && ['queued', 'working', 'running', 'claimed', 'submitted'].includes(x.state))
      if (still.length < pendingTasks.length) void loadMsgs(cur)
    }, 3000)
    return () => clearTimeout(t)
  }, [cur, tasks, pendingTasks.length, loadTasks, loadMsgs])

  const openDM = useCallback(() => {
    setCur({ type: 'dm' })
    location.hash = 'dm'
    setPanelOpen(false)
    setDetail(null)
  }, [])

  const openRoom = useCallback((id: string) => {
    setCur({ type: 'room', id })
    location.hash = id
  }, [])

  const boot = useCallback(async () => {
    const r = await fetch('/api/me', { credentials: 'include' })
    if (!r.ok) {
      setAuthed(false)
      setReady(true)
      return
    }
    const meJ = await r.json()
    setMe(meJ.user)
    applyButler(meJ.butler?.name || meJ.butler?.display_name)
    setAuthed(true)
    const c = await api<{ agents?: Agent[] }>('/api/agents')
    if (c.ok) setCatalog(c.j.agents || [])
    await loadRooms()
    setReady(true)
  }, [applyButler, loadRooms])

  useEffect(() => {
    void boot()
  }, [boot])

  // after rooms load + ready, pick view from hash
  useEffect(() => {
    if (!authed || !ready) return
    const want = location.hash.slice(1)
    if (want && want !== 'dm' && rooms.find((x) => x.id === want)) openRoom(want)
    else if (!want && rooms[0]) openRoom(rooms[0].id)
    else openDM()
    // only on first auth ready
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, ready])

  useEffect(() => {
    if (!cur) return
    void loadMsgs(cur)
    if (cur.type === 'room') {
      void loadDetail(cur.id)
      void loadTasks(cur.id)
      setRenameIn('')
      setConfirmKey('')
      setRoomMsg('')
    } else setTasks([])
  }, [cur, loadMsgs, loadDetail, loadTasks])

  useEffect(() => {
    if (msgsRef.current) msgsRef.current.scrollTop = 1e9
  }, [msgs])

  async function signOut() {
    await api('/api/auth/sign-out', {})
    setMe(null)
    setAuthed(false)
    setCur(null)
    setMsgs([])
  }

  async function mkRoom() {
    const n = newRoom.trim()
    if (!n) return
    const r = await api<{ room: { id: string } }>('/api/rooms', { name: n })
    if (r.ok) {
      setNewRoom('')
      await loadRooms()
      openRoom(r.j.room.id)
    }
  }

  async function accept(id: string) {
    const r = await api<{ room_id: string }>(`/api/rooms/invites/${id}/accept`, {})
    if (r.ok) {
      await loadRooms()
      openRoom(r.j.room_id)
    }
  }

  async function invite() {
    if (!invEmail.trim() || !cur || cur.type !== 'room') return
    const r = await api(`/api/rooms/${cur.id}/invites`, { email: invEmail.trim() })
    setInvMsg(r.ok ? `已邀请 ${invEmail.trim()}（对方用该邮箱登录后接受）` : r.j.error || '失败')
    if (r.ok) {
      setInvEmail('')
      loadDetail(cur.id)
    }
  }

  async function decline(id: string) {
    await api(`/api/rooms/invites/${id}/decline`, {})
    await loadRooms()
  }

  function armed(key: string) {
    if (confirmKey === key) {
      setConfirmKey('')
      return true
    }
    setConfirmKey(key)
    setTimeout(() => setConfirmKey((k) => (k === key ? '' : k)), 4000)
    return false
  }

  async function roomCall(path: string, body: unknown, method: string, okMsg: string) {
    const r = await api(path, body, method)
    setRoomMsg(r.ok ? okMsg : `失败：${r.j.error || r.status}`)
    return r.ok
  }

  async function renameRoom() {
    if (!cur || cur.type !== 'room' || !renameIn.trim()) return
    if (await roomCall(`/api/rooms/${cur.id}`, { name: renameIn.trim() }, 'PATCH', '已改名')) {
      setRenameIn('')
      await loadRooms()
      void loadDetail(cur.id)
    }
  }

  async function deleteRoom() {
    if (!cur || cur.type !== 'room' || !armed('del')) return
    if (await roomCall(`/api/rooms/${cur.id}`, undefined, 'DELETE', '已解散')) {
      await loadRooms()
      openDM()
    }
  }

  async function leaveRoom() {
    if (!cur || cur.type !== 'room' || !armed('leave')) return
    if (await roomCall(`/api/rooms/${cur.id}/leave`, {}, 'POST', '已退出')) {
      await loadRooms()
      openDM()
    }
  }

  async function removeMember(uid: string) {
    if (!cur || cur.type !== 'room' || !armed('rm:' + uid)) return
    if (await roomCall(`/api/rooms/${cur.id}/members/${uid}`, undefined, 'DELETE', '已移出')) void loadDetail(cur.id)
  }

  async function setMemberRole(uid: string, role: 'admin' | 'member') {
    if (!cur || cur.type !== 'room') return
    if (await roomCall(`/api/rooms/${cur.id}/members/${uid}`, { role }, 'PATCH', '角色已更新')) void loadDetail(cur.id)
  }

  async function revokeInvite(id: string) {
    if (!cur || cur.type !== 'room') return
    if (await roomCall(`/api/rooms/${cur.id}/invites/${id}`, undefined, 'DELETE', '邀请已撤销')) void loadDetail(cur.id)
  }

  async function removeAgent(id: string) {
    if (!cur || cur.type !== 'room') return
    if (await roomCall(`/api/rooms/${cur.id}/agents/${id}`, undefined, 'DELETE', '已移除 Agent')) void loadDetail(cur.id)
  }

  function mention(id: string) {
    const n = id === 'orchestrator' ? butlerName : aName(id)
    setDraft((d) => (d && !d.endsWith(' ') ? d + ' ' : d) + `@${n} `)
  }

  async function addAgent() {
    if (!addAgentId || !cur || cur.type !== 'room') return
    const r = await api(`/api/rooms/${cur.id}/agents`, { agentId: addAgentId })
    if (r.ok) {
      setAddAgentId('')
      loadDetail(cur.id)
    }
  }

  async function send() {
    const t = draft.trim()
    if (!t || busy || !cur || !me) return
    setBusy(true)
    setDraft('')
    setMsgs((prev) => [
      ...prev.filter((m) => !m.typing),
      { who: `👤 ${me.name || '我'}`, text: t, mine: true, bot: false },
      { who: 'agent 思考中', text: '', mine: false, bot: true, agentId: 'orchestrator', typing: true },
    ])
    const key = JSON.stringify(cur)
    const url = cur.type === 'dm' ? '/api/butler/messages' : `/api/rooms/${cur.id}/messages`
    const r = await api<{ dispatched?: Array<{ expertId: string }> }>(url, { text: t })
    setBusy(false)
    if (key !== JSON.stringify(cur)) return
    if (!r.ok) {
      setMsgs((prev) => [
        ...prev.filter((m) => !m.typing),
        {
          who: '系统',
          text: `发送失败：${r.j.detail || r.j.error || r.status}`,
          mine: false,
          bot: false,
        },
      ])
      return
    }
    await loadMsgs(cur)
    const disp = r.j.dispatched || []
    if (disp.length && cur.type === 'room') void loadTasks(cur.id)
  }

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-bg text-mut">加载中…</div>
    )
  }

  if (!authed) {
    return (
      <AuthScreen
        onAuthed={() => {
          void boot()
        }}
      />
    )
  }

  const roomMeta = cur?.type === 'room' ? rooms.find((r) => r.id === cur.id) : null
  const title =
    cur?.type === 'dm'
      ? `🤖 ${butlerName} 私聊`
      : `💬 ${detail?.roomName || roomMeta?.name || '群聊'}`
  const headRole = cur?.type === 'room' ? roleLabel(detail?.role || roomMeta?.role) : ''
  const headAgents =
    cur?.type === 'dm'
      ? ['orchestrator']
      : (detail?.agents || [{ agent_id: 'orchestrator' }]).map((a) => a.agent_id)
  const placeholder =
    cur?.type === 'dm'
      ? `私聊${butlerName}… Enter 发送`
      : `在群里发言，@${butlerName} @调研 @工程师 点名回复（默认管家）… Enter 发送`
  const isDm = cur?.type === 'dm'
  const admin = detail?.role === 'owner' || detail?.role === 'admin'
  const haveAgents = new Set((detail?.agents || []).map((a) => a.agent_id))
  const leftAgents = catalog.filter((a) => !haveAgents.has(a.id))

  return (
    <div
      className={cn(
        'grid h-full bg-bg',
        isDm ? 'grid-cols-[260px_1fr]' : 'grid-cols-[260px_1fr_260px]',
      )}
    >
      <aside className="flex min-h-0 flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-2.5 border-b border-line p-3.5">
          <Avatar name={me?.name || me?.email} role="me" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{me?.name || me?.email}</div>
            <small className="block truncate text-mut">{me?.email}</small>
          </div>
          <Button variant="ghost" size="sm" onClick={signOut}>
            退出
          </Button>
        </div>
        <div className="px-3.5 pb-1.5 pt-3.5 text-[11px] font-semibold uppercase tracking-wide text-mut">
          管家私聊
        </div>
        <div className="px-2">
          <button
            type="button"
            className={cn(
              'mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-panel2',
              isDm && 'bg-wash text-acc',
            )}
            onClick={openDM}
          >
            <Avatar name={butlerName} role="butler" size="sm" />
            <span className="truncate font-medium">{butlerName}</span>
          </button>
        </div>
        {invites.length > 0 && (
          <div>
            <div className="px-3.5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-mut">
              待处理邀请
            </div>
            {invites.map((i) => (
              <div
                key={i.id}
                className="mx-2.5 my-1 flex items-center gap-2 rounded-[10px] border border-dashed border-amber-400 bg-amber-50 px-2.5 py-2 text-[13px]"
              >
                <span className="flex-1">邀请你加入「{i.name}」</span>
                <Button size="sm" className="bg-ok hover:bg-ok/90" onClick={() => accept(i.id)}>
                  接受
                </Button>
                <Button size="sm" variant="ghost" onClick={() => decline(i.id)}>
                  拒绝
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between px-3.5 pb-1.5 pt-3.5 text-[11px] font-semibold uppercase tracking-wide text-mut">
          <span>群聊</span>
          <span>{rooms.length || ''}</span>
        </div>
        <div className="flex gap-1.5 px-2.5 py-1.5">
          <Input
            value={newRoom}
            onChange={(e) => setNewRoom(e.target.value)}
            placeholder="新建群名称"
            className="h-8 shadow-none"
            onKeyDown={(e) => e.key === 'Enter' && mkRoom()}
          />
          <Button size="sm" onClick={mkRoom}>
            新建群
          </Button>
        </div>
        <div className="flex-1 overflow-auto px-2 pb-2.5">
          {rooms.length === 0 && (
            <div className="px-2.5 py-2 text-[13px] text-mut">还没有群，新建一个吧</div>
          )}
          {rooms.map((r) => (
            <button
              key={r.id}
              type="button"
              className={cn(
                'mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-[10px] px-2.5 py-2 text-left hover:bg-panel2',
                cur?.type === 'room' && cur.id === r.id && 'bg-wash text-acc',
              )}
              onClick={() => openRoom(r.id)}
            >
              <span>💬</span>
              <span className="flex-1 truncate font-medium">{r.name}</span>
              <Badge owner={r.role === 'owner'}>{roleLabel(r.role)}</Badge>
            </button>
          ))}
        </div>
        <div className="mt-auto flex flex-col gap-1.5 border-t border-line p-2.5">
          <Button variant="outline" className="w-full justify-start" onClick={() => setConnOpen(true)}>
            🔌 连接应用
          </Button>
          <div className="flex gap-1.5">
            <Button variant="outline" className="flex-1 justify-start" onClick={() => setBuilderOpen(true)}>
              🛠 Agent Builder
            </Button>
            <Button variant="outline" className="flex-1 justify-start" onClick={() => setTplOpen(true)}>
              🧩 Bot 模板
            </Button>
          </div>
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              setSetTab('general')
              setSetOpen(true)
            }}
          >
            ⚙ 设置
          </Button>
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col bg-bg">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line bg-panel px-[18px] py-3">
          <h2 className="m-0 text-base font-semibold">{title}</h2>
          {headRole && <Badge owner={headRole === '群主'}>{headRole}</Badge>}
          {headAgents.map((a) => (
            <span
              key={a}
              className="rounded-lg bg-av-butler px-2 py-0.5 text-xs font-medium text-av-butler-fg"
            >
              🤖 {aName(a)}
            </span>
          ))}
          {!isDm && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto md:hidden"
              onClick={() => setPanelOpen((v) => !v)}
            >
              成员
            </Button>
          )}
        </div>
        <div ref={msgsRef} className="flex-1 overflow-auto p-[18px]">
          {loadingMsgs && <div className="py-16 text-center text-mut">加载中…</div>}
          {!loadingMsgs && msgs.length === 0 && (
            <div className="py-16 text-center text-mut">
              {isDm ? (
                <>
                  👋 和{butlerName}打个招呼吧
                  <br />
                  <small>私聊内容只有你和{butlerName}可见</small>
                </>
              ) : (
                <>
                  💬 群里还没有消息
                  <br />
                  <small>发一条消息，管家会在群里回复；邀请朋友一起聊</small>
                </>
              )}
            </div>
          )}
          {msgs.map((m, i) => (
            <div
              key={i}
              className={cn('my-3.5 flex max-w-[78%] gap-2.5', m.mine && 'ml-auto flex-row-reverse')}
            >
              <Avatar
                name={
                  m.bot
                    ? aName(m.agentId || 'orchestrator')
                    : m.who.replace(/^🤖 |^👤 /, '')
                }
                role={
                  m.bot
                    ? m.agentId && m.agentId !== 'orchestrator'
                      ? 'expert'
                      : 'butler'
                    : m.mine
                      ? 'me'
                      : 'user'
                }
              />
              <div>
                <div className={cn('mb-1 text-xs font-medium text-mut', m.mine && 'text-right')}>
                  {m.who}
                </div>
                <div
                  className={cn(
                    'whitespace-pre-wrap break-words rounded-[16px] border border-transparent px-3.5 py-2.5 shadow-[var(--shadow-soft)]',
                    m.mine ? 'bg-me text-[#1e3a8a]' : 'bg-bot text-fg',
                  )}
                >
                  {m.typing ? (
                    <span className="inline-flex gap-1">
                      <span className="h-1.5 w-1.5 animate-[typing-dot_1s_infinite] rounded-full bg-mut" />
                      <span className="h-1.5 w-1.5 animate-[typing-dot_1s_infinite] rounded-full bg-mut [animation-delay:.2s]" />
                      <span className="h-1.5 w-1.5 animate-[typing-dot_1s_infinite] rounded-full bg-mut [animation-delay:.4s]" />
                    </span>
                  ) : (
                    m.text
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        {!isDm && (pendingTasks.length > 0 || headAgents.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line bg-panel px-[18px] pt-2" data-testid="room-assist">
            {pendingTasks.map((t) => (
              <span
                key={t.task_id}
                data-testid="expert-pending"
                className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
              >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                {aName(t.expert_id)} 后台处理中（L2 异步）
              </span>
            ))}
            <span className="text-xs text-mut">点名：</span>
            {headAgents.map((a) => (
              <button
                key={a}
                type="button"
                data-testid={`mention-${a}`}
                className="rounded-full border border-line bg-panel2 px-2 py-0.5 text-xs hover:bg-wash hover:text-acc"
                onClick={() => mention(a)}
              >
                @{aName(a)}
              </button>
            ))}
          </div>
        )}
        <div className={cn('flex gap-2 bg-panel px-[18px] py-3', (isDm || headAgents.length === 0) && 'border-t border-line')}>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <Button disabled={busy} onClick={() => void send()}>
            发送
          </Button>
        </div>
      </main>

      {!isDm && (
        <aside
          className={cn(
            'overflow-auto border-l border-line bg-panel px-1.5 py-1',
            'max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-10 max-md:w-[280px] max-md:shadow-lg',
            panelOpen ? 'max-md:block' : 'max-md:hidden',
          )}
        >
          <div className="flex items-center justify-between px-3.5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-mut">
            <span>成员</span>
            <span>{detail?.members.length || ''}</span>
          </div>
          {(detail?.members || []).map((m) => (
            <div key={m.user_id} className="flex items-center gap-2 px-2 py-1.5">
              <Avatar name={m.name || m.email} role={m.user_id === me?.id ? 'me' : 'user'} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  👤 {m.name || m.email || m.user_id}
                  {m.user_id === me?.id && <small className="text-mut"> (我)</small>}
                </div>
                <small className="block truncate text-mut">{m.email || ''}</small>
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <Badge owner={m.role === 'owner'}>{roleLabel(m.role)}</Badge>
                {m.role !== 'owner' && m.user_id !== me?.id && (detail?.role === 'owner' || (detail?.role === 'admin' && m.role === 'member')) && (
                  <span className="flex gap-1">
                    {detail?.role === 'owner' && (
                      <button type="button" className="text-[11px] text-acc hover:underline" onClick={() => setMemberRole(m.user_id, m.role === 'admin' ? 'member' : 'admin')}>
                        {m.role === 'admin' ? '设为成员' : '设为管理员'}
                      </button>
                    )}
                    <button type="button" className="text-[11px] text-err hover:underline" onClick={() => removeMember(m.user_id)}>
                      {confirmKey === 'rm:' + m.user_id ? '确认移出?' : '移出'}
                    </button>
                  </span>
                )}
              </div>
            </div>
          ))}
          <div className="px-3.5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-mut">
            Agent
          </div>
          {(detail?.agents || []).map((a) => (
            <div key={a.agent_id} className="flex items-center gap-2 px-2 py-1.5">
              <Avatar
                name={aName(a.agent_id)}
                role={a.agent_id === 'orchestrator' ? 'butler' : 'expert'}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate">{aName(a.agent_id)}</div>
                <small className="text-mut">
                  {a.agent_id === 'orchestrator' ? 'L1 管家' : 'L2 专家 · 异步'}
                </small>
              </div>
              {admin && a.agent_id !== 'orchestrator' && (
                <button type="button" className="text-[11px] text-err hover:underline" onClick={() => removeAgent(a.agent_id)}>
                  移除
                </button>
              )}
            </div>
          ))}
          {(!detail?.agents || detail.agents.length === 0) && (
            <div className="px-2 py-1.5 text-mut">无</div>
          )}
          {admin && leftAgents.length > 0 && (
            <div className="flex items-center gap-2 px-2 py-1.5">
              <select
                className="h-9 flex-1 rounded-lg border border-line bg-white px-2 text-sm"
                value={addAgentId}
                onChange={(e) => setAddAgentId(e.target.value)}
              >
                <option value="">选择 Agent</option>
                {leftAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={addAgent}>
                添加
              </Button>
            </div>
          )}
          {admin && (
            <>
              <div className="px-3.5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-mut">
                邀请成员
              </div>
              <div className="flex flex-col gap-1.5 px-2 py-1.5">
                <Input
                  type="email"
                  placeholder="对方邮箱"
                  value={invEmail}
                  onChange={(e) => setInvEmail(e.target.value)}
                />
                <Button onClick={invite}>发送邀请</Button>
                <span className="text-xs text-mut">{invMsg}</span>
              </div>
              <div className="px-3.5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-mut">
                待接受邀请
              </div>
              {(detail?.pendingInvites || []).map((i, idx) => (
                <div key={idx} className="flex items-center gap-2 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div>✉️ {i.email}</div>
                    <small className="text-mut">{new Date(i.created_at).toLocaleString()}</small>
                  </div>
                  <button type="button" className="text-[11px] text-err hover:underline" onClick={() => revokeInvite(i.id)}>
                    撤销
                  </button>
                </div>
              ))}
              {(detail?.pendingInvites || []).length === 0 && (
                <div className="px-2 py-1.5 text-xs text-mut">无</div>
              )}
            </>
          )}
          <div className="px-3.5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-mut">
            群设置
          </div>
          <div className="flex flex-col gap-1.5 px-2 py-1.5 pb-4" data-testid="room-settings">
            {admin && (
              <div className="flex gap-1.5">
                <Input
                  placeholder="新群名"
                  value={renameIn}
                  onChange={(e) => setRenameIn(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && renameRoom()}
                  className="h-8"
                />
                <Button size="sm" variant="outline" onClick={renameRoom}>
                  改名
                </Button>
              </div>
            )}
            {detail?.role === 'owner' ? (
              <Button size="sm" variant="outline" className="text-err" onClick={deleteRoom}>
                {confirmKey === 'del' ? '再次点击确认解散' : '解散群聊'}
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="text-err" onClick={leaveRoom}>
                {confirmKey === 'leave' ? '再次点击确认退出' : '退出群聊'}
              </Button>
            )}
            {roomMsg && <span className="text-xs text-mut">{roomMsg}</span>}
          </div>
        </aside>
      )}

      <ConnectionsModal
        open={connOpen}
        onOpenChange={setConnOpen}
        onBuilder={() => {
          setConnOpen(false)
          setBuilderOpen(true)
        }}
        onTemplates={() => {
          setConnOpen(false)
          setTplOpen(true)
        }}
      />
      <BuilderModal open={builderOpen} onOpenChange={setBuilderOpen} rooms={rooms} defaultRoomId={cur?.type === 'room' ? cur.id : undefined} onSaved={reloadAgents} />
      <TemplatesModal open={tplOpen} onOpenChange={setTplOpen} rooms={rooms} defaultRoomId={cur?.type === 'room' ? cur.id : undefined} onImported={reloadAgents} />
      <SettingsModal
        open={setOpen}
        onOpenChange={setSetOpen}
        tab={setTab}
        onTabChange={setSetTab}
        me={me}
        butlerName={butlerName}
        onButlerSaved={(n) => {
          applyButler(n)
          if (cur?.type === 'dm') void loadMsgs(cur)
        }}
        onAccountSaved={(n) => setMe((m) => (m ? { ...m, name: n } : m))}
        onSignOut={() => {
          setSetOpen(false)
          void signOut()
        }}
      />
    </div>
  )
}
