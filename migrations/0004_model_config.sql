-- 0004_model_config.sql — 模型配置字段（model-gateway-config spec S2.1）
-- 运行时 ensurePersonaConfig 有幂等 ALTER + 种子回填，两边一致
ALTER TABLE persona_config ADD COLUMN model_gateway TEXT;
ALTER TABLE persona_config ADD COLUMN model_name TEXT;
ALTER TABLE persona_config ADD COLUMN model_effort TEXT;
