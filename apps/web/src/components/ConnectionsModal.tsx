import { useEffect, useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'

type CatalogItem = { id: string; name: string; desc?: string; category?: string }
type Conn = { server_id: string; transport: string; url: string | null; vault_id: string | null; status: string; error: string | null; tools: string[] | null; policy: string; willInject: boolean }
type Secret = { id: string; name: string; masked: string }

export function ConnectionsModal({ open, onOpenChange, onBuilder, onTemplates }: { open: boolean; onOpenChange: (v: boolean) => void; onBuilder?: () => void; onTemplates?: () => void }) {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [conns, setConns] = useState<Record<string, Conn>>({})
  const [note, setNote] = useState('')
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [edit, setEdit] = useState<string | null>(null)
  const [form, setForm] = useState({ url: '', vault_id: '' })

  async function load(probe = false) {
    setLoading(true)
    setErr('')
    const { ok, j } = await api<{ catalog?: CatalogItem[]; connected?: Conn[]; injectNote?: string }>(`/api/connections${probe ? '?probe=1' : ''}`)
    setLoading(false)
    if (!ok) return setErr(j.error || '加载失败')
    setCatalog(j.catalog || [])
    setConns(Object.fromEntries((j.connected || []).map((c) => [c.server_id, c])))
    setNote(j.injectNote || '')
    const v = await api<{ secrets: Secret[] }>('/api/vault')
    if (v.ok) setSecrets(v.j.secrets)
  }
  useEffect(() => {
    if (open) void load()
  }, [open])

  async function connect(id: string) {
    const r = await api('/api/connections', { server_id: id, config: form.url ? { url: form.url } : null, vault_id: form.vault_id || null })
    if (!r.ok) return alert(r.j.error || '连接失败')
    setEdit(null)
    void load(true)
  }
  async function disconnect(id: string) {
    const r = await api(`/api/connections/${id}`, undefined, 'DELETE')
    if (r.ok) void load()
    else alert(r.j.error || '断开失败')
  }
  const injecting = Object.values(conns).filter((c) => c.willInject)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="连接应用" wide onClose={() => onOpenChange(false)}>
        <div className="max-h-[70vh] overflow-auto p-4" data-modal="connect">
          {loading && <div className="text-sm text-mut">加载中…</div>}
          {err && <div className="text-sm text-err">{err}</div>}
          {!err && (
            <>
              <div className="mb-2.5 rounded-xl border border-line bg-panel2 p-3 text-[13px]">
                <b>管家将注入：</b>{' '}
                {injecting.length ? injecting.map((c) => `${c.server_id}${c.tools ? `（${c.tools.length} 个工具）` : ''}`).join('、') : '暂无（需配置 HTTPS MCP URL 且权限允许）'}
                <div className="mt-1 text-xs text-mut">{note}</div>
              </div>
              {catalog.map((a) => {
                const c = conns[a.id]
                return (
                  <div key={a.id} className="border-b border-line py-2.5 last:border-0">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-av-butler text-av-butler-fg">🔌</div>
                      <div className="min-w-0 flex-1">
                        <b className="block font-semibold">
                          {a.name}{' '}
                          {c && <Badge>{c.status === 'ok' ? `✓ ${c.tools?.length ?? 0} tools` : c.status === 'error' ? '连接错误' : c.status === 'needs_config' ? '待配置' : '已连接'}</Badge>}{' '}
                          {c?.willInject && <Badge owner>注入管家</Badge>}
                        </b>
                        <small className="text-mut">{c ? c.error || c.url || a.desc : a.desc || a.category || ''}</small>
                        {c?.vault_id && <small className="ml-2 text-mut">🔐 {secrets.find((s) => s.id === c.vault_id)?.name || c.vault_id}</small>}
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => { setEdit(edit === a.id ? null : a.id); setForm({ url: c?.url || '', vault_id: c?.vault_id || '' }) }}>
                        {c ? '配置' : '连接'}
                      </Button>
                      {c && (
                        <Button variant="ghost" size="sm" onClick={() => disconnect(a.id)}>
                          断开
                        </Button>
                      )}
                    </div>
                    {edit === a.id && (
                      <div className="mt-2 grid grid-cols-[1fr_200px_auto] gap-2 pl-11">
                        <Input placeholder="HTTP MCP URL（https://…/mcp，可留空）" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
                        <Select value={form.vault_id} onChange={(e) => setForm({ ...form, vault_id: e.target.value })}>
                          <option value="">不使用凭据</option>
                          {secrets.map((s) => (
                            <option key={s.id} value={s.id}>
                              🔐 {s.name}
                            </option>
                          ))}
                        </Select>
                        <Button size="sm" onClick={() => connect(a.id)}>
                          保存
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
              <div className="mt-3 flex gap-2 border-t border-line pt-3">
                <Button variant="outline" size="sm" onClick={() => load(true)}>
                  检测工具（tools/list）
                </Button>
                <div className="flex-1" />
                {onBuilder && (
                  <Button variant="outline" size="sm" onClick={onBuilder}>
                    🛠 Agent Builder
                  </Button>
                )}
                {onTemplates && (
                  <Button variant="outline" size="sm" onClick={onTemplates}>
                    🧩 Bot 模板
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
