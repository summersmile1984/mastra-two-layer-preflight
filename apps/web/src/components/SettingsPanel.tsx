import { useEffect, useState } from 'react';
import type { Persona } from '../lib/api';
import { getModels, getPersona, updatePersona } from '../lib/api';

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
  const [basePrompt, setBasePrompt] = useState('');
  const [toneMain, setToneMain] = useState('');
  const [toneRoom, setToneRoom] = useState('');
  const [omObserve, setOmObserve] = useState('');
  const [omReflect, setOmReflect] = useState('');
  const [toolDispatch, setToolDispatch] = useState('');
  const [modelGateway, setModelGateway] = useState('');
  const [modelName, setModelName] = useState('');
  const [modelEffort, setModelEffort] = useState('');
  const [gateways, setGateways] = useState<{ gateway: string; models: string[] }[]>([]);
  const [effortLevels, setEffortLevels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([getPersona(), getModels()])
      .then(([p, m]) => {
        setName(p.name);
        setRole(p.role);
        setStyle(p.style);
        setMainRoomName(p.main_room_name);
        setBasePrompt(p.base_prompt ?? '');
        setToneMain(p.tone_main ?? '');
        setToneRoom(p.tone_room ?? '');
        setOmObserve(p.om_observe ?? '');
        setOmReflect(p.om_reflect ?? '');
        setToolDispatch(p.tool_dispatch ?? '');
        setModelGateway(p.model_gateway ?? '');
        setModelName(p.model_name ?? '');
        setModelEffort(p.model_effort ?? '');
        setGateways(m.gateways);
        setEffortLevels(m.effortLevels);
      })
      .catch(() => setErr('加载配置失败，请稍后重试'))
      .finally(() => setLoading(false));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const p = await updatePersona({
        name,
        role,
        style,
        main_room_name: mainRoomName,
        base_prompt: basePrompt,
        tone_main: toneMain,
        tone_room: toneRoom,
        om_observe: omObserve,
        om_reflect: omReflect,
        tool_dispatch: toolDispatch,
        model_gateway: modelGateway,
        model_name: modelName,
        model_effort: modelEffort,
      });
      onSuccess(p);
    } catch {
      setErr('保存失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  const gatewayModels = gateways.find((g) => g.gateway === modelGateway)?.models ?? [];
  const modelOptions =
    modelName && !gatewayModels.includes(modelName) ? [...gatewayModels, modelName] : gatewayModels;

  function onGatewayChange(g: string) {
    setModelGateway(g);
    setModelName(gateways.find((x) => x.gateway === g)?.models[0] ?? '');
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

            <div className="mb-4 mt-6 border-t border-[var(--color-line)] pt-4">
              <p className="text-sm font-semibold">提示词高级设置</p>
              <p className="text-xs text-[var(--color-mut)]">控制秘书在不同场景下的提示词行为</p>
            </div>

            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>基础提示词</span>
                <span>{basePrompt.length}/4000</span>
              </span>
              <textarea
                value={basePrompt}
                maxLength={4000}
                rows={6}
                onChange={(e) => setBasePrompt(e.target.value)}
                placeholder="每轮都生效的基础人设与规则"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>主会话语调</span>
                <span>{toneMain.length}/500</span>
              </span>
              <textarea
                value={toneMain}
                maxLength={500}
                rows={2}
                onChange={(e) => setToneMain(e.target.value)}
                placeholder="主会话语调"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>共享房间语调</span>
                <span>{toneRoom.length}/500</span>
              </span>
              <textarea
                value={toneRoom}
                maxLength={500}
                rows={2}
                onChange={(e) => setToneRoom(e.target.value)}
                placeholder="共享房间语调"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>记忆观察员指令（引擎重启后生效）</span>
                <span>{omObserve.length}/500</span>
              </span>
              <textarea
                value={omObserve}
                maxLength={500}
                rows={2}
                onChange={(e) => setOmObserve(e.target.value)}
                placeholder="记忆观察员指令"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>记忆压缩指令（引擎重启后生效）</span>
                <span>{omReflect.length}/500</span>
              </span>
              <textarea
                value={omReflect}
                maxLength={500}
                rows={2}
                onChange={(e) => setOmReflect(e.target.value)}
                placeholder="记忆压缩指令"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-5 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>任务派发工具描述（即改即生效）</span>
                <span>{toolDispatch.length}/500</span>
              </span>
              <textarea
                value={toolDispatch}
                maxLength={500}
                rows={2}
                onChange={(e) => setToolDispatch(e.target.value)}
                placeholder="任务派发工具描述"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>

            <div className="mb-4 mt-6 border-t border-[var(--color-line)] pt-4">
              <p className="text-sm font-semibold">模型设置</p>
              <p className="text-xs text-[var(--color-mut)]">选择模型网关、模型与推理力度</p>
            </div>

            <label className="mb-3 block">
              <span className="mb-1 block text-xs text-[var(--color-mut)]">模型网关</span>
              <select
                value={modelGateway}
                onChange={(e) => onGatewayChange(e.target.value)}
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              >
                {gateways.map((g) => (
                  <option key={g.gateway} value={g.gateway}>
                    {g.gateway}
                  </option>
                ))}
              </select>
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs text-[var(--color-mut)]">模型</span>
              <select
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              >
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="mb-5 block">
              <span className="mb-1 block text-xs text-[var(--color-mut)]">推理力度 / effort</span>
              <select
                value={modelEffort}
                onChange={(e) => setModelEffort(e.target.value)}
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              >
                {effortLevels.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
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
