import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";

const deliveries: string[] = [];
const key = Symbol.for("openbooks.reset-concurrency-test");
(globalThis as typeof globalThis & Record<symbol, unknown>)[key] = deliveries;

// Substitute only delivery: identity resolution, transaction scopes, locks,
// reset-token persistence and password changes use the real implementation.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (context.parentURL?.includes("auth-reset.ts") && specifier === "@openbooks/emails") {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
        export const deriveEmailDeliveryKey = () => 'isolated-delivery';
        export const passwordResetEmail = ({resetUrl}) => ({subject:'Reset',text:resetUrl,html:resetUrl});
        export async function sendVia(transport, message) {
          await globalThis[Symbol.for('openbooks.reset-before-delivery-test')]?.();
          globalThis[Symbol.for('openbooks.reset-concurrency-test')].push(message.text);
          return {kind:'sent',providerMessageId:'isolated'};
        }
      `)}` };
    }
    if (context.parentURL?.includes("auth-reset.ts") && specifier === "@openbooks/engine/src/delivery/email-config.ts") {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
        export async function resolveOrgEmailTransport() {
          await new Promise(resolve => setTimeout(resolve,100));
          return {provider:'isolated'};
        }
        export const insertEmailLog = async () => 'isolated-log';
        export const markEmailSent = async () => {};
        export const markEmailUncertain = async () => {};
        export const markEmailFailed = async () => {};
      `)}` };
    }
    return nextResolve(specifier, context);
  },
});

test("concurrent password reset requests honor the hourly cap and leave one usable link", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // Fixture seeds under explicit bypass: the lazy ./auth-reset import below
  // pulls in the web request-org resolver, which denies every unscoped query
  // under pooled RLS — without scope the second test's bare setup dies with
  // 42501. The reset calls under test scope their own queries internally.
  const org = await withBypassContext(() => createScratchOrg());
  // web/lib/auth.ts reads the session secret live from process.env (never the
// engine db.ts module-evaluation snapshot), so seed it there too.
const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  deliveries.length = 0;
  try {
    const { userId, email } = await withBypassContext(async () => {
      const userId = (await seedFlowActors(org.orgId)).adminId;
      const email = (await db.execute<{ email: string }>(sql`select email from users where id=${userId}`)).rows[0]!.email;
      await db.execute(sql`update orgs set env_kind='production' where id=${org.orgId}`);
      for (let index = 0; index < 2; index++) {
        await db.execute(sql`insert into auth_password_resets (user_id,token_hash,expires_at)
          values (${userId},${randomUUID()},now()-interval '1 minute')`);
      }
      return { userId, email };
    });
    const { requestPasswordReset, completePasswordReset } = await import("./auth-reset");
    (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.reset-before-delivery-test")] = async () => {
      // A separate transaction must see the issued token before the provider
      // accepts a link. This also keeps provider I/O outside the user lock.
      const visible = await withBypass(async () => (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from auth_password_resets
         where user_id=${userId} and used_at is null and expires_at>now()`)).rows[0]!.n);
      assert.equal(visible, 1);
    };
    await Promise.all(Array.from({ length: 8 }, () => requestPasswordReset(email, { networkAddress: "127.0.0.1", userAgent: "isolated concurrency test" })));
    // Verification reads run in the scratch org's scope.
    const counts = await withOrgContext(org.orgId, async () => (await db.execute<{ issued: number; usable: number }>(sql`
      select count(*)::int as issued, count(*) filter (where used_at is null and expires_at>now())::int as usable
        from auth_password_resets where user_id=${userId}`)).rows[0]!);
    assert.deepEqual(counts, { issued: 3, usable: 1 });
    assert.equal(deliveries.length, 1);
    const token = new URL(deliveries[0]!).searchParams.get("token")!;
    assert.deepEqual(await completePasswordReset(token, "New isolated password 8914"), { ok: true });
    assert.deepEqual(await completePasswordReset(token, "Another isolated password 9102"), { ok: false, reason: "invalid_token" });
  } finally {
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.reset-before-delivery-test")];
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("concurrent completion of legacy reset links changes the password only once", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { userId, tokens } = await withBypassContext(async () => {
      const userId = (await seedFlowActors(org.orgId)).adminId;
      const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
      for (const token of tokens) {
        await db.execute(sql`insert into auth_password_resets (user_id,token_hash,expires_at)
          values (${userId},${createHash("sha256").update(token).digest("hex")},now()+interval '30 minutes')`);
      }
      return { userId, tokens };
    });
    const { completePasswordReset } = await import("./auth-reset");
    const outcomes = await Promise.all(tokens.map((token, index) => completePasswordReset(token, `Isolated concurrent reset password ${index}`)));
    assert.equal(outcomes.filter(outcome => outcome.ok).length, 1);
    assert.equal(outcomes.filter(outcome => !outcome.ok && outcome.reason === "invalid_token").length, 1);
    // Verification reads run in the scratch org's scope.
    await withOrgContext(org.orgId, async () => {
      const remaining = (await db.execute<{ n: number }>(sql`select count(*)::int as n from auth_password_resets
        where user_id=${userId} and used_at is null and expires_at>now()`)).rows[0]!.n;
      assert.equal(remaining, 0);
      const audit = (await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log
        where org_id=${org.orgId} and row_id=${userId} and changes->>'passwordReset'='true'`)).rows[0]!.n;
      assert.equal(audit, 1);
    });
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
});

test("the invite issuance gate shares the mint transaction", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // The admin invite gate must re-verify the caller's ceiling in the SAME
  // transaction that mints the token: the gate's row lock then serializes a
  // concurrent grant, so no elevation can land between the check and the
  // mint. Same-transaction is observable — the gate's transaction id must
  // equal the minted token row's xmin — and a refusal inside the gate must
  // roll the mint back with it, leaving no token behind.
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { userId, email } = await withBypassContext(async () => {
      const userId = (await seedFlowActors(org.orgId)).adminId;
      const email = (await db.execute<{ email: string }>(sql`select email from users where id=${userId}`)).rows[0]!.email;
      await db.execute(sql`update orgs set env_kind='production' where id=${org.orgId}`);
      return { userId, email };
    });
    const { issueInviteSetPasswordLink, InviteIssuanceRefusedError } = await import("./auth-reset");
    const context = { networkAddress: "127.0.0.1", userAgent: "isolated gate-transaction test" };
    let gateXid: string | null = null;
    const issuance = await issueInviteSetPasswordLink({
      user: { id: userId, org_id: org.orgId, name: "Gate subject", email },
      context,
      authorize: async () => {
        gateXid = (await db.execute<{ xid: string }>(sql`select pg_current_xact_id()::text as xid`)).rows[0]!.xid;
      },
    });
    assert.ok(issuance, "issuance succeeds when the gate allows it");
    assert.ok(gateXid, "the gate ran");
    const minted = await withBypassContext(() => db.execute<{ xid: string }>(sql`
      select xmin::text as xid from auth_password_resets
       where user_id=${userId} and used_at is null and expires_at>now()
       order by created_at desc limit 1`));
    assert.equal(minted.rows[0]!.xid, gateXid, "gate and mint commit atomically in one transaction");
    // A refusal thrown by the gate rolls the whole issuance back: the token
    // count is unchanged, so no link exists to hand out.
    await assert.rejects(
      () => issueInviteSetPasswordLink({
        user: { id: userId, org_id: org.orgId, name: "Gate subject", email },
        context,
        authorize: async () => {
          throw new InviteIssuanceRefusedError({ error: "cannot issue this link", status: 403 });
        },
      }),
      (error: unknown) => error instanceof InviteIssuanceRefusedError,
    );
    const live = await withBypassContext(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from auth_password_resets
       where user_id=${userId} and used_at is null and expires_at>now()`));
    assert.equal(live.rows[0]!.n, 1, "the refused issuance minted nothing");
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
});
