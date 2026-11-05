---
feature: schedules-secrets
status: delivered
updated: 2026-11-05
source: port-schedules-secrets
---

# 并入远端第一批：调度 schedules + 密钥 CF-Secrets 化

## Report

**What was built** — 并入远端第一批（整合规则：本地为基底、冲突本地优先）：①**schedules 定时任务**（移植远端设计：5 字段 cron + IANA 时区 + 预设 + schedule_runs 日志；`target_type=room`；Workers cron `* * * * *` + `scheduled` 出口经注册表转发；tick 执行 = 以 prompt 驱动秘书向目标房间发言（compose + RoomDO 通知），含 claim 防双发、过期 vault 清扫）；②**permissions 数据面**（allow/ask/deny + auto_review，HITL 消费方后续）；③**vault → CF Secrets Store**（store `vault`：D1 只存元数据、密钥本体托管 CF、TTL 过期即不可读、双向删除校验、写失败补偿回滚——按用户裁定替换远端的 AES-GCM 自研保险箱）。

**Verification** — schedules 模块自测 7/7；生产 E2E **12/12**（vault 建→Store 可见→仅元数据→TTL→双向删 6 项；permissions 读写 2 项；schedule 建→**真实触发**（status=success、房间收到「定时任务正常。主人，我在。」）→删 3 项）+ TTL 强化验证（TTL 内可读、过期后 GET /vault/:id=404 且列表隐藏）；persona 回归 10/10。评审 CRITICAL 2 项已修并复验：delete 校验 CF 响应（防孤儿密钥）、过期即不存在 + GET /vault/:id 补齐。

## [S1] Problem

两条开发线（本地 25 commits vs 远端 v0.2.x 10 commits，同源 9256c22）需要整合。用户裁定整合规则：**以本地为基底，并入远端可用功能，冲突一律本地优先**。第一批补两个挂账缺口：①**调度/例程**（AGENTS.md 缺口 #2，愿景 24h 的「主动」半边）——远端已有完整 schedules 实现（`schedules`/`schedule_runs` 表 + 5 字段 cron + IANA 时区 + 预设）；②**密钥/权限**（AGENTS.md 缺口 #1 的前置）——远端是 AES-GCM `vault_secrets` 自研保险箱，用户裁定改用 **Cloudflare secrets 功能**托管，不自造加密。

## [S2] Design

### S2.0 整合规则（本批及后续所有移植批次的总则）

- 基底 = 本地 main（OM/人格/模型配置/RoomDO WS/配置化提示词）。
- 远端件以「可独立落地」为单位移植，接入本地的路由风格（`registerApiRoute`，**无 /api 前缀**）、`db()` 迁移链、better-auth 会话。
- 冲突（记忆双轨、房间模型、0001 迁移、消息归属）一律本地优先，不引入远端实现。

### S2.1 schedules（移植远端 `src/l1/schedules.ts` + 迁移 0006 → 本地 0005）

- 表：`schedules`（id, user_id, name, cron 5 字段, timezone 默认 Asia/Shanghai, prompt, target_type, target_id, enabled, next_run_at, last_run_at）+ `schedule_runs`（执行日志）。**target_type 收敛为 `room`**（本地无 butler/room/expert 三分；target_id=roomId，主会话即 is_main 房间）——远端枚举值留给后续切片。
- 逻辑移植：`matchField` 五字段求值、`zonedParts` IANA 时区换算、预设（every_minute/hourly/daily_9/weekdays_9/weekly_mon_9）、`next_run_at` 推算。
- 路由（本地风格）：`GET/POST/PUT/DELETE /schedules`、`GET /schedules/:id/runs`（登录 + 本人范围）。
- **执行**：Workers `[triggers] crons`（`* * * * *`）→ `scheduled` 出口（cf-postbuild 给 worker-entry 的 default 挂 `scheduled`，同 queue 先例）→ 扫 `enabled=1 AND next_run_at<=now` → 以 prompt 驱动 orchestrator 向目标房间发言（复用 compose 落消息 + RoomDO WS 通知）→ 写 `schedule_runs` → 推 `next_run_at`。用户可见效果：**秘书按点主动说话**。

### S2.2 permissions（移植远端 0005 的 `user_permission_rules`）

- 表：`user_permission_rules`（user_id, category_or_tool, policy allow|ask|deny, updated_at）+ `user_settings`（auto_review）。路由 `GET/PUT /permissions`。
- 本批只落数据面（消费方在 HITL/工具放行切片）；与既有硬约束不冲突（提示词层规则照旧）。

### S2.3 密钥：Cloudflare Secrets Store（替换远端 AES-GCM vault_secrets）

- 元数据表 `vault_meta`（id, user_id, name, kind, secret_name, created_at, expires_at, created_by）——**不存任何密文/明文**；密钥本体存 **CF Secrets Store**（secret 名 `vault__<userId>__<id>`），运行时经 CF REST API（`CLOUDFLARE_API_KEY` + account id，已有）增删。
- 路由：`GET /vault`（仅元数据）、`POST /vault`（建密钥，支持 ttl 秒数 → expires_at）、`GET /vault/:id`（**不回密文**，只元数据）、`DELETE /vault/:id`（两边清）。
- TTL 语义（HITL 10 分钟 vault 的地基）：读取侧校验 `expires_at`，过期即视为不存在；删除兜底惰性 + scheduled 清理（并入 S2.1 的 cron tick）。
- 验证任务含「Secrets Store 运行时增删查真通」；若 REST 面不支持动态建密钥，降级方案：D1 只存元数据 + 密钥经 `wrangler secret` 静态注入（不在本 spec 展开）。

## [S3] Out of Scope

- 远端其余件（room_digests、多 agent 专家、templates、emailOTP、MCP 连接、Tauri 升级）——后续批次；HITL 审批 UI（permissions 消费方）；butler DM/多 agent 房间（冲突，本地优先）。

## Tasks

- [x] T1: schedules 移植（迁移 0005 + 模块 + /schedules 路由 + cron tick 执行闭环） — acceptance: 新建每分钟 schedule 后目标房间收到秘书定时消息，`schedule_runs` 有成功记录，next_run_at 正确滚动（covers: S2.1）
- [x] T2: permissions/user_settings 数据面（迁移 0006 + /permissions 路由） — acceptance: GET/PUT 生效且本人范围隔离（covers: S2.2）
- [x] T3: vault → CF Secrets Store（vault_meta + /vault CRUD + TTL 过期） — acceptance: POST 后 Secrets Store API 可查到密钥、GET 只回元数据、DELETE 两边清除、过期后不可读（covers: S2.3）
- [x] T4: 生产验证与定稿 — acceptance: E2E 证据入 Report；现有记忆/人格/模型链路零回归（covers: 全部, depends: T1–T3）

## Journey log

- scheduled 路径与 queue 同病：不经过 fetch 的 mastra() 工厂 → Memory 未注册 → generate 抛 storage provider——修法同款（工厂 + __registerMastra + setStorage），且复用 __omMastraInst 缓存。
- CF REST 的 fetch 不因 4xx/5xx 抛错——vault 删除必须校验 res.ok/body.success，否则 CF 删失败仍删元数据会留孤儿密钥（评审 CRITICAL）。
- TTL 验证要留足余量：ttl=3s 连创建往返都撑不过；正确断言是「TTL 内可读（长 TTL 证）+ 过期后 404/列表隐藏」。
- cron tick 的双发防护：先 `UPDATE ... WHERE next_run_at=<旧值>`（CAS claim）再执行，慢回合不会被下一个 tick 重放。
- 整合规则入档（S2.0）：本地为基底、远端件可独立移植、冲突本地优先——后续批次沿用。
