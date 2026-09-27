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
