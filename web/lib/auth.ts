import "server-only";
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import { env } from "@openbooks/engine/src/db.ts";
import { resolveActiveEnv } from "./org-access";
import { setRequestOrg } from "./request-org";

/**
 * Sessions: HMAC-signed cookie `uid.expiresEpoch.sig` — no session table,
 * revocation via users.is_active. Passwords: scrypt, salt:hash hex.
 */

const COOKIE = "ob_session";
const ACTIVE_ENV_COOKIE = "ob_active_env";
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

/**
 * A signed environment cookie lets a production user "enter" one of their
 * sandboxes without touching the identity token: `sandboxOrgId.exp.sig`. When
 * present and valid, `currentUser().orgId` is the sandbox org, so every
 * `where org_id = user.orgId` query transparently retargets to the sandbox.
 */
export function makeEnvToken(sandboxOrgId: string): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_S;
  const payload = `${sandboxOrgId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyEnvToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [orgId, exp, sig] = parts;
  const payload = `${orgId}.${exp}`;
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return orgId;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  /** Effective org — the sandbox org when one is entered, else the home org. */
  orgId: string;
  /** Environment the request is operating in. */
  envKind: "production" | "sandbox" | "preview";
  /** Production org backing the active env (itself when in a production org). */
  productionOrgId: string;
  /** Display name of the active org/sandbox. */
  sandboxName?: string;
  /** Cross-tenant super admin — sees the super console and every org. */
  isSuperAdmin: boolean;
  /** The login identity's home users row + org (unchanged by switching). */
  homeUserId: string;
  homeOrgId: string;
}

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const uid = verifySessionToken(jar.get(COOKIE)?.value);
  if (!uid) return null;
  // Identity bootstrap reads under bypass: the home users row lives in the
  // login's PRODUCTION org, which differs from the active org when the request
  // is already scoped to a sandbox/sibling tenant (currentUser runs more than
  // once per request — layout and page each resolve it).
  const home = await withBypassContext(async () => {
    const r = (await db.execute(sql`
      select id, email, name, role, org_id as "orgId", is_super_admin as "isSuperAdmin"
        from users where id = ${uid} and is_active`)) as any;
    return r.rows[0];
  });
  if (!home) return null;

  const homeUser = { id: home.id as string, orgId: home.orgId as string, isSuperAdmin: !!home.isSuperAdmin };
  // The active-org cookie can carry ANY org the login may reach (a sibling
  // production tenant or a sandbox). Resolution validates access and maps the
  // acting users row; a tampered/stale/revoked value simply falls back to home.
  const activeOrgId = verifyEnvToken(jar.get(ACTIVE_ENV_COOKIE)?.value);
  const env =
    (await resolveActiveEnv(homeUser, activeOrgId)) ?? (await resolveActiveEnv(homeUser, null))!;

  // Scope the rest of this request to the effective org (RLS enforced).
  setRequestOrg(env.orgId);
  return {
    id: env.actingUserId,
    email: home.email,
    name: home.name,
    role: home.role,
    orgId: env.orgId,
    envKind: env.envKind,
    productionOrgId: env.productionOrgId,
    sandboxName: env.sandboxName,
    isSuperAdmin: homeUser.isSuperAdmin,
    homeUserId: homeUser.id,
    homeOrgId: homeUser.orgId,
  };
}

export const ACTIVE_ENV_COOKIE_NAME = ACTIVE_ENV_COOKIE;

export async function login(email: string, password: string): Promise<string | null> {
  // The login identity is always a PRODUCTION users row. Sandboxes clone the
  // users table, so the same email can exist in a sandbox org too — those are
  // reached by switching in, never by logging in. Oldest production row wins if
  // an email somehow spans production tenants. Spans orgs by design → bypass.
  return withBypassContext(async () => {
    const r = (await db.execute(sql`
      select u.id, u.password_hash
        from users u join orgs o on o.id = u.org_id
       where lower(u.email) = ${email.toLowerCase()} and u.is_active and o.env_kind = 'production'
       order by u.created_at
       limit 1`)) as any;
    const row = r.rows[0];
    if (!row || !verifyPassword(password, row.password_hash)) return null;
    await db.execute(sql`update users set last_login_at = now() where id = ${row.id}`);
    return makeSessionToken(row.id);
  });
}

export const SESSION_COOKIE = COOKIE;
export const SESSION_TTL_S = TTL_S;
