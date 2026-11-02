# Auth

> UI：`apps/web` SPA（`/app`）。本文件描述 API 契约，与前端无关。
 & Rooms (Better Auth on Cloudflare Workers + D1)

- Better Auth 1.7 (`src/auth.ts`, `createAuth(env)`, `database: env.DB`), email+password and emailOTP. **No organization / team plugin.**
- Group chats are self-built: `rooms`, `room_members`, `room_agents`, `room_invites` (nullable `tenant_id` reserved). Schema: `migrations/0001_auth_rooms.sql`, `migrations/0002_butler_display_name.sql` (optional `butler_profile.display_name`).
- Mastra threads are the message store: room → thread/resource `room_{roomId}` (created eagerly via `Memory.createThread` on room create; generate would create lazily otherwise); butler DM → `user:{userId}` (created lazily on first DM). `butler_profile` row is created in the Better Auth `user.create.after` hook. Experts are agents, not Better Auth users.
- Routes are mounted as a Mastra server middleware (`src/l1/app-routes.ts`) because custom `apiRoutes` can't use `/api`. L2 routes (`/l2-claim`, `/a2a-callback`, `/l2-results`, `/health-l1`) unchanged.
- `POST /api/agents/:id/generate|stream*` now requires a session. **DEV bypass for L2 tests only:** `Authorization: Bearer $PUSH_TOKEN`.

## Dev OTP (no SMTP)
With secret `AUTH_DEV_MODE=1`, OTPs are stored in D1 `dev_otps` and readable at `GET /api/dev/otp?email=…` (404 when dev mode is off). **Remove `AUTH_DEV_MODE` before real users** and wire an email sender in `sendVerificationOTP`.

## Setup
```
export PATH=~/.nvm/versions/node/v22.23.4/bin:$PATH   # wrangler needs Node 22
npx wrangler d1 execute mastra-l1 --remote --file migrations/0001_auth_rooms.sql
npm run cf:build
openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET -c .mastra/output/wrangler.json
echo -n https://mastra-l1.summersmile1984.workers.dev | npx wrangler secret put BETTER_AUTH_URL -c .mastra/output/wrangler.json
echo -n 1 | npx wrangler secret put AUTH_DEV_MODE -c .mastra/output/wrangler.json
npx wrangler deploy -c .mastra/output/wrangler.json
```

## API
| Route | Notes |
|---|---|
| `/api/auth/*` | Better Auth (sign-up/email, sign-in/email, email-otp/send-verification-otp, sign-in/email-otp, sign-out, get-session) |
| `GET /api/me` | user + butler `{ dm_thread_id, display_name, name }` (`name` = display_name \|\| `管家 Orchestrator`) |
| `PATCH /api/butler/profile {display_name}` | 1–32 chars trimmed; updates session user's butler_profile |
| `POST /api/rooms {name}` / `GET /api/rooms` | create (owner + default `orchestrator` agent + thread) / list mine + pending invites |
| `GET /api/rooms/:id` | members only; room + my role, members (joined with `user` name/email), agents, pendingInvites (owner/admin only) |
| `POST /api/rooms/:id/invites {email}` | owner/admin only |
| `POST /api/rooms/invites/:id/accept` | invitee email must match session |
| `POST /api/rooms/:id/messages {text}` / `GET` | members only; text wrapped as `<turn room from_user from_name>` |
| `POST /api/butler/messages {text}` / `GET` | private DM; GET recalls `user:{userId}` history |

Browser: https://mastra-l1.summersmile1984.workers.dev/app  (SPA; legacy vanilla archived as cf-public/app.vanilla.html)

## curl recipe
```
B=https://mastra-l1.summersmile1984.workers.dev; H=(-H 'content-type: application/json' -H "Origin: $B")
curl -s -w ' %{http_code}\n' $B/api/rooms                                   # 401
curl -s -c j.txt "${H[@]}" -d '{"email":"a@example.com","password":"Passw0rd!xyz","name":"A"}' $B/api/auth/sign-up/email
# or OTP: send → read dev OTP → sign in
curl -s "${H[@]}" -d '{"email":"b@example.com","type":"sign-in"}' $B/api/auth/email-otp/send-verification-otp
curl -s "$B/api/dev/otp?email=b@example.com"
curl -s -c j2.txt "${H[@]}" -d '{"email":"b@example.com","otp":"123456"}' $B/api/auth/sign-in/email-otp
curl -s -b j.txt "${H[@]}" -d '{"name":"demo"}' $B/api/rooms
curl -s -b j.txt "${H[@]}" -d '{"text":"你好"}' $B/api/rooms/<roomId>/messages
curl -s -b j.txt "${H[@]}" -d '{"text":"你好"}' $B/api/butler/messages
```

## Multi-agent rooms
- `GET /api/agents` (session) → catalog `[{id,name,desc}]`: orchestrator(管家), researcher(调研专家), coder(工程师).
- `POST /api/rooms/:id/agents {agentId}` / `DELETE /api/rooms/:id/agents/:agentId` — owner/admin; 400 unknown agent; orchestrator can't be removed.
- `POST /api/rooms/:id/messages` reply rule (@mention routing):
  - no @ / @管家 / @orchestrator → orchestrator; @调研/@researcher → researcher; @工程师/@coder → coder
  - multiple @ → each mentioned room agent replies in order, same thread `room_{id}`
  - @agent not in room (or unknown @word with no valid mention) → short error reply from 管家
  - Response `{thread, replies:[{agentId,name,reply}], reply}`.
- Storage: user turn saved once (`<turn …>` wrapper); each agent generates with `memory.options.readOnly` and its reply is saved as `[agent:<id>] text` so history recall keeps identity (UI strips the prefix). Butler DM stays orchestrator-only.
