-- Better Auth core tables (sqlite / D1, default camelCase columns). No organization/team tables.
CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt DATE NOT NULL, updatedAt DATE NOT NULL);
CREATE TABLE IF NOT EXISTS "session" (id TEXT PRIMARY KEY, expiresAt DATE NOT NULL, token TEXT NOT NULL UNIQUE, createdAt DATE NOT NULL, updatedAt DATE NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS session_userId_idx ON "session"(userId);
CREATE TABLE IF NOT EXISTS "account" (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt DATE, refreshTokenExpiresAt DATE, scope TEXT, password TEXT, createdAt DATE NOT NULL, updatedAt DATE NOT NULL);
CREATE INDEX IF NOT EXISTS account_userId_idx ON "account"(userId);
CREATE TABLE IF NOT EXISTS "verification" (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt DATE NOT NULL, createdAt DATE NOT NULL, updatedAt DATE NOT NULL);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON "verification"(identifier);

-- Dev-only OTP sink (written only when AUTH_DEV_MODE=1)
CREATE TABLE IF NOT EXISTS dev_otps (email TEXT NOT NULL, otp TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS dev_otps_email ON dev_otps(email, created_at);

-- Butler: one private DM per user; Mastra thread id = user:{userId}
CREATE TABLE IF NOT EXISTS butler_profile (user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, dm_thread_id TEXT NOT NULL, created_at INTEGER NOT NULL);

-- Self-built rooms (NOT Better Auth organization). tenant_id reserved for future multi-tenant.
CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES "user"(id), thread_id TEXT NOT NULL, tenant_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS room_members (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('owner','admin','member')), joined_at INTEGER NOT NULL, PRIMARY KEY (room_id, user_id));
CREATE INDEX IF NOT EXISTS room_members_user ON room_members(user_id);
CREATE TABLE IF NOT EXISTS room_agents (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (room_id, agent_id));
CREATE TABLE IF NOT EXISTS room_invites (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, email TEXT NOT NULL, invited_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, accepted_at INTEGER);
CREATE INDEX IF NOT EXISTS room_invites_email ON room_invites(email, status);
