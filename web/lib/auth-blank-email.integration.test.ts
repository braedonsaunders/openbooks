import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });

const { login } = await import("./auth");

const DB = !!process.env.OPENBOOKS_DB_URL;
const context = { networkAddress: "127.0.0.1", userAgent: "blank-email regression" };

async function nullHashStateRows(): Promise<number> {
  const rows = (await withBypassContext(() => db.execute<{ n: number }>(sql`
    select count(*)::int as n from auth_login_state where email_hash is null`))).rows;
  return rows[0]!.n;
}

async function recentNullUserStateRows(): Promise<Array<{ email_hash: string }>> {
  return (await withBypassContext(() => db.execute<{ email_hash: string }>(sql`
    select email_hash from auth_login_state
     where user_id is null and updated_at > now() - interval '5 minutes'`))).rows;
}

test("blank, whitespace and malformed login emails get a generic invalid with no null-hash state", { skip: !DB }, async () => {
  const before = await nullHashStateRows();
  try {
    for (const bad of ["", "   ", "not-an-email", "x".repeat(400)]) {
      const result = await login(bad, "probe-only", context);
      assert.equal(result.kind, "invalid", `email ${JSON.stringify(bad.slice(0, 20))} must be a generic invalid`);
    }
    // The refusal that used to be a bare 500 with an auth_login_state
    // NOT NULL violation: no null email_hash row may exist.
    assert.equal(await nullHashStateRows(), before);
    // The attempts still count toward the rate limit under a non-null bucket.
    const recent = await recentNullUserStateRows();
    assert.ok(recent.length > 0, "blank-email attempts must still record rate-limit state");
    assert.ok(recent.every((row) => typeof row.email_hash === "string" && row.email_hash.length > 0));
  } finally {
    await withBypassContext(() => db.execute(sql`
      delete from auth_login_state where user_id is null and updated_at > now() - interval '5 minutes'`));
  }
});
