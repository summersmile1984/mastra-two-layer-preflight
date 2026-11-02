import { useEffect, useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PermissionsPane, SchedulesPane, UpdatePane, UsagePane, VaultPane } from '@/components/SettingsPanes'

type User = { id: string; email: string; name?: string }
export type SettingsTab = 'general' | 'computer' | 'permissions' | 'schedules' | 'vault' | 'usage' | 'update'
type Tab = SettingsTab

const DEFAULT_BUTLER = '管家 Orchestrator'

export function SettingsModal({
  open,
  onOpenChange,
  tab,
  onTabChange,
  me,
  butlerName,
  onButlerSaved,
  onAccountSaved,
  onSignOut,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  tab: Tab
  onTabChange: (t: Tab) => void
  me: User | null
  butlerName: string
  onButlerSaved: (name: string) => void
  onAccountSaved?: (name: string) => void
  onSignOut?: () => void
}) {
  const [nameIn, setNameIn] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [acctName, setAcctName] = useState('')
  const [acctMsg, setAcctMsg] = useState('')
  const [device, setDevice] = useState<{
    l2?: { online?: boolean; label?: string; note?: string; status?: string; queued?: number }
    devices?: Array<{ name: string; detail?: string; kind?: string; online?: boolean }>
  } | null>(null)

  useEffect(() => {
    if (open && tab === 'general') {
      setNameIn(butlerName === DEFAULT_BUTLER ? '' : butlerName)
      setSaveMsg('')
      setAcctName(me?.name || '')
      setAcctMsg('')
    }
  }, [open, tab, butlerName, me])

  async function saveAcct() {
    const v = acctName.trim()
    if (!v || v.length > 64) {
      setAcctMsg('请输入 1–64 个字符')
      return
    }
    const r = await api('/api/auth/update-user', { name: v }, 'POST')
    setAcctMsg(r.ok ? '已保存' : r.j.message || r.j.error || `失败 ${r.status}`)
    if (r.ok) onAccountSaved?.(v)
  }

  useEffect(() => {
    if (open && tab === 'computer') {
      void (async () => {
        const { ok, j } = await api('/api/device')
        setDevice(ok ? (j as never) : { l2: { online: false, label: '未知' }, devices: [] })
      })()
    }
  }, [open, tab])

  async function saveButler() {
    const v = nameIn.trim()
    if (!v || v.length > 32) {
      setSaveMsg('请输入 1–32 个字符')
      return
    }
    const r = await api<{ butler?: { name?: string; display_name?: string } }>(
      '/api/butler/profile',
      { display_name: v },
      'PATCH',
    )
    if (!r.ok) {
      setSaveMsg(r.j.error || `失败 ${r.status}`)
      return
    }
    const n = r.j.butler?.name || r.j.butler?.display_name || v
    onButlerSaved(n)
    setSaveMsg('已保存')
  }

  const nav: { id: Tab; label: string }[] = [
    { id: 'general', label: '通用' },
    { id: 'computer', label: '电脑' },
    { id: 'permissions', label: '权限' },
    { id: 'schedules', label: '定时任务' },
    { id: 'vault', label: '保险库' },
    { id: 'usage', label: '用量与账单' },
    { id: 'update', label: '更新' },
  ]

  const l2 = device?.l2 || { online: false, label: '未知', note: '' }
  const devices = device?.devices || []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="设置" wide onClose={() => onOpenChange(false)}>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <nav className="w-40 shrink-0 overflow-auto border-r border-line bg-panel2 p-2.5">
            {nav.map((n, i) => (
              <button
                key={i}
                type="button"
                data-tab={n.id}
                className={cn(
                  'mb-0.5 block w-full rounded-lg px-2.5 py-2 text-left text-sm font-medium text-mut disabled:cursor-not-allowed disabled:opacity-35',
                  tab === n.id && 'bg-wash text-acc',
                )}
                onClick={() => onTabChange(n.id)}
              >
                {n.label}
              </button>
            ))}
          </nav>
          <div className="flex-1 overflow-auto p-4">
            {tab === 'general' && (
              <>
                <h2 className="mb-3 text-lg font-semibold">通用</h2>
                <div className="mb-2.5 rounded-xl border border-line bg-panel2 p-3.5 shadow-[var(--shadow-soft)]">
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-mut">账户</h3>
                  <div className="mb-2 text-mut">{me?.email || ''}</div>
                  <div className="flex gap-2">
                    <Input
                      id="acctName"
                      maxLength={64}
                      placeholder="你的昵称（群聊里显示）"
                      value={acctName}
                      onChange={(e) => setAcctName(e.target.value)}
                    />
                    <Button variant="outline" onClick={saveAcct}>
                      保存昵称
                    </Button>
                  </div>
                  <div className={cn('mt-1 min-h-[18px] text-[13px]', acctMsg === '已保存' ? 'text-ok' : 'text-err')}>
                    {acctMsg}
                  </div>
                  {onSignOut && (
                    <Button variant="ghost" className="text-err" onClick={onSignOut}>
                      退出登录
                    </Button>
                  )}
                </div>
                <div className="rounded-xl border border-line bg-panel2 p-3.5 shadow-[var(--shadow-soft)]">
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-mut">管家显示名</h3>
                  <p className="mb-2 text-[13px] text-mut">
                    出现在侧栏与聊天气泡（1–32 字符）。重命名已移入设置。
                  </p>
                  <Input
                    id="butlerName"
                    maxLength={32}
                    placeholder="例如：小蜜"
                    value={nameIn}
                    onChange={(e) => setNameIn(e.target.value)}
                  />
                  <div className={cn('mt-1 min-h-[18px] text-[13px]', saveMsg === '已保存' ? 'text-ok' : 'text-err')}>
                    {saveMsg}
                  </div>
                  <Button className="mt-1" onClick={saveButler}>
                    保存显示名
                  </Button>
                </div>
              </>
            )}
            {tab === 'computer' && (
              <>
                <h2 className="mb-3 text-lg font-semibold">电脑</h2>
                {!device && <div className="text-mut">加载设备状态…</div>}
                {device && (
                  <>
                    <div className="mb-2.5 rounded-xl border border-line bg-panel2 p-3.5 shadow-[var(--shadow-soft)]">
                      <h3 className="mb-2 text-xs font-semibold tracking-wide text-mut">Bot 电脑 / 本地执行</h3>
                      <p className="m-0 mb-2">
                        {l2.note || '慢任务由本机 L2（claim + ACP）认领执行，对用户不可见。'}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <span
                          className={cn(
                            'inline-block h-2 w-2 rounded-full',
                            l2.online ? 'bg-ok' : 'bg-err',
                          )}
                        />
                        <b>{l2.label || (l2.online ? '在线' : '离线')}</b>
                        {l2.status && <Badge>{l2.status}</Badge>}
                      </div>
                      {l2.queued != null && (
                        <div className="mt-2 text-mut">排队任务：{String(l2.queued)}</div>
                      )}
                    </div>
                    <div className="rounded-xl border border-line bg-panel2 p-3.5 shadow-[var(--shadow-soft)]">
                      <h3 className="mb-2 text-xs font-semibold tracking-wide text-mut">设备</h3>
                      {devices.length === 0 && <div className="text-mut">无设备信息</div>}
                      {devices.map((d, i) => (
                        <div key={i} className="flex items-center gap-2.5 border-b border-line py-2.5 last:border-0">
                          <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-av-butler">💻</div>
                          <div className="min-w-0 flex-1">
                            <b className="block">{d.name}</b>
                            <small className="text-mut">{d.detail || d.kind || ''}</small>
                          </div>
                          <span className={cn('h-2 w-2 rounded-full', d.online ? 'bg-ok' : 'bg-err')} />
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            {tab === 'permissions' && <PermissionsPane />}
            {tab === 'schedules' && <SchedulesPane />}
            {tab === 'vault' && <VaultPane />}
            {tab === 'usage' && <UsagePane />}
            {tab === 'update' && <UpdatePane />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
