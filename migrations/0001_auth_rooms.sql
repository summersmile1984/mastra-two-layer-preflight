-- 0001_auth_rooms.sql — better-auth（邮箱密码）+ 多用户共享房间
-- D1 = SQLite。日期一律 INTEGER（Unix 毫秒），布尔 INTEGER 0/1，与 drizzle schema 一致。
-- 应用方式：npx wrangler d1 execute mastra-l1 --remote --file migrations/0001_auth_rooms.sql

-- ---------- better-auth 内置表（字段与 @better-auth/core schema 一一对应） ----------

CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" integer NOT NULL DEFAULT 0,
  "image" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_unique" ON "user" ("email");

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user" ("id"),
  "expires_at" integer NOT NULL,
  "token" text NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_token_unique" ON "session" ("token");
CREATE INDEX IF NOT EXISTS "session_user_id_index" ON "session" ("user_id");

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY,
  "provider_id" text NOT NULL,
  "account_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user" ("id"),
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" integer,
  "refresh_token_expires_at" integer,
  "scope" text,
  "password" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "account_user_id_index" ON "account" ("user_id");

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" integer NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "verification_identifier_index" ON "verification" ("identifier");

-- ---------- 多用户共享房间 ----------

CREATE TABLE IF NOT EXISTS "rooms" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "created_by" text REFERENCES "user" ("id"),
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "rooms_updated_at_index" ON "rooms" ("updated_at");

CREATE TABLE IF NOT EXISTS "room_members" (
  "room_id" text NOT NULL REFERENCES "rooms" ("id"),
  "user_id" text NOT NULL REFERENCES "user" ("id"),
  "role" text NOT NULL DEFAULT 'member', -- owner | member
  "joined_at" integer NOT NULL,
  "last_read_at" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("room_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "room_members_user_id_index" ON "room_members" ("user_id");

CREATE TABLE IF NOT EXISTS "messages" (
  "id" text PRIMARY KEY,
  "room_id" text NOT NULL REFERENCES "rooms" ("id"),
  "user_id" text,                          -- NULL = assistant / system 行
  "role" text NOT NULL,                    -- user | assistant | system
  "content" text NOT NULL,
  "created_at" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "messages_room_created_index" ON "messages" ("room_id", "created_at");
