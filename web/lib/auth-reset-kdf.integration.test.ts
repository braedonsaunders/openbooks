import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/src/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/test-fixtures.ts";
import { hashPassword, verifyPassword } from "./auth-password";

const state = {
  hashes: 0,
  beforeHash: async () => {},
  async hash(password: string) {
    this.hashes++;
    await this.beforeHash();
    return hashPassword(password);
  },
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.reset-kdf-test")] = state;

// Observe the real KDF boundary; all token reads, locks and writes use PostgreSQL.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (context.parentURL?.includes("auth-reset.ts") && specifier === "./auth") {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
        export function authContextHashes() { throw new Error('No reset email delivery in this test'); }
        export function hashPassword(password) {
          return globalThis[Symbol.for('openbooks.reset-kdf-test')].hash(password);
        }
      `)}` };
    }
    return nextResolve(specifier, context);
  },
});

for (const scenario of ["unknown", "expired", "used", "inactive", "valid", "consumed during KDF", "deactivated during KDF"] as const) {
  test(`reset KDF admission and locked recheck: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    state.hashes = 0;
    state.beforeHash = async () => {};
    try {
      const userId = (await seedFlowActors(org.orgId)).adminId;
      const originalHash = (await db.execute<{ password_hash: string | null }>(sql`
        select password_hash from users where id=${userId}
      `)).rows[0]!.password_hash;
      const token = randomBytes(32).toString("base64url");
      if (scenario !== "unknown") {
        await db.execute(sql`insert into auth_password_resets (user_id,token_hash,expires_at,used_at)
          values (${userId},${createHash("sha256").update(token).digest("hex")},
            now() + ${scenario === "expired" ? "-1 minute" : "30 minutes"}::interval,
            ${scenario === "used" ? sql`now()` : sql`null`})`);
      }
      if (scenario === "inactive") await db.execute(sql`update users set is_active=false where id=${userId}`);
      state.beforeHash = async () => {
        // These separate transactions must complete: no user/token lock may
        // survive the cheap admission check into the expensive KDF operation.
        if (scenario === "consumed during KDF") {
          await withBypass(async () => {
            await db.execute(sql`set local lock_timeout='1s'`);
            await db.execute(sql`update auth_password_resets set used_at=now() where user_id=${userId}`);
          });
        } else if (scenario === "deactivated during KDF") {
          await withBypass(async () => {
            await db.execute(sql`set local lock_timeout='1s'`);
            await db.execute(sql`update users set is_active=false where id=${userId}`);
          });
        }
      };
      const { completePasswordReset } = await import("./auth-reset");
      const password = "New isolated password 8264";
      assert.deepEqual(await completePasswordReset(token, password), scenario === "valid"
        ? { ok: true } : { ok: false, reason: "invalid_token" });
      assert.equal(state.hashes, ["valid", "consumed during KDF", "deactivated during KDF"].includes(scenario) ? 1 : 0);
      const stored = (await db.execute<{ password_hash: string | null }>(sql`
        select password_hash from users where id=${userId}
      `)).rows[0]!.password_hash;
      if (scenario === "valid") {
        assert.ok(stored);
        assert.equal((await verifyPassword(password, stored)).valid, true);
      } else {
        assert.equal(stored, originalHash);
      }
      const audits = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from audit_log where org_id=${org.orgId}
          and row_id=${userId} and changes->>'passwordReset'='true'
      `)).rows[0]!.n;
      assert.equal(audits, scenario === "valid" ? 1 : 0);
    } finally {
      state.beforeHash = async () => {};
      await dropScratchOrg(org.orgId);
    }
  });
}
