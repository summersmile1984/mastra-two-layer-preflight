# L2 Desktop (scaffold)

Local second-layer runtime that **actively claims** tasks from L1 Cloudflare Worker, then runs them via **ACP** (agent coding protocol / shell harness) or **CUA** (computer-use agent).

## Shell

- **Preferred:** [Tauri 2](https://v2.tauri.app/) + TypeScript (`src-tauri/` is a minimal placeholder).
- **Fallback:** plain Node (`npm run claim:dev`) — same claim/dispatch/ACP+CUA stubs as the future Tauri sidecars.
- Full GUI scaffold (when you have Rust toolchain):

```bash
cd apps/l2-desktop
npm create tauri-app@latest . -- --template vanilla-ts
# merge generated src-tauri with our claim loop under src/
```

## Layout

| Path | Role |
|---|---|
| `src/main.ts` | Claim loop entry |
| `src/claim.ts` | `POST {L1}/l2-claim` + `POST {L1}/a2a-callback` (same as repo `src/l2-pull-worker.ts`) |
| `src/dispatch.ts` | `task.kind` / `runtime` → `'acp' \| 'cua'` |
| `src/acp/runner.ts` | ACP stub (log + fake success) |
| `src/cua/runner.ts` | CUA loop interface: screenshot → act → loop (**stub**; needs OS permissions) |
| `src/config.ts` | `L1_PULL_URL`, `PUSH_TOKEN` / `L2_DEVICE_TOKEN`, optional `~/.config/mastra-l2/device.json` |
| `../../packages/shared` | `ClaimTask`, `TaskKind`, callback payload types |

## Pairing / env

```bash
export L1_PULL_URL=https://mastra-l1.summersmile1984.workers.dev
export PUSH_TOKEN=…          # same secret as Worker PUSH_TOKEN (device pairing token for now)
# optional:
export L2_PULL_INTERVAL_MS=2000
export L2_DEVICE_TOKEN=…     # alias for PUSH_TOKEN
```

Or write `~/.config/mastra-l2/device.json`:

```json
{ "l1Url": "https://mastra-l1.summersmile1984.workers.dev", "token": "…", "intervalMs": 2000 }
```

L1 contract (already live):

- `POST /l2-claim` — `Authorization: Bearer <token>` or `X-A2A-Notification-Token`
- Returns `{ task: { taskId, prompt, runtime, threadId } | null }`
- Complete via A2A Task POST `/a2a-callback`

## ACP vs CUA

- **ACP:** local coding/shell harness (dsh / Claude / Codex). Stub returns fake success; wire to `runAcpPrompt` later.
- **CUA:** computer-use loop (screenshot → model → click/type). **Stub only** until the desktop app has OS permissions (macOS Screen Recording + Accessibility, Windows UI Automation, etc.). Do not expect real desktop control from this scaffold.

## Dev

```bash
cd apps/l2-desktop
npm i
npm run check          # tsc --noEmit
# needs PUSH_TOKEN:
npm run claim:dev
```

Root repo still has `npm run start:l2-pull` for the production-ish Node pull worker; this package is the desktop-oriented scaffold.
