-- 0003_prompt_config.sql — 提示词配置字段（prompt-config spec S2.2）
-- 应用方式：npx wrangler d1 execute mastra-l1 --remote --file migrations/0003_prompt_config.sql
-- （运行时 ensurePersonaConfig 也有幂等 ALTER + 种子回填，两边一致）

ALTER TABLE persona_config ADD COLUMN base_prompt TEXT;
ALTER TABLE persona_config ADD COLUMN tone_main TEXT;
ALTER TABLE persona_config ADD COLUMN tone_room TEXT;
ALTER TABLE persona_config ADD COLUMN om_observe TEXT;
ALTER TABLE persona_config ADD COLUMN om_reflect TEXT;
ALTER TABLE persona_config ADD COLUMN tool_dispatch TEXT;
