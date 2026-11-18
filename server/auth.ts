import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const dates = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
};
const user = sqliteTable('user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
  image: text(),
  ...dates,
});
const session = sqliteTable('session', {
  id: text().primaryKey(), token: text().notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'), userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id),
  ...dates,
});
const account = sqliteTable('account', {
  id: text().primaryKey(), accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(), userId: text('user_id').notNull().references(() => user.id),
  accessToken: text('access_token'), refreshToken: text('refresh_token'), idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text(), password: text(),
  ...dates,
});
const verification = sqliteTable('verification', {
  id: text().primaryKey(), identifier: text().notNull(), value: text().notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ...dates,
});

export type AuthSettings = { DB: D1Database; AUTH_SECRET?: string; AUTH_URL?: string; REGISTRATION_KEY?: string };

export function createAuth(env: AuthSettings, registrationAllowed = false) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32 || !env.AUTH_URL) {
    throw new Error('Authentication configuration is missing');
  }
  const schema = { user, session, account, verification };
  return betterAuth({
    secret: env.AUTH_SECRET,
    baseURL: env.AUTH_URL,
    database: drizzleAdapter(drizzle(env.DB, { schema }), {
      provider: 'sqlite', schema, transaction: false,
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, disableSignUp: !registrationAllowed },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    session: { expiresIn: 7 * 86400, updateAge: 86400 },
    logger: { disabled: true },
  });
}

export async function matchesInvite(expected?: string, supplied?: string) {
  if (!expected || !supplied || supplied.length > 256) return false;
  const encode = new TextEncoder();
  const [left, right] = await Promise.all([expected, supplied].map((key) => crypto.subtle.digest('SHA-256', encode.encode(key))));
  return new Uint8Array(left).reduce((difference, byte, index) => difference | (byte ^ new Uint8Array(right)[index]), 0) === 0;
}
