/**
 * Better Auth on Workers + D1. Login/session only — NO organization / team plugins (rooms are self-built).
 * Email OTP sending: no SMTP configured. When AUTH_DEV_MODE=1 the OTP is written to D1 `dev_otps`
 * and readable via GET /api/dev/otp?email=… (dev only). Without dev mode, OTP is only logged as "sent" (no-op).
 */
import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';

export const devMode = (env: any) => String(env.AUTH_DEV_MODE ?? '') === '1';

export function createAuth(env: any) {
  const db = env.DB;
  const base = String(env.BETTER_AUTH_URL || env.L1_PUBLIC_URL || 'https://mastra-l1.summersmile1984.workers.dev').replace(/\/$/, '');
  return betterAuth({
    database: db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: base,
    basePath: '/api/auth',
    trustedOrigins: [base],
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        async sendVerificationOTP({ email, otp, type }) {
          if (devMode(env)) {
            await db.prepare('INSERT INTO dev_otps (email, otp, type, created_at) VALUES (?,?,?,?)').bind(email.toLowerCase(), otp, type, Date.now()).run();
          }
          console.log('[auth] otp issued', JSON.stringify({ type, dev: devMode(env) })); // never log the OTP itself
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // 新用户：建 butler_profile；Mastra DM thread 在第一条 DM 时由 generate 懒创建
          after: async (user: any) => {
            await db.prepare('INSERT OR IGNORE INTO butler_profile (user_id, dm_thread_id, created_at) VALUES (?,?,?)')
              .bind(user.id, `user:${user.id}`, Date.now()).run();
          },
        },
      },
    },
  });
}
export type Auth = ReturnType<typeof createAuth>;
