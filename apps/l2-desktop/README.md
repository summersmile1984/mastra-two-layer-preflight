# Mastra Desktop (`apps/l2-desktop`)

PC desktop app (Tauri 2 + TypeScript): **interactive chat UI** + **L2 agent runtime** in one install.

- **Chat**: embeds live L1 SPA at `{L1_URL}/app` (soft light product UI).
- **L2 panel**: start/stop claim loop, last claim / ACP|CUA kind, queue hint.
- **Settings**: L1 URL + device token → `~/.config/mastra-l2/device.json`.
- **Runtime**: claims from `POST /l2-claim`, runs ACP (`dsh --profile acp` via `runAcpPrompt`) or CUA (`cua` CLI), pushes `POST /a2a-callback`.

## Prerequisites (macOS)

- Node 20+ (Node 24 OK)
- Rust stable (`rustc` / `cargo`) — Xcode CLT required
- Optional for real tasks: `dsh --profile acp`, trycua `cua` + `cua-spacesd` (Screen Recording; Accessibility recommended)

```bash
# one-time
xcode-select --install   # if needed
curl https://sh.rustup.rs -sSf | sh
```

## Dev on Mac

```bash
cd apps/l2-desktop
npm install
# optional: regenerate platform icons from icons/icon.png
# npx tauri icon src-tauri/icons/icon.png

# pair device (token is the same secret as Worker PUSH_TOKEN — do not commit)
mkdir -p ~/.config/mastra-l2
cat > ~/.config/mastra-l2/device.json <<'JSON'
{
  "l1Url": "https://mastra-l1.summersmile1984.workers.dev",
  "token": "YOUR_DEVICE_TOKEN",
  "intervalMs": 2000
}
JSON

npm run tauri:dev
```

Window: ~1200×800 soft light chrome — chat WebView + L2 side panel.

Headless claim loop only (no window):

```bash
npm run claim:dev
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run tauri:dev` | Vite UI + Tauri window |
| `npm run tauri:build` | Release `.app` / installers |
| `npm run claim:dev` | Node claim loop sidecar |
| `npm run check` | `tsc` for runtime + UI |

## Layout

| Path | Role |
|---|---|
| `ui/` | Soft light desktop chrome (status + settings) |
| `src/` | Claim / ACP / CUA Node runtime (sidecar) |
| `src-tauri/` | Tauri 2 shell (spawn/stop loop, settings IO) |
| `../../packages/shared` | Claim/callback types |

## ACP vs CUA

- **ACP**: real `runAcpPrompt` (`@mastra/acp` + `dsh`). Set `ACP_DRY_RUN=1` only as last resort.
- **CUA**: real `cua do …` via `src/l2/cua-cli.ts` when claim `kind`/`runtime` is `cua`.

L1 already accepts `dispatch_to_sandbox({ runtime: 'cua' })` and `/l2-claim` returns `kind`.

## Notes

- Do not print device/PUSH tokens in docs or screenshots.
- Grok Bot Desktop is IA reference only — no branding/assets copied.
- Electron fallback is not used; this package is Tauri 2.
