import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withBypassContext } from '@openbooks/engine/src/platform/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts';

for (const scenario of ['pending login', 'pending enrollment', 'revoked enrollment'] as const) {
  test(`password reset invalidates ${scenario} from the previous credential`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await withBypassContext(() => createScratchOrg());
    // web/lib/auth.ts reads the session secret live from process.env (never the
// engine db.ts module-evaluation snapshot), so seed it there too.
const priorSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = randomBytes(32).toString('hex');
    try {
      const auth = await import('./auth');
      const { completePasswordReset } = await import('./auth-reset');
      const { sealSecret } = await import('./secrets');
      const { generateTotpSecret, totpCode } = await import('./auth-totp');
      const oldPassword = 'Old isolated account password 2941';
      const newPassword = 'New isolated account password 7832';
      const context = { networkAddress: '127.0.0.1', userAgent: 'isolated reset regression' };
      const secret = generateTotpSecret();
      // Fixture seeds under explicit bypass: importing ./auth above pulls in
      // the web request-org resolver, which denies every unscoped query under
      // pooled RLS (bare setup dies with 42501). The auth calls under test
      // scope their own queries internally.
      const { userId, email } = await withBypassContext(async () => {
        const userId = (await seedFlowActors(org.orgId)).adminId;
        const email = (await db.execute<{ email: string }>(sql`select email from users where id=${userId}`)).rows[0]!.email;
        await db.execute(sql`update orgs set env_kind='production' where id=${org.orgId}`);
        await db.execute(sql`update users set password_hash=${await auth.hashPassword(oldPassword)} where id=${userId}`);
        if (scenario === 'pending login') {
          await db.execute(sql`insert into auth_mfa_factors (user_id,secret_encrypted,enabled_at) values (${userId},${sealSecret(secret, { orgId: userId, purpose: "auth.mfa.secret" })},now())`);
        }
        return { userId, email };
      });
      const login = await auth.login(email, oldPassword, context);
      let enrollment: Awaited<ReturnType<typeof auth.beginMfaSetup>> = null;
      let sessionId = '';
      if (scenario === 'pending login') {
        assert.equal(login.kind, 'mfa_required');
      } else {
        assert.equal(login.kind, 'success');
        assert.ok(login.kind === 'success');
        sessionId = (await auth.validateSessionToken(login.token))!.sessionId;
        enrollment = await auth.beginMfaSetup(userId, sessionId, oldPassword, context);
        assert.ok(enrollment);
      }
      if (scenario === 'revoked enrollment') {
        assert.deepEqual(await auth.revokeUserSession(userId, sessionId, sessionId), { ok: true, revoked: true });
        assert.equal(await auth.confirmMfaSetup(userId, sessionId, totpCode(enrollment!.secret)!.code), null);
        assert.equal((await auth.getMfaStatus(userId)).enabled, false);
        return;
      }
      const rawToken = randomBytes(32).toString('base64url');
      await withBypassContext(async () => {
        await db.execute(sql`insert into auth_password_resets (user_id,token_hash,expires_at) values (${userId},${createHash('sha256').update(rawToken).digest('hex')},now()+interval '30 minutes')`);
      });
      assert.deepEqual(await completePasswordReset(rawToken, newPassword), { ok: true });
      if (scenario === 'pending login') {
        assert.ok(login.kind === 'mfa_required');
        assert.equal((await auth.completeMfaLogin(login.challengeToken, totpCode(secret)!.code, context)).kind, 'invalid');
        const fresh = await auth.login(email, newPassword, context);
        assert.ok(fresh.kind === 'mfa_required');
        assert.equal((await auth.completeMfaLogin(fresh.challengeToken, totpCode(secret)!.code, context)).kind, 'success');
      } else {
        assert.equal(await auth.confirmMfaSetup(userId, sessionId, totpCode(enrollment!.secret)!.code), null);
        assert.equal((await auth.getMfaStatus(userId)).enabled, false);
      }
      assert.equal((await auth.login(email, oldPassword, context)).kind, 'invalid');
      assert.deepEqual(await completePasswordReset(rawToken, newPassword), { ok: false, reason: 'invalid_token' });
    } finally {
      if (priorSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = priorSecret;
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  });
}


const consolidatedRows = [
  { label: "auth reset concurrency", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { createHash, randomBytes, randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypass, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const deliveries: string[] = [];
        const key = Symbol.for("openbooks.reset-concurrency-test");
        (globalThis as typeof globalThis & Record<symbol, unknown>)[key] = deliveries;
        
        // Substitute only delivery: identity resolution, transaction scopes, locks,
        // reset-token persistence and password changes use the real implementation.
        registerHooks({
          resolve(specifier, context, nextResolve) {
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
  } },
  { label: "auth reset delivery order", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomBytes } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypass, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const deliveriesKey = Symbol.for("openbooks.reset-delivery-order-test");
        const gateKey = Symbol.for("openbooks.reset-delivery-order-gate");
        const enteredKey = Symbol.for("openbooks.reset-delivery-order-entered");
        type Shared = Record<symbol, unknown>;
        const shared = globalThis as typeof globalThis & Shared;
        
        // Substitute only delivery: identity resolution, transaction scopes, locks,
        // reset-token persistence and password changes use the real implementation.
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (context.parentURL?.includes("auth-reset.ts") && specifier === "@openbooks/emails") {
              return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
                export const deriveEmailDeliveryKey = () => 'isolated-delivery';
                export const passwordResetEmail = ({resetUrl}) => ({subject:'Reset',text:resetUrl,html:resetUrl});
                export async function sendVia(transport, message) {
                  const ordered = globalThis[Symbol.for('openbooks.reset-delivery-order-test')];
                  const concurrent = globalThis[Symbol.for('openbooks.reset-concurrency-test')];
                  if (ordered) {
                    globalThis[Symbol.for('openbooks.reset-delivery-order-entered')] = true;
                    await globalThis[Symbol.for('openbooks.reset-delivery-order-gate')]();
                    ordered.push(message.text);
                  } else if (concurrent) {
                    await globalThis[Symbol.for('openbooks.reset-before-delivery-test')]?.();
                    concurrent.push(message.text);
                  }
                  return {kind:'sent',providerMessageId:'isolated'};
                }
              `)}` };
            }
            if (context.parentURL?.includes("auth-reset.ts") && specifier === "@openbooks/engine/src/delivery/email-config.ts") {
              return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
                export async function resolveOrgEmailTransport() { return {provider:'isolated'}; }
                export const insertEmailLog = async () => 'isolated-log';
                export const markEmailSent = async () => {};
                export const markEmailUncertain = async () => {};
                export const markEmailFailed = async () => {};
              `)}` };
            }
            return nextResolve(specifier, context);
          },
        });
        
        async function seedUser(orgId: string) {
          return withBypassContext(async () => {
            const userId = (await seedFlowActors(orgId)).adminId;
            const email = (await db.execute<{ email: string }>(sql`select email from users where id=${userId}`)).rows[0]!.email;
            await db.execute(sql`update orgs set env_kind='production' where id=${orgId}`);
            return { userId, email };
          });
        }
        
        function tokenOf(delivery: string): string {
          return new URL(delivery).searchParams.get("token")!;
        }
        
        test("a stalled first reset delivery lands before the superseding link", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          const deliveries: string[] = [];
          shared[deliveriesKey] = deliveries;
          // One-shot gate: the first delivery stalls until the superseding mint
          // commits; every later delivery passes through, or the second send would
          // wait on a fresh promise nobody releases.
          let gateOpen = false;
          let releaseGate!: () => void;
          const gatePromise = new Promise<void>((resolve) => { releaseGate = resolve; });
          shared[gateKey] = () => (gateOpen ? Promise.resolve() : gatePromise);
          shared[enteredKey] = false;
          try {
            const { userId, email } = await seedUser(org.orgId);
            const { requestPasswordReset, completePasswordReset } = await import("./auth-reset");
            const context = { networkAddress: "127.0.0.1", userAgent: "isolated delivery order test" };
            // The first request mints and stalls inside provider delivery while
            // holding the per-user delivery lock.
            const first = requestPasswordReset(email, context);
            const enteredDeadline = Date.now() + 10_000;
            while (!shared[enteredKey] && Date.now() < enteredDeadline) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.ok(shared[enteredKey], "first delivery must reach the provider");
            // The second request supersedes the first, then waits for the delivery
            // lock. Only after its mint commits is the gate released.
            const second = requestPasswordReset(email, { networkAddress: "127.0.0.2", userAgent: "isolated delivery order test" });
            const mintedDeadline = Date.now() + 10_000;
            let minted = 0;
            while (minted < 2 && Date.now() < mintedDeadline) {
              minted = await withBypass(async () => (await db.execute<{ n: number }>(sql`
                select count(*)::int as n from auth_password_resets where user_id=${userId}`)).rows[0]!.n);
              if (minted < 2) await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(minted, 2);
            gateOpen = true;
            releaseGate();
            await Promise.all([first, second]);
            // Both sends completed in mint order: the most recent email holds the
            // live link, and only that link completes a reset.
            assert.equal(deliveries.length, 2);
            const [staleToken, liveToken] = [tokenOf(deliveries[0]!), tokenOf(deliveries[1]!)];
            assert.notEqual(staleToken, liveToken);
            assert.deepEqual(await completePasswordReset(staleToken, "Stale isolated password 4410"), {
              ok: false, reason: "invalid_token",
            });
            assert.deepEqual(await completePasswordReset(liveToken, "Live isolated password 4411"), { ok: true });
          } finally {
            delete shared[gateKey];
            delete shared[enteredKey];
            delete shared[deliveriesKey];
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
        
        test("delivering a superseded reset token sends nothing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          const deliveries: string[] = [];
          shared[deliveriesKey] = deliveries;
          shared[gateKey] = async () => {};
          try {
            const { userId, email } = await seedUser(org.orgId);
            const { requestPasswordReset, deliverResetEmail } = await import("./auth-reset");
            const context = { networkAddress: "127.0.0.1", userAgent: "isolated superseded delivery test" };
            await requestPasswordReset(email, context);
            await requestPasswordReset(email, { networkAddress: "127.0.0.2", userAgent: "isolated superseded delivery test" });
            assert.equal(deliveries.length, 2);
            const staleToken = tokenOf(deliveries[0]!);
            const sent = await withOrgContext(org.orgId, async () => {
              const user = (await db.execute<{ id: string; org_id: string; name: string | null; email: string }>(sql`
                select id, org_id, name, email from users where id=${userId}`)).rows[0]!;
              return deliverResetEmail(user, { provider: "isolated" } as never, staleToken);
            });
            assert.equal(sent, false);
            assert.equal(deliveries.length, 2, "no additional send may follow a superseded delivery");
          } finally {
            delete shared[gateKey];
            delete shared[deliveriesKey];
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
  { label: "auth reset kdf", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { createHash, randomBytes } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypass } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { hashPassword, verifyPassword } = await import("./auth-password");
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
            if (context.parentURL?.includes("auth-reset.ts") && specifier === "./auth") {
              return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
                export { authContextHashes } from ${JSON.stringify(new URL('./auth.ts', context.parentURL).href)};
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
  } },
] as const;

for (const row of consolidatedRows) await row.register();


const authCredentialCases = [
  { label: "auth blank email", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
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
  } },
  { label: "auth credential expiry", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { createHash, randomBytes, randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypass, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        for (const method of ["reset", "begin MFA", "confirm MFA"] as const) {
          for (const expires of [true, false]) {
            test(`${method} ${expires ? "refuses a credential expiring" : "accepts an unexpired credential"} while waiting for its user lock`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
              const org = await withBypassContext(() => createScratchOrg());
              // web/lib/auth.ts reads the session secret live from process.env (never the
        // engine db.ts module-evaluation snapshot), so seed it there too.
        const priorSecret = process.env.SESSION_SECRET;
              process.env.SESSION_SECRET = randomBytes(32).toString("hex");
              let release = () => {};
              let holder: Promise<void> | undefined;
              let contender: Promise<unknown> | undefined;
              try {
                const auth = await import("./auth");
                const { completePasswordReset } = await import("./auth-reset");
                const { sealSecret } = await import("./secrets");
                const { generateTotpSecret, totpCode } = await import("./auth-totp");
                const password = "Isolated original password 8614";
                const originalHash = await auth.hashPassword(password);
                const sessionId = randomUUID();
                const rawToken = randomBytes(32).toString("base64url");
                const secret = generateTotpSecret();
                const duration = expires ? "1 second" : "30 minutes";
                // MFA enrollment checks use the application clock; reset consumption
                // is checked in SQL. Seed each credential in its consumer's domain.
                const sessionExpiry = new Date(Date.now() + (expires ? 1000 : 30 * 60_000));
                // Fixture seeds under explicit bypass: importing ./auth above pulls in
                // the web request-org resolver, which denies every unscoped query
                // under pooled RLS (bare setup dies with 42501, reads see zero rows).
                // The credential calls under test scope their own queries internally.
                const userId = await withBypassContext(async () => {
                  const userId = (await seedFlowActors(org.orgId)).adminId;
                  await db.execute(sql`update users set password_hash=${originalHash} where id=${userId}`);
                  if (method !== "reset") {
                    await db.execute(sql`insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at)
                      values (${sessionId},${userId},${createHash("sha256").update(rawToken).digest("hex")},'password',${sessionExpiry})`);
                    if (method === "confirm MFA") await db.execute(sql`
                      insert into auth_mfa_factors(user_id,secret_encrypted,setup_session_id,setup_expires_at)
                      values (${userId},${sealSecret(secret, { orgId: userId, purpose: "auth.mfa.secret" })},${sessionId},${new Date(Date.now()+30*60_000)})`);
                  } else {
                    await db.execute(sql`insert into auth_password_resets(user_id,token_hash,expires_at)
                      values (${userId},${createHash("sha256").update(rawToken).digest("hex")},clock_timestamp()+${duration}::interval)`);
                  }
                  return userId;
                });
                let staged!: () => void;
                const ready = new Promise<void>(resolve => { staged = resolve; });
                const hold = new Promise<void>(resolve => { release = resolve; });
                let holderPid = 0;
                holder = withBypass(async () => {
                  holderPid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
                  await db.execute(sql`select id from users where id=${userId} for update`);
                  staged();
                  await hold;
                });
                await Promise.race([ready, holder]);
                contender = method === "reset" ? completePasswordReset(rawToken, "Isolated replacement password 7861")
                  : method === "begin MFA" ? auth.beginMfaSetup(userId, sessionId, password, { networkAddress: "127.0.0.1", userAgent: "expiry regression" })
                  : auth.confirmMfaSetup(userId, sessionId, totpCode(secret)!.code);
                let settled = false;
                void contender.then(() => { settled = true; }, () => { settled = true; });
                let blocked = false;
                const deadline = Date.now() + 5000;
                while (!settled && Date.now() < deadline) {
                  blocked = await withBypassContext(async () => (await db.execute<{ blocked: boolean }>(sql`select exists(
                    select 1 from pg_stat_activity where datname=current_database() and ${holderPid}=any(pg_blocking_pids(pid))
                  ) as blocked`)).rows[0]!.blocked);
                  if (blocked) break;
                  await new Promise(resolve => setTimeout(resolve, 10));
                }
                assert.ok(blocked, "the credential must still be valid when the operation starts waiting");
                if (expires) {
                  let expired = false;
                  while (Date.now() < deadline) {
                    expired = await withOrgContext(org.orgId, async () => (await db.execute<{ expired: boolean }>(method === "reset"
                      ? sql`select expires_at <= clock_timestamp() as expired from auth_password_resets where user_id=${userId}`
                      : sql`select expires_at <= ${new Date()} as expired from auth_sessions where id=${sessionId}`)).rows[0]!.expired);
                    if (expired) break;
                    await new Promise(resolve => setTimeout(resolve, 20));
                  }
                  assert.ok(expired, "release only after the credential expires in its authoritative clock domain");
                }
                release();
                await holder;
                const result = await contender;
                // Verification reads run in the scratch org's scope.
                await withOrgContext(org.orgId, async () => {
                  if (method === "reset") {
                    assert.deepEqual(result, expires ? { ok: false, reason: "invalid_token" } : { ok: true });
                    if (expires) assert.equal((await db.execute<{ password_hash: string }>(sql`select password_hash from users where id=${userId}`)).rows[0]!.password_hash, originalHash);
                  } else {
                    if (expires) assert.equal(result, null);
                    else assert.ok(result);
                    const factor = (await db.execute<{ enabled_at: string | null }>(sql`select enabled_at from auth_mfa_factors where user_id=${userId}`)).rows[0];
                    if (method === "begin MFA" && expires) assert.equal(factor, undefined);
                    if (method === "confirm MFA") assert.equal(Boolean(factor?.enabled_at), !expires);
                  }
                });
              } finally {
                release();
                await Promise.allSettled([holder, contender]);
                if (priorSecret === undefined) delete process.env.SESSION_SECRET;
                else process.env.SESSION_SECRET = priorSecret;
                await withBypassContext(() => dropScratchOrg(org.orgId));
              }
            });
          }
        }
  } },
  { label: "auth proxy session", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { createHash, createHmac, randomBytes, randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { NextRequest } = await import("next/server");
        const { sql } = await import("drizzle-orm");
        // The request proxy checks server-side session revocation on every private
        // request: a revoked session cookie is refused 401 at the edge instead of
        // reaching any route, while a live one passes through. Tokens are minted
        // with the same HMAC scheme the proxy verifies, against real session rows.
        const { db, withBypassContext: withBypass } = await import(
          "@openbooks/engine/src/platform/db.ts"
        );
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
          "@openbooks/engine/src/testing/fixtures.ts"
        );
        const { proxy } = await import("../proxy.ts");
        const { sessionSigningInput } = await import("./auth-token-format.ts");

        function mintSessionCookie(secret: string, sessionId: string, userId: string): string {
          const payload = `v2.${sessionId}.${userId}.${Math.floor(Date.now() / 1000) + 3600}`;
          const signature = createHmac("sha256", secret)
            .update(sessionSigningInput(payload))
            .digest("base64url");
          return `${payload}.${signature}`;
        }

        function apiRequest(token: string): NextRequest {
          return new NextRequest("http://openbooks.test/api/gl/accounts", {
            headers: { cookie: `ob_session=${token}` },
          });
        }

        async function seedSession(orgId: string, userId: string, token: string, revoked: boolean): Promise<void> {
          const parsed = token.split(".");
          await withBypass(() =>
            db.execute(sql`
              insert into auth_sessions (id, user_id, token_hash, auth_method, expires_at, revoked_at)
              values (
                ${parsed[1]}, ${userId}, ${createHash("sha256").update(token).digest("hex")},
                'password', ${new Date(Date.now() + 3_600_000)},
                ${revoked ? new Date() : null}
              )
            `),
          );
          await withBypass(() => db.execute(sql`update users set is_active = true where id = ${userId}`));
        }

        test("the proxy refuses a revoked session cookie with 401 JSON", async () => {
          const scratch = await withBypass(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const userId = (await withBypass(() => seedFlowActors(scratch.orgId))).adminId;
            const token = mintSessionCookie(process.env.SESSION_SECRET, randomUUID(), userId);
            await seedSession(scratch.orgId, userId, token, true);

            const response = await proxy(apiRequest(token));
            assert.equal(response.status, 401);
            assert.deepEqual(await response.json(), {
              error: "unauthorized",
              requestId: response.headers.get("x-request-id"),
            });
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypass(() => dropScratchOrg(scratch.orgId));
          }
        });

        test("the proxy passes a live session cookie through to the route", async () => {
          const scratch = await withBypass(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const userId = (await withBypass(() => seedFlowActors(scratch.orgId))).adminId;
            const token = mintSessionCookie(process.env.SESSION_SECRET, randomUUID(), userId);
            await seedSession(scratch.orgId, userId, token, false);

            const response = await proxy(apiRequest(token));
            assert.equal(response.status, 200);
            assert.ok(response.headers.get("x-request-id"), "passthrough carries the edge request id");
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypass(() => dropScratchOrg(scratch.orgId));
          }
        });

        test("the proxy refuses a forged session cookie with 401 JSON", async () => {
          const scratch = await withBypass(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const userId = (await withBypass(() => seedFlowActors(scratch.orgId))).adminId;
            const forged = mintSessionCookie(randomBytes(32).toString("hex"), randomUUID(), userId);

            const response = await proxy(apiRequest(forged));
            assert.equal(response.status, 401);
            assert.equal((await response.json() as { error: string }).error, "unauthorized");
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypass(() => dropScratchOrg(scratch.orgId));
          }
        });
  } },
  { label: "auth session revoke liveness", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomBytes, randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypass, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        async function seedSessions(orgId: string) {
          return withBypassContext(async () => {
            const userId = (await seedFlowActors(orgId)).adminId;
            const caller = randomUUID();
            const others = [randomUUID(), randomUUID()];
            for (const id of [caller, ...others]) await db.execute(sql`
              insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at)
              values (${id},${userId},${randomBytes(32).toString("hex")},'password',${new Date(Date.now() + 86_400_000)})`);
            return { userId, caller, others };
          });
        }

        async function revokedById(orgId: string, userId: string) {
          return withOrgContext(orgId, async () => (await db.execute<{ id: string; revoked: boolean }>(sql`
            select id, (revoked_at is not null) as revoked from auth_sessions where user_id=${userId} order by id`)).rows);
        }

        test("revokeOtherUserSessions refuses when the keeper session was revoked first", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const auth = await import("./auth");
            const { userId, caller, others } = await seedSessions(org.orgId);
            await withBypassContext(async () => {
              await db.execute(sql`update auth_sessions set revoked_at=now(), revocation_reason='user_revoked' where id=${caller}`);
            });
            assert.deepEqual(await auth.revokeOtherUserSessions(userId, caller), {
              ok: false, reason: "caller_session_revoked",
            });
            for (const row of await revokedById(org.orgId, userId)) {
              assert.equal(row.revoked, row.id === caller, `only the pre-revoked keeper may be revoked: ${row.id}`);
            }
            assert.ok(others.length === 2);
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });

        test("revokeOtherUserSessions revokes the others for a live keeper", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const auth = await import("./auth");
            const { userId, caller, others } = await seedSessions(org.orgId);
            assert.deepEqual(await auth.revokeOtherUserSessions(userId, caller), { ok: true, revoked: others.length });
            const rows = await revokedById(org.orgId, userId);
            assert.equal(rows.find((row) => row.id === caller)?.revoked, false);
            for (const id of others) assert.equal(rows.find((row) => row.id === id)?.revoked, true);
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });

        test("revokeUserSession refuses a dead caller without touching the target", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const auth = await import("./auth");
            const { userId, caller, others } = await seedSessions(org.orgId);
            await withBypassContext(async () => {
              await db.execute(sql`update auth_sessions set revoked_at=now(), revocation_reason='user_revoked' where id=${caller}`);
            });
            assert.deepEqual(await auth.revokeUserSession(userId, others[0]!, caller), {
              ok: false, reason: "caller_session_revoked",
            });
            assert.equal((await revokedById(org.orgId, userId)).find((row) => row.id === others[0])?.revoked, false);
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });

        test("revokeUserSession revokes another session and its own for a live caller", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const auth = await import("./auth");
            const { userId, caller, others } = await seedSessions(org.orgId);
            assert.deepEqual(await auth.revokeUserSession(userId, others[0]!, caller), { ok: true, revoked: true });
            assert.deepEqual(await auth.revokeUserSession(userId, randomUUID(), caller), { ok: true, revoked: false });
            assert.deepEqual(await auth.revokeUserSession(userId, caller, caller), { ok: true, revoked: true });
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });

        test("revokeOtherUserSessions refuses a keeper revoked while it waited on the lock", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          let release = () => {};
          let held: Promise<unknown> | undefined;
          let contender: Promise<import("./auth").RevokeSessionsResult> | undefined;
          try {
            const auth = await import("./auth");
            const { userId, caller, others } = await seedSessions(org.orgId);
            const hold = new Promise<void>((resolve) => { release = resolve; });
            let holderPid = 0;
            held = withBypass(async () => {
              holderPid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
              await db.execute(sql`update auth_sessions set revoked_at=now(), revocation_reason='user_revoked' where id=${caller}`);
              await hold;
            });
            const deadline = Date.now() + 10_000;
            while ((await withBypassContext(async () => (await db.execute<{ n: number }>(sql`
              select count(*)::int as n from pg_stat_activity where datname=current_database() and pid=${holderPid} and state <> 'idle'
            `)).rows[0]!.n)) === 0 && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            contender = auth.revokeOtherUserSessions(userId, caller);
            let settled = false;
            void contender.then(() => { settled = true; }, () => { settled = true; });
            const blockDeadline = Date.now() + 10_000;
            let blocked = false;
            while (!settled && Date.now() < blockDeadline) {
              blocked = await withBypassContext(async () => (await db.execute<{ blocked: boolean }>(sql`select exists(
                select 1 from pg_stat_activity where datname=current_database()
                  and ${holderPid}=any(pg_blocking_pids(pid))
              ) as blocked`)).rows[0]!.blocked);
              if (blocked) break;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.ok(blocked, "revocation must reach the held keeper lock before revoking");
            release();
            await held;
            assert.deepEqual(await contender, { ok: false, reason: "caller_session_revoked" });
            assert.equal(others.length, 2);
            for (const id of others) {
              assert.equal((await revokedById(org.orgId, userId)).find((row) => row.id === id)?.revoked, false);
            }
          } finally {
            release();
            await Promise.allSettled([held, contender]);
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
] as const;

for (const row of authCredentialCases) await row.register();
