import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
const cookieValues = new Map<string, string>();
Object.assign(globalThis, { __orgAccessCookies: cookieValues });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "next/headers") return { shortCircuit: true, url: "data:text/javascript,export async function cookies(){return {get(name){const value=globalThis.__orgAccessCookies.get(name);return value ? {value} : undefined}}}" };
  if (specifier === "./request-org" && context.parentURL?.endsWith('/auth.ts')) return { shortCircuit: true, url: "data:text/javascript,export function setRequestOrg(){}" };
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, env } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { resolveActiveEnv, accessibleProductionOrgs, rebaseUuid } = await import("./org-access");
const { currentUser, makeEnvToken, SESSION_COOKIE, ACTIVE_ENV_COOKIE_NAME } = await import("./auth");
const { sessionSigningInput } = await import("./auth-token-format");
env.SESSION_SECRET = "org-access-activation-test-secret-32";

for (const superAdmin of [false, true]) {
for (const kind of ["production", "preview", "sandbox"] as const) {
  for (const active of [true, false]) {
    for (const boundary of ["resolver", "browser", "picker"] as const) {
      if (kind === "sandbox" && boundary === "picker") continue;
      test(`mapped user activation: ${superAdmin ? "platform admin" : "member"}, ${kind}, ${active ? "active" : "inactive"}, ${boundary}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
        const homeOrg = await createScratchOrg();
        const target = await createScratchOrg();
        try {
          const homeId = await createScratchUser(homeOrg.orgId, "Home member", "member");
          await db.execute(sql`update users set is_super_admin=${superAdmin} where id=${homeId}`);
          await db.execute(sql`update orgs set env_kind='production' where id=${homeOrg.orgId}`);
          await db.execute(sql`update orgs set env_kind=${kind},sandbox_of=${kind === "sandbox" ? homeOrg.orgId : null} where id=${target.orgId}`);
          const seed = (await db.execute<{ seed: string }>(sql`select sandbox_seed::text as seed from orgs where id=${target.orgId}`)).rows[0]!.seed;
          const actingId = await createScratchUser(target.orgId, "Mapped member", "member", kind === "sandbox" ? rebaseUuid(homeId, seed) as ReturnType<typeof randomUUID> : randomUUID());
          if (kind === "sandbox") await db.execute(sql`insert into sandboxes(org_id,production_org_id,name,status) values (${target.orgId},${homeOrg.orgId},'Activation review','ready')`);
          else await db.execute(sql`insert into user_org_access(member_user_id,org_id,acting_user_id,is_active) values (${homeId},${target.orgId},${actingId},true)`);
          await db.execute(sql`update users set is_active=${active} where id=${actingId}`);
          const home = { id: homeId, orgId: homeOrg.orgId, isSuperAdmin: superAdmin };
          const platformAccess = superAdmin && kind === "production";
          const admitted = active || platformAccess;
          const expectedActor = active ? actingId : platformAccess ? homeId : null;
          if (boundary === "resolver") {
            const resolved = await resolveActiveEnv(home, target.orgId);
            assert.equal(resolved?.actingUserId ?? null, expectedActor);
          } else if (boundary === "picker") {
            assert.equal((await accessibleProductionOrgs(home)).some(org => org.orgId === target.orgId), admitted);
          } else {
            const sessionId = randomUUID();
            const expiry = Math.floor(Date.now() / 1000) + 3600;
            const payload = `v2.${sessionId}.${homeId}.${expiry}`;
            const token = `${payload}.${createHmac("sha256", env.SESSION_SECRET!).update(sessionSigningInput(payload)).digest("base64url")}`;
            await db.execute(sql`insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at) values (${sessionId},${homeId},${createHash('sha256').update(token).digest('hex')},'password',${new Date(expiry * 1000)})`);
            cookieValues.set(SESSION_COOKIE, token);
            cookieValues.set(ACTIVE_ENV_COOKIE_NAME, makeEnvToken(target.orgId));
            const user = await currentUser();
            assert.ok(user);
            assert.equal(user.orgId, admitted ? target.orgId : homeOrg.orgId);
            assert.equal(user.id, expectedActor ?? homeId);
          }
        } finally {
          cookieValues.clear();
          await dropScratchOrg(target.orgId);
          await dropScratchOrg(homeOrg.orgId);
        }
      });
    }
  }
}
}
