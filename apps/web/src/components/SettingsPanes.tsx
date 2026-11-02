import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const card = 'mb-2.5 rounded-xl border border-line bg-panel2 p-3.5 shadow-[var(--shadow-soft)]'
const h3 = 'mb-2 text-xs font-semibold tracking-wide text-mut'
type Policy = 'allow' | 'ask' | 'deny'
const POL: Record<Policy, string> = { allow: '允许', ask: '询问', deny: '禁止' }

export function PermissionsPane() {
  const [auto, setAuto] = useState(true)
  const [rules, setRules] = useState<{ key: string; label: string; desc: string; policy: Policy }[]>([])
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState('')
  const [newKey, setNewKey] = useState('')
  async function load() {
    const r = await api<{ autoReview: boolean; rules: typeof rules; note: string }>('/api/permissions')
    if (r.ok) {
      setAuto(r.j.autoReview)
      setRules(r.j.rules)
      setNote(r.j.note)
    }
  }
  useEffect(() => {
    void load()
  }, [])
  async function save(patch: { autoReview?: boolean; rules?: { key: string; policy: Policy }[] }) {
    const r = await api('/api/permissions', patch, 'PUT')
    setMsg(r.ok ? '已保存' : r.j.error || '保存失败')
    if (r.ok) void load()
  }
  return (
    <div data-pane="permissions">
      <h2 className="mb-3 text-lg font-semibold">权限</h2>
      <div className={card}>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <b>自动审核</b>
            <p className="m-0 text-[13px] text-mut">开启后，「询问」类工具由自动审核放行；关闭则这些工具不会被管家调用，直到你改为允许。</p>
          </div>
          <button
            type="button"
            aria-pressed={auto}
            onClick={() => save({ autoReview: !auto })}
            className={cn('relative h-6 w-11 rounded-full transition-colors', auto ? 'bg-acc' : 'bg-line')}
          >
            <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', auto ? 'left-[22px]' : 'left-0.5')} />
          </button>
        </div>
      </div>
      <div className={card}>
        <h3 className={h3}>工具规则（类别 / 工具 / MCP）</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-mut">
              <th className="py-1.5">类别或工具</th>
              <th>说明</th>
              <th className="w-28">策略</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.key} className="border-t border-line">
                <td className="py-2 font-medium">
                  {r.label} <small className="text-mut">{r.key}</small>
                </td>
                <td className="pr-2 text-[13px] text-mut">{r.desc}</td>
                <td>
                  <Select value={r.policy} onChange={(e) => save({ rules: [{ key: r.key, policy: e.target.value as Policy }] })}>
                    {(['allow', 'ask', 'deny'] as Policy[]).map((p) => (
                      <option key={p} value={p}>
                        {POL[p]}
                      </option>
                    ))}
                  </Select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex gap-2">
          <Input placeholder="添加规则：工具名或 mcp:slack" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
          <Button
            size="sm"
            onClick={() => {
              if (newKey.trim()) void save({ rules: [{ key: newKey.trim(), policy: 'ask' }] })
              setNewKey('')
            }}
          >
            添加
          </Button>
        </div>
        <div className="mt-1 min-h-[18px] text-[13px] text-ok">{msg}</div>
      </div>
      <p className="text-xs text-mut">{note}</p>
    </div>
  )
}

type Secret = { id: string; name: string; kind: string; masked: string; created_at: number; meta?: { note?: string } }
export function VaultPane() {
  const [list, setList] = useState<Secret[]>([])
  const [enc, setEnc] = useState('')
  const [f, setF] = useState({ name: '', kind: 'api_key', value: '', note: '' })
  const [msg, setMsg] = useState('')
  async function load() {
    const r = await api<{ secrets: Secret[]; encryption: string }>('/api/vault')
    if (r.ok) {
      setList(r.j.secrets)
      setEnc(r.j.encryption)
    }
  }
  useEffect(() => {
    void load()
  }, [])
  async function add() {
    const r = await api('/api/vault', f)
    setMsg(r.ok ? '已加密保存' : r.j.error || '失败')
    if (r.ok) {
      setF({ name: '', kind: 'api_key', value: '', note: '' })
      void load()
    }
  }
  async function del(id: string) {
    if (!confirm('删除这个凭据？关联的连接会解除绑定。')) return
    await api(`/api/vault/${id}`, undefined, 'DELETE')
    void load()
  }
  return (
    <div data-pane="vault">
      <h2 className="mb-3 text-lg font-semibold">保险库</h2>
      <div className={card}>
        <h3 className={h3}>已保存的凭据（从不回显明文）</h3>
        {list.length === 0 && <div className="text-sm text-mut">还没有凭据</div>}
        <table className="w-full text-sm">
          <tbody>
            {list.map((s) => (
              <tr key={s.id} className="border-t border-line first:border-0">
                <td className="py-2 font-medium">🔐 {s.name}</td>
                <td>
                  <Badge>{s.kind}</Badge>
                </td>
                <td className="font-mono text-mut">{s.masked}</td>
                <td className="text-xs text-mut">{new Date(s.created_at).toLocaleDateString()}</td>
                <td className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => del(s.id)}>
                    删除
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={card}>
        <h3 className={h3}>添加凭据</h3>
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="名称，如 GitHub PAT" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="api_key">API Key</option>
            <option value="token">Token</option>
            <option value="mcp_header">MCP Header</option>
            <option value="password">密码</option>
            <option value="other">其他</option>
          </Select>
          <Input className="col-span-2" type="password" placeholder="值（加密存储）" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
          <Input className="col-span-2" placeholder="备注（可选）" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </div>
        <Button className="mt-2" onClick={add}>
          保存到保险库
        </Button>
        <span className="ml-2 text-[13px] text-mut">{msg}</span>
      </div>
      <p className="text-xs text-mut">加密：{enc}。连接应用时可选择一个凭据作为 MCP Authorization。</p>
    </div>
  )
}

type Usage = {
  plan: string
  monthTokens: number
  events_count: number
  byKind: { kind: string; tokens: number; n: number }[]
  l2Jobs: { k: string; state: string; n: number }[]
  events: { kind: string; tokens: number; meta: unknown; created_at: number }[]
  note: string
}
const KIND: Record<string, string> = { l1_dm: '管家私聊', l1_room: '群聊管家', l2_expert: 'L2 专家', l2_sandbox_report: '沙箱汇报' }
export function UsagePane() {
  const [u, setU] = useState<Usage | null>(null)
  useEffect(() => {
    void api<Usage>('/api/usage').then((r) => r.ok && setU(r.j))
  }, [])
  function csv() {
    if (!u) return
    const rows = [['created_at', 'kind', 'tokens', 'meta'], ...u.events.map((e) => [new Date(e.created_at).toISOString(), e.kind, String(e.tokens), JSON.stringify(e.meta ?? '')])]
    const blob = new Blob([rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `usage-${new Date().toISOString().slice(0, 7)}.csv`
    a.click()
  }
  const jobs = (k: string) => (u?.l2Jobs || []).filter((j) => j.k === k).reduce((s, j) => s + j.n, 0)
  return (
    <div data-pane="usage">
      <h2 className="mb-3 text-lg font-semibold">用量与账单</h2>
      {!u && <div className="text-mut">加载中…</div>}
      {u && (
        <>
          <div className="mb-2.5 grid grid-cols-4 gap-2">
            {[
              ['套餐', u.plan],
              ['本月 tokens', u.monthTokens.toLocaleString()],
              ['L2 专家任务', String(jobs('expert'))],
              ['沙箱任务', String(jobs('sandbox'))],
            ].map(([k, v]) => (
              <div key={k} className={card + ' mb-0'}>
                <div className="text-xs text-mut">{k}</div>
                <div className="text-xl font-semibold">{v}</div>
              </div>
            ))}
          </div>
          <div className={card}>
            <h3 className={h3}>按类型（本月）</h3>
            {u.byKind.length === 0 && <div className="text-sm text-mut">本月暂无记录</div>}
            {u.byKind.map((b) => (
              <div key={b.kind} className="flex border-t border-line py-1.5 text-sm first:border-0">
                <span className="flex-1">{KIND[b.kind] || b.kind}</span>
                <span className="w-24 text-right text-mut">{b.n} 次</span>
                <span className="w-28 text-right font-medium">{b.tokens.toLocaleString()} tok</span>
              </div>
            ))}
          </div>
          <Button variant="outline" onClick={csv}>
            导出 CSV
          </Button>
          <p className="mt-2 text-xs text-mut">{u.note}。自托管：费用由你自己的 Cloudflare / 模型账户结算。</p>
        </>
      )}
    </div>
  )
}

export function UpdatePane() {
  const [v, setV] = useState<{ l1?: string; l2?: string; health?: string } | null>(null)
  const [channel, setChannel] = useState(() => localStorage.getItem('update.channel') || 'stable')
  useEffect(() => {
    void (async () => {
      const a = await api<{ l1: string; l2: string }>('/api/version')
      const h = await fetch('/health-l1').then((r) => r.json()).catch(() => ({}))
      setV({ l1: a.j.l1, l2: a.j.l2, health: h?.version })
    })()
  }, [])
  return (
    <div data-pane="update">
      <h2 className="mb-3 text-lg font-semibold">更新</h2>
      <div className={card}>
        <h3 className={h3}>版本</h3>
        {[
          ['前端 SPA', `${__SPA_VERSION__}（构建于 ${__SPA_BUILT_AT__.slice(0, 16).replace('T', ' ')} UTC）`],
          ['L1 Worker', `${v?.l1 ?? '…'}${v?.health ? ` · /health-l1 ${v.health}` : ''}`],
          ['L2 Bot 电脑', `${v?.l2 ?? '…'}（CUA/ACP）`],
        ].map(([k, val]) => (
          <div key={k} className="flex border-t border-line py-2 text-sm first:border-0">
            <span className="w-32 text-mut">{k}</span>
            <b>{val}</b>
          </div>
        ))}
      </div>
      <div className={card}>
        <h3 className={h3}>更新通道</h3>
        <Select
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value)
            localStorage.setItem('update.channel', e.target.value)
          }}
        >
          <option value="stable">稳定版</option>
          <option value="beta">测试版</option>
          <option value="nightly">每日构建</option>
        </Select>
        <p className="mt-2 text-[13px] text-mut">自托管：通过 `npm run cf:deploy` 更新 L1；L2 终端应用自行升级。通道选择保存在本浏览器。</p>
      </div>
    </div>
  )
}


type Schedule = {
  id: string
  name: string
  cron: string
  timezone: string
  prompt: string
  target_type: 'butler' | 'room' | 'expert'
  target_id: string | null
  enabled: boolean
  next_run_at: number | null
  last_run_at: number | null
}

const PRESET_OPTS: { id: string; label: string; cron: string }[] = [
  { id: 'every_minute', label: '每分钟（调试）', cron: '* * * * *' },
  { id: 'hourly', label: '每小时', cron: '0 * * * *' },
  { id: 'daily_9', label: '每天 09:00', cron: '0 9 * * *' },
  { id: 'weekdays_9', label: '工作日 09:00', cron: '0 9 * * 1-5' },
  { id: 'weekly_mon_9', label: '每周一 09:00', cron: '0 9 * * 1' },
  { id: 'custom', label: '自定义 cron', cron: '' },
]

function fmtTs(ms: number | null) {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  } catch {
    return new Date(ms).toISOString()
  }
}

export function SchedulesPane() {
  const [rows, setRows] = useState<Schedule[]>([])
  const [msg, setMsg] = useState('')
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [preset, setPreset] = useState('daily_9')
  const [customCron, setCustomCron] = useState('')
  const [target, setTarget] = useState<'butler' | 'room' | 'expert'>('butler')
  const [targetId, setTargetId] = useState('')
  const [busy, setBusy] = useState(false)
  const [roomOpts, setRoomOpts] = useState<{ id: string; name: string }[]>([])
  const [expertOpts, setExpertOpts] = useState<{ id: string; name: string }[]>([])
  const [armed, setArmed] = useState('')
  const [runsFor, setRunsFor] = useState('')
  const [runs, setRuns] = useState<{ id: string; status: string; detail?: string; created_at: number }[]>([])

  useEffect(() => {
    void api<{ rooms?: { id: string; name: string }[] }>('/api/rooms').then((r) => r.ok && setRoomOpts(r.j.rooms || []))
    void api<{ agents?: { id: string; name: string }[] }>('/api/agents').then(
      (r) => r.ok && setExpertOpts((r.j.agents || []).filter((a) => a.id !== 'orchestrator')),
    )
  }, [])

  async function showRuns(s: Schedule) {
    if (runsFor === s.id) {
      setRunsFor('')
      return
    }
    const r = await api<{ runs: typeof runs }>(`/api/schedules/${s.id}/runs`)
    setRuns(r.ok ? r.j.runs || [] : [])
    setRunsFor(s.id)
  }

  async function load() {
    const r = await api<{ schedules: Schedule[] }>('/api/schedules')
    if (r.ok) setRows(r.j.schedules || [])
    else setMsg(r.j.error || '加载失败')
  }
  useEffect(() => {
    void load()
  }, [])

  async function create() {
    const cron = preset === 'custom' ? customCron.trim() : PRESET_OPTS.find((p) => p.id === preset)?.cron || ''
    if (!name.trim() || !prompt.trim() || !cron) {
      setMsg('请填写名称、提示词与 cron')
      return
    }
    if (target !== 'butler' && !targetId.trim()) {
      setMsg('房间/专家需要填写 target_id')
      return
    }
    setBusy(true)
    const r = await api(
      '/api/schedules',
      {
        name: name.trim(),
        prompt: prompt.trim(),
        cron,
        timezone: 'Asia/Shanghai',
        target_type: target,
        target_id: target === 'butler' ? null : targetId.trim(),
      },
      'POST',
    )
    setBusy(false)
    setMsg(r.ok ? '已创建' : r.j.error || '创建失败')
    if (r.ok) {
      setName('')
      setPrompt('')
      void load()
    }
  }

  async function toggle(s: Schedule) {
    const r = await api(`/api/schedules/${s.id}`, { enabled: !s.enabled }, 'PATCH')
    setMsg(r.ok ? (s.enabled ? '已停用' : '已启用') : r.j.error || '失败')
    if (r.ok) void load()
  }

  async function runNow(s: Schedule) {
    setBusy(true)
    const r = await api<{ ok?: boolean; detail?: string; status?: string }>(`/api/schedules/${s.id}/run`, {}, 'POST')
    setBusy(false)
    setMsg(r.ok ? `已触发：${(r.j.detail || r.j.status || '').slice(0, 120)}` : r.j.error || '触发失败')
    if (r.ok) void load()
  }

  async function remove(s: Schedule) {
    if (armed !== s.id) {
      setArmed(s.id)
      setTimeout(() => setArmed((a) => (a === s.id ? '' : a)), 4000)
      return
    }
    setArmed('')
    const r = await api(`/api/schedules/${s.id}`, undefined, 'DELETE')
    setMsg(r.ok ? '已删除' : r.j.error || '删除失败')
    if (r.ok) void load()
  }

  return (
    <div data-pane="schedules">
      <h2 className="mb-3 text-lg font-semibold">定时任务</h2>
      <p className="mb-3 text-[13px] text-mut">自托管 cron（D1 + Workers 每分钟触发）。目标可以是管家、房间或 L2 专家。时区默认 Asia/Shanghai。</p>
      <div className={card}>
        <h3 className={h3}>新建</h3>
        <div className="mb-2 grid gap-2">
          <Input placeholder="名称，例如：早间简报" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          <textarea
            className="min-h-[72px] w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-acc"
            placeholder="触发时发给目标的提示词"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Select value={preset} onChange={(e) => setPreset(e.target.value)} className="min-w-[160px]">
              {PRESET_OPTS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            {preset === 'custom' && (
              <Input className="min-w-[160px] flex-1" placeholder="分 时 日 月 周" value={customCron} onChange={(e) => setCustomCron(e.target.value)} />
            )}
            <Select value={target} onChange={(e) => setTarget(e.target.value as typeof target)} className="min-w-[120px]">
              <option value="butler">管家</option>
              <option value="room">房间</option>
              <option value="expert">专家</option>
            </Select>
            {target !== 'butler' && (
              <Select className="min-w-[160px] flex-1" value={targetId} onChange={(e) => setTargetId(e.target.value)} data-testid="sched-target-id">
                <option value="">{target === 'room' ? '选择群聊' : '选择 L2 专家'}</option>
                {(target === 'room' ? roomOpts : expertOpts).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <Button disabled={busy} onClick={create}>
            创建定时任务
          </Button>
        </div>
      </div>
      <div className={card}>
        <h3 className={h3}>已有任务</h3>
        {rows.length === 0 && <div className="text-mut">暂无定时任务</div>}
        {rows.map((s) => (
          <div key={s.id} className="mb-2 rounded-lg border border-line bg-panel p-3 last:mb-0" data-schedule-id={s.id}>
            <div className="mb-1 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <b className="block">{s.name}</b>
                <small className="text-mut">
                  {s.cron} · {s.timezone} · {s.target_type === 'butler' ? '管家' : s.target_type === 'room' ? '群聊' : 'L2 专家'}
                  {s.target_id
                    ? ` / ${[...roomOpts, ...expertOpts].find((o) => o.id === s.target_id)?.name || s.target_id}`
                    : ''}
                </small>
              </div>
              <Badge className={s.enabled ? 'text-ok' : ''}>{s.enabled ? '启用' : '停用'}</Badge>
            </div>
            <p className="m-0 mb-2 line-clamp-2 text-[13px] text-mut">{s.prompt}</p>
            <div className="mb-2 text-[12px] text-mut">
              下次：{fmtTs(s.next_run_at)} · 上次：{fmtTs(s.last_run_at)}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={() => runNow(s)}>
                立即运行
              </Button>
              <Button variant="outline" onClick={() => toggle(s)}>
                {s.enabled ? '停用' : '启用'}
              </Button>
              <Button variant="outline" onClick={() => showRuns(s)}>
                {runsFor === s.id ? '收起记录' : '运行记录'}
              </Button>
              <Button variant="ghost" className="text-err" onClick={() => remove(s)}>
                {armed === s.id ? '再次点击确认删除' : '删除'}
              </Button>
            </div>
            {runsFor === s.id && (
              <div className="mt-2 rounded-lg bg-panel2 p-2 text-[12px]" data-testid="sched-runs">
                {runs.length === 0 && <div className="text-mut">暂无运行记录</div>}
                {runs.map((r) => (
                  <div key={r.id} className="flex gap-2 border-t border-line py-1 first:border-0">
                    <span className="w-36 shrink-0 text-mut">{fmtTs(r.created_at)}</span>
                    <span className={r.status === 'ok' ? 'text-ok' : 'text-err'}>{r.status}</span>
                    <span className="truncate text-mut">{r.detail || ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className={cn('min-h-[18px] text-[13px]', msg.includes('失败') ? 'text-err' : 'text-ok')}>{msg}</div>
    </div>
  )
}
