import { useEffect, useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Room = { id: string; name: string; role?: string }
export type AgentDef = {
  id: string
  name: string
  description: string
  instructions: string
  model: string
  tools: string[]
  mcp: string[]
  memory: { lastMessages: number }
}
const EMPTY = { id: '', name: '', description: '', instructions: '', model: 'deepseek/deepseek-chat', tools: [] as string[], mcp: [] as string[], memory: { lastMessages: 20 } }
const lbl = 'mb-1 mt-3 block text-xs font-semibold tracking-wide text-mut'

export function download(name: string, data: unknown) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  a.download = name
  a.click()
}

export function BuilderModal({
  open,
  onOpenChange,
  rooms,
  defaultRoomId,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  rooms: Room[]
  defaultRoomId?: string
  onSaved: () => void
}) {
  const [defs, setDefs] = useState<AgentDef[]>([])
  const [models, setModels] = useState<string[]>([])
  const [toolChoices, setToolChoices] = useState<string[]>([])
  const [mcpChoices, setMcpChoices] = useState<{ id: string; name: string }[]>([])
  const [f, setF] = useState<AgentDef>(EMPTY)
  const [roomId, setRoomId] = useState('')
  const [msg, setMsg] = useState('')
  async function load() {
    const r = await api<{ defs: AgentDef[]; models: string[]; toolChoices: string[] }>('/api/agent-defs')
    if (r.ok) {
      setDefs(r.j.defs)
      setModels(r.j.models)
      setToolChoices(r.j.toolChoices)
    }
    const c = await api<{ catalog: { id: string; name: string }[] }>('/api/connections')
    if (c.ok) setMcpChoices(c.j.catalog)
  }
  useEffect(() => {
    if (open) {
      void load()
      setRoomId(defaultRoomId || '')
      setMsg('')
    }
  }, [open, defaultRoomId])
  const toggle = (k: 'tools' | 'mcp', v: string) =>
    setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] })
  async function save() {
    const body = { ...f, roomId: roomId || undefined }
    const r = f.id ? await api<{ def: AgentDef; mounted?: { error?: string } }>(`/api/agent-defs/${f.id}`, body, 'PUT') : await api<{ def: AgentDef; mounted?: { error?: string } }>('/api/agent-defs', body)
    if (!r.ok) return setMsg(r.j.error || '保存失败')
    setF(r.j.def)
    const mounted = roomId ? (r.j.mounted?.error ? `；挂载失败：${r.j.mounted.error}` : `；已挂载到「${rooms.find((x) => x.id === roomId)?.name}」，群里 @${r.j.def.name} 即可派发（L2）`) : ''
    setMsg(`已保存 ${r.j.def.id}${mounted}`)
    void load()
    onSaved()
  }
  async function del(id: string) {
    if (!confirm('删除这个 Agent？会从所有群移除。')) return
    await api(`/api/agent-defs/${id}`, undefined, 'DELETE')
    if (f.id === id) setF(EMPTY)
    void load()
    onSaved()
  }
  async function exp() {
    if (!f.id) return setMsg('先保存再导出')
    const r = await api(`/api/agent-defs/${f.id}/export`)
    if (r.ok) download(`${f.name || f.id}.bot.json`, r.j)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Agent Builder" wide className="max-w-[900px]" onClose={() => onOpenChange(false)}>
        <div className="flex min-h-0 flex-1 overflow-hidden" data-modal="builder">
          <nav className="w-52 shrink-0 overflow-auto border-r border-line bg-panel2 p-2.5">
            <Button size="sm" className="mb-2 w-full" onClick={() => { setF(EMPTY); setMsg('') }}>
              ＋ 新建 Agent
            </Button>
            {defs.length === 0 && <div className="px-2 text-xs text-mut">还没有自建 Agent</div>}
            {defs.map((d) => (
              <div key={d.id} className={cn('group mb-0.5 flex items-center rounded-lg px-2 py-1.5 text-sm', f.id === d.id && 'bg-wash text-acc')}>
                <button type="button" className="flex-1 truncate text-left" onClick={() => { setF(d); setMsg('') }}>
                  🤖 {d.name}
                </button>
                <button type="button" className="text-xs text-mut opacity-0 group-hover:opacity-100" onClick={() => del(d.id)}>
                  ✕
                </button>
              </div>
            ))}
          </nav>
          <div className="flex-1 overflow-auto p-4">
            <h3 className="m-0 text-sm font-semibold">基本信息 {f.id && <small className="text-mut">· {f.id}</small>}</h3>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={lbl}>名称（群里 @ 的名字）</label>
                <Input value={f.name} maxLength={40} placeholder="如：法务顾问" onChange={(e) => setF({ ...f, name: e.target.value })} />
              </div>
              <div>
                <label className={lbl}>简介</label>
                <Input value={f.description} placeholder="一句话定位" onChange={(e) => setF({ ...f, description: e.target.value })} />
              </div>
            </div>
            <label className={lbl}>指令（Instructions）</label>
            <Textarea rows={6} value={f.instructions} placeholder="你是… 回复规则…" onChange={(e) => setF({ ...f, instructions: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={lbl}>模型</label>
                <Select className="w-full" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}>
                  {models.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className={lbl}>记忆（最近消息条数）</label>
                <Input type="number" min={0} max={100} value={f.memory.lastMessages} onChange={(e) => setF({ ...f, memory: { lastMessages: Number(e.target.value) } })} />
              </div>
            </div>
            <label className={lbl}>工具</label>
            <div className="flex flex-wrap gap-2 text-sm">
              {toolChoices.map((t) => (
                <label key={t} className="flex items-center gap-1">
                  <input type="checkbox" checked={f.tools.includes(t)} onChange={() => toggle('tools', t)} /> {t}
                </label>
              ))}
            </div>
            <label className={lbl}>MCP 连接应用</label>
            <div className="flex flex-wrap gap-3 text-sm">
              {mcpChoices.map((t) => (
                <label key={t.id} className="flex items-center gap-1">
                  <input type="checkbox" checked={f.mcp.includes(t.id)} onChange={() => toggle('mcp', t.id)} /> {t.name}
                </label>
              ))}
            </div>
            <label className={lbl}>挂载到群（保存后加入群 agent 列表，作为 L2 专家运行）</label>
            <Select className="w-full" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">不挂载</option>
              {rooms.filter((r) => r.role === 'owner' || r.role === 'admin').map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
            <div className="mt-4 flex items-center gap-2">
              <Button onClick={save}>{f.id ? '保存修改' : '创建 Agent'}</Button>
              <Button variant="outline" onClick={exp}>
                导出 JSON
              </Button>
              <span className="text-[13px] text-mut" data-msg>
                {msg}
              </span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
