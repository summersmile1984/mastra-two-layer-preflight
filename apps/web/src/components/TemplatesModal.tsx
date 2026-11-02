import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'

type Tpl = { schemaVersion: 1; id?: string; agent: { name: string; description?: string; instructions: string; model?: string }; tools?: string[]; mcp?: string[]; memory?: { lastMessages?: number } }
type Room = { id: string; name: string; role?: string }

export function TemplatesModal({ open, onOpenChange, rooms, defaultRoomId, onImported }: { open: boolean; onOpenChange: (v: boolean) => void; rooms: Room[]; defaultRoomId?: string; onImported: () => void }) {
  const [tpls, setTpls] = useState<Tpl[]>([])
  const [roomId, setRoomId] = useState('')
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    setRoomId(defaultRoomId || '')
    setMsg('')
    void api<{ templates: Tpl[] }>('/api/templates').then((r) => r.ok && setTpls(r.j.templates))
  }, [open, defaultRoomId])
  async function imp(template: Tpl) {
    const r = await api<{ def: { id: string; name: string }; mounted?: { error?: string } }>('/api/templates/import', { template, roomId: roomId || undefined })
    if (!r.ok) return setMsg(r.j.error || '导入失败')
    setMsg(`已导入「${r.j.def.name}」(${r.j.def.id})${roomId ? (r.j.mounted?.error ? `，挂载失败：${r.j.mounted.error}` : '，已加入群') : ''}`)
    onImported()
  }
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      await imp(JSON.parse(await file.text()))
    } catch {
      setMsg('不是有效的 JSON')
    }
    e.target.value = ''
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Bot 模板" wide onClose={() => onOpenChange(false)}>
        <div className="max-h-[75vh] overflow-auto p-4" data-modal="templates">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-sm text-mut">导入到群：</span>
            <Select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">仅创建 Agent（不挂载）</option>
              {rooms.filter((r) => r.role === 'owner' || r.role === 'admin').map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
            <div className="flex-1" />
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              从文件导入…
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {tpls.map((t) => (
              <div key={t.id} className="flex flex-col rounded-xl border border-line bg-panel2 p-3 shadow-[var(--shadow-soft)]">
                <div className="mb-1 text-2xl">🧩</div>
                <b>{t.agent.name}</b>
                <small className="mb-2 flex-1 text-mut">{t.agent.description}</small>
                <div className="mb-2 flex flex-wrap gap-1">
                  {(t.mcp || []).map((m) => (
                    <Badge key={m}>MCP·{m}</Badge>
                  ))}
                  <Badge>记忆 {t.memory?.lastMessages ?? 20}</Badge>
                </div>
                <Button size="sm" onClick={() => imp(t)}>
                  导入
                </Button>
              </div>
            ))}
          </div>
          <div className="mt-3 min-h-[18px] text-[13px] text-ok" data-msg>
            {msg}
          </div>
          <p className="text-xs text-mut">模板格式：{'{ schemaVersion: 1, agent: { name, description, instructions, model }, tools?, mcp?, memory?, roomDefaults? }'}；Agent Builder 可导出同格式 JSON。</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
