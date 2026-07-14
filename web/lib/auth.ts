import "server-only";
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { env } from "@openbooks/engine/src/db.ts";

/**
 * Sessions: HMAC-signed cookie `uid.expiresEpoch.sig` — no session table,
 * revocation via users.is_active. Passwords: scrypt, salt:hash hex.
 */

const COOKIE = "ob_session";
const TTL_S = 14 * 24 * 3600;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  return timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}

function sign(payload: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(payload).digest("base64url");
}

export function makeSessionToken(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_S;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const payload = `${uid}.${exp}`;
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return uid;
}

export interface SessionUser {
  id: string; email: string; name: string; role: string; orgId: string;
}

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const uid = verifySessionToken(jar.get(COOKIE)?.value);
  if (!uid) return null;
  const r = (await db.execute(sql`
    select id, email, name, role, org_id as "orgId" from users
     where id = ${uid} and is_active`)) as any;
  return r.rows[0] ?? null;
}

export async function login(email: string, password: string): Promise<string | null> {
  const r = (await db.execute(sql`
    select id, password_hash from users where lower(email) = ${email.toLowerCase()} and is_active`)) as any;
  const row = r.rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  await db.execute(sql`update users set last_login_at = now() where id = ${row.id}`);
  return makeSessionToken(row.id);
}

export const SESSION_COOKIE = COOKIE;
export const SESSION_TTL_S = TTL_S;
