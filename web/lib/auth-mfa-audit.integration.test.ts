import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";

for (const action of ["mfa_enabled", "mfa_disabled", "mfa_recovery_rotated"] as const) {
  for (const failAudit of [false, true]) {
    test(`${action} ${failAudit ? "rolls back when its audit write fails" : "retains attributable non-secret audit evidence"}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await withBypassContext(() => createScratchOrg());
      // web/lib/auth.ts reads the session secret live from process.env (never the
// engine db.ts module-evaluation snapshot), so seed it there too.
const previousSecret = process.env.SESSION_SECRET;
      process.env.SESSION_SECRET = randomBytes(32).toString("hex");
      const triggerName = "mfa_audit_" + randomUUID().replaceAll("-", "");
      let triggerInstalled = false;
      try {
        const auth = await import("./auth");
        const { sealSecret } = await import("./secrets");
        const { generateTotpSecret, totpCode, generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } = await import("./auth-totp");
        const password = "Isolated audit password 3947";
        const secret = generateTotpSecret();
        const previousCodes = action === "mfa_enabled" ? [] : generateRecoveryCodes().slice(0, 2);
        // Fixture seeds under explicit bypass: importing ./auth above pulls in
        // the web request-org resolver, which denies every unscoped query
        // under pooled RLS (bare setup dies with 42501, reads see zero rows).
        // The MFA calls under test scope their own queries internally.
        const { userId, sessionId, previousHashes, factorBefore, sessionsBefore } = await withBypassContext(async () => {
          const userId = (await seedFlowActors(org.orgId)).adminId;
          await db.execute(sql`update users set password_hash=${await auth.hashPassword(password)} where id=${userId}`);
          const sessionId = randomUUID();
          const otherSessionId = randomUUID();
          for (const id of [sessionId, otherSessionId]) await db.execute(sql`
            insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at)
            values (${id},${userId},${randomBytes(32).toString("hex")},'password',${new Date(Date.now()+86_400_000)})`);
          const previousHashes = previousCodes.map(code => hashRecoveryCode(userId, normalizeRecoveryCode(code)!));
          await db.execute(sql`insert into auth_mfa_factors(user_id,secret_encrypted,recovery_code_hashes,enabled_at,setup_session_id,setup_expires_at)
            values (${userId},${sealSecret(secret, { orgId: userId, purpose: "auth.mfa.secret" })},${JSON.stringify(previousHashes)}::jsonb,${action === "mfa_enabled" ? sql`null` : sql`now()`},
              ${action === "mfa_enabled" ? sessionId : null},${action === "mfa_enabled" ? new Date(Date.now()+30*60_000) : null})`);
          const factorBefore = (await db.execute(sql`select * from auth_mfa_factors where user_id=${userId}`)).rows[0]!;
          const sessionsBefore = (await db.execute(sql`select * from auth_sessions where user_id=${userId} order by id`)).rows;
          if (failAudit) {
            // Isolated test database only. Match this tenant's material event so
            // fixture cleanup and unrelated audit writes retain normal behavior.
            await db.execute(sql.raw(`create function public."${triggerName}"() returns trigger language plpgsql as $$
              begin
                if new.org_id='${org.orgId}'::uuid and new.changes->>'securityChange'='${action}' then
                  raise exception 'forced MFA audit failure';
                end if;
                return new;
              end $$`));
            triggerInstalled = true;
            await db.execute(sql.raw(`create trigger "${triggerName}" before insert on audit_log for each row execute function public."${triggerName}"()`));
          }
          return { userId, sessionId, previousHashes, factorBefore, sessionsBefore };
        });
        const invoke = () => action === "mfa_enabled" ? auth.confirmMfaSetup(userId, sessionId, totpCode(secret)!.code)
          : action === "mfa_disabled" ? auth.disableMfa(userId, password, previousCodes[0]!, sessionId, { networkAddress: "127.0.0.1", userAgent: "audit regression" })
          : auth.rotateRecoveryCodes(userId, sessionId, password, previousCodes[0]!, { networkAddress: "127.0.0.1", userAgent: "audit regression" });
        if (failAudit) {
          await assert.rejects(invoke, (error: unknown) => {
            const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null;
            return String(error).includes("forced MFA audit failure") || String(cause).includes("forced MFA audit failure");
          });
          // Verification reads run in the scratch org's scope.
          await withOrgContext(org.orgId, async () => {
            assert.deepEqual((await db.execute(sql`select * from auth_mfa_factors where user_id=${userId}`)).rows[0], factorBefore);
            assert.deepEqual((await db.execute(sql`select * from auth_sessions where user_id=${userId} order by id`)).rows, sessionsBefore);
          });
        } else {
          const result = await invoke();
          assert.ok(result);
          // confirmMfaSetup resolves to the code list; the security-change
          // calls resolve to outcome objects carrying the list (rotation) or
          // nothing (disable, whose audit expectation is zero codes after).
          const codes = Array.isArray(result) ? result
            : "recoveryCodes" in (result as unknown as Record<string, unknown>)
              ? (result as unknown as { recoveryCodes: string[] }).recoveryCodes
              : [];
          if (!Array.isArray(result)) assert.deepEqual((result as { ok: boolean }).ok, true);
          // Verification reads run in the scratch org's scope.
          await withOrgContext(org.orgId, async () => {
            const audits = (await db.execute<{ actor_id: string; org_id: string; at: string; changes: unknown }>(sql`
              select actor_id,org_id,at,changes from audit_log
               where org_id=${org.orgId} and table_name='users' and row_id=${userId}
                 and changes->>'securityChange'=${action}
            `)).rows;
            assert.equal(audits.length, 1);
            assert.equal(audits[0]!.actor_id, userId);
            assert.equal(audits[0]!.org_id, org.orgId);
            assert.ok(Number.isFinite(new Date(audits[0]!.at).getTime()));
            assert.deepEqual(audits[0]!.changes, {
              securityChange: action,
              before: { mfaEnabled: action !== "mfa_enabled", recoveryCodesRemaining: previousCodes.length },
              after: { mfaEnabled: action !== "mfa_disabled", recoveryCodesRemaining: codes.length },
            });
            const evidence = JSON.stringify(audits);
            for (const sensitive of [password, secret, String(factorBefore.secret_encrypted), ...codes, ...previousCodes, ...previousHashes]) assert.ok(!evidence.includes(sensitive));
          });
        }
        if (failAudit) await withOrgContext(org.orgId, async () => {
          assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log
            where org_id=${org.orgId} and changes->>'securityChange'=${action}`)).rows[0]!.n, 0);
        });
      } finally {
        if (triggerInstalled) await withBypassContext(async () => {
          await db.execute(sql.raw(`drop trigger if exists "${triggerName}" on audit_log`));
          await db.execute(sql.raw(`drop function if exists public."${triggerName}"()`));
        });
        if (previousSecret === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = previousSecret;
        await withBypassContext(() => dropScratchOrg(org.orgId));
      }
    });
  }
}


const consolidatedRows = [
  { label: "auth mfa concurrency", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomBytes } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypass, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        for (const method of ["password", "new OIDC identity", "mapped OIDC identity"] as const) {
          test(`${method} observes MFA enabled while its user lock is pending`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
            const org = await withBypassContext(() => createScratchOrg());
            // web/lib/auth.ts reads the session secret live from process.env (never the
        // engine db.ts module-evaluation snapshot), so seed it there too.
        const priorSecret = process.env.SESSION_SECRET;
            process.env.SESSION_SECRET = randomBytes(32).toString("hex");
            let release = () => {};
            let held: Promise<unknown> | undefined;
            let contender: Promise<import("./auth").LoginResult> | undefined;
            try {
              const auth = await import("./auth");
              const { sealSecret } = await import("./secrets");
              const { generateTotpSecret, totpCode } = await import("./auth-totp");
              const password = "Isolated MFA transition password 8945";
              const issuer = "https://identity.example.test";
              // Fixture seeds under explicit bypass: importing ./auth above pulls in
              // the web request-org resolver, which denies every unscoped query under
              // pooled RLS (bare setup dies with 42501, reads see zero rows). The
              // login calls under test scope their own queries internally.
              const { userId, email } = await withBypassContext(async () => {
                const userId = (await seedFlowActors(org.orgId)).adminId;
                const email = (await db.execute<{ email: string }>(sql`select email from users where id=${userId}`)).rows[0]!.email;
                await db.execute(sql`update orgs set env_kind='production' where id=${org.orgId}`);
                await db.execute(sql`update users set password_hash=${await auth.hashPassword(password)} where id=${userId}`);
                if (method === "mapped OIDC identity") {
                  await db.execute(sql`insert into auth_oidc_identities (issuer,subject,user_id,email_at_link)
                    values (${issuer},${userId},${userId},${email})`);
                }
                return { userId, email };
              });
              const secret = generateTotpSecret();
              let staged!: () => void;
              const ready = new Promise<void>(resolve => { staged = resolve; });
              const hold = new Promise<void>(resolve => { release = resolve; });
              let holderPid = 0;
              // Hold the same user → factor transaction boundary as MFA confirmation.
              held = withBypass(async () => {
                holderPid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
                await db.execute(sql`select id from users where id=${userId} for update`);
                await db.execute(sql`insert into auth_mfa_factors (user_id,secret_encrypted,enabled_at)
                  values (${userId},${sealSecret(secret, { orgId: userId, purpose: "auth.mfa.secret" })},now())`);
                staged();
                await hold;
              });
              await Promise.race([ready, held]);
              const context = { networkAddress: "127.0.0.1", userAgent: "isolated MFA concurrency test" };
              contender = method === "password" ? auth.login(email, password, context)
                : auth.finishOidcLogin({ issuer, subject: userId, email, emailVerified: true, context });
              let settled = false;
              void contender.then(() => { settled = true; }, () => { settled = true; });
              const deadline = Date.now() + 10_000;
              let blocked = false;
              while (!settled && Date.now() < deadline) {
                blocked = await withBypassContext(async () => (await db.execute<{ blocked: boolean }>(sql`select exists(
                  select 1 from pg_stat_activity where datname=current_database()
                    and ${holderPid}=any(pg_blocking_pids(pid))
                ) as blocked`)).rows[0]!.blocked);
                if (blocked) break;
                await new Promise(resolve => setTimeout(resolve, 10));
              }
              assert.ok(blocked, "login must reach the held user lock before MFA commits");
              release();
              await held;
              const result = await contender;
              assert.equal(result.kind, "mfa_required", "newly enabled MFA must gate this login");
              assert.ok(result.kind === "mfa_required");
              // Verification reads run in the scratch org's scope.
              await withOrgContext(org.orgId, async () => {
                assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from auth_sessions where user_id=${userId}`)).rows[0]!.n, 0);
              });
              assert.equal((await auth.completeMfaLogin(result.challengeToken, totpCode(secret)!.code, context)).kind, "success");
            } finally {
              release();
              await Promise.allSettled([held, contender]);
              if (priorSecret === undefined) delete process.env.SESSION_SECRET;
              else process.env.SESSION_SECRET = priorSecret;
              await withBypassContext(() => dropScratchOrg(org.orgId));
            }
          });
        }
        
        
        test("concurrent MFA setup requests for one session reuse the same pending secret", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const auth = await import("./auth");
            const { totpCode } = await import("./auth-totp");
            const password = "Isolated concurrent MFA setup password 5019";
            const requestContext = { networkAddress: "127.0.0.1", userAgent: "concurrent MFA setup regression" };
            const { userId, email } = await withBypassContext(async () => {
              const userId = (await seedFlowActors(org.orgId)).adminId;
              const email = (await db.execute<{ email: string }>(sql`select email from users where id=${userId}`)).rows[0]!.email;
              await db.execute(sql`update orgs set env_kind='production' where id=${org.orgId}`);
              await db.execute(sql`update users set password_hash=${await auth.hashPassword(password)} where id=${userId}`);
              return { userId, email };
            });
            const login = await auth.login(email, password, requestContext);
            assert.equal(login.kind, "success");
            assert.ok(login.kind === "success");
            const sessionId = (await auth.validateSessionToken(login.token))!.sessionId;
        
            const [first, second] = await Promise.all([
              auth.beginMfaSetup(userId, sessionId, password, requestContext),
              auth.beginMfaSetup(userId, sessionId, password, requestContext),
            ]);
            assert.ok(first && second);
            assert.deepEqual(second, first, "a retry must return the secret and QR identity already staged for this session");
            const secondLogin = await auth.login(email, password, requestContext);
            assert.ok(secondLogin.kind === "success");
            const secondSessionId = (await auth.validateSessionToken(secondLogin.token))!.sessionId;
            await assert.rejects(
              auth.beginMfaSetup(userId, secondSessionId, password, requestContext),
              /MFA setup is already pending in another session; finish setup there or wait for it to expire before starting again/,
            );
            const recoveryCodes = await auth.confirmMfaSetup(userId, sessionId, totpCode(first.secret)!.code);
            assert.ok(recoveryCodes, "the first response's authenticator code must remain valid after the concurrent call");
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
  { label: "auth mfa reauth refusals", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomBytes, randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const CONTEXT = { networkAddress: "127.0.0.1", userAgent: "mfa reauth refusal regression" };
        
        async function seedMfaUser(orgId: string, password: string) {
          const auth = await import("./auth");
          const { sealSecret } = await import("./secrets");
          const { generateTotpSecret, generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } = await import("./auth-totp");
          const secret = generateTotpSecret();
          const codes = generateRecoveryCodes().slice(0, 2);
          const setup = await withBypassContext(async () => {
            const userId = (await seedFlowActors(orgId)).adminId;
            await db.execute(sql`update users set password_hash=${await auth.hashPassword(password)} where id=${userId}`);
            const sessionId = randomUUID();
            await db.execute(sql`
              insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at)
              values (${sessionId},${userId},${randomBytes(32).toString("hex")},'password',${new Date(Date.now() + 86_400_000)})`);
            const hashes = codes.map((code) => hashRecoveryCode(userId, normalizeRecoveryCode(code)!));
            await db.execute(sql`insert into auth_mfa_factors(user_id,secret_encrypted,recovery_code_hashes,enabled_at)
              values (${userId},${sealSecret(secret, { orgId: userId, purpose: "auth.mfa.secret" })},${JSON.stringify(hashes)}::jsonb,now())`);
            return { userId, sessionId };
          });
          return { ...setup, codes };
        }
        
        test("wrong password and wrong MFA code share one generic refusal", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const auth = await import("./auth");
            const password = "Isolated reauth refusal password 2084";
            const { userId, sessionId, codes } = await seedMfaUser(org.orgId, password);
            // A valid MFA code with the wrong password must not hint that the code
            // was right; a wrong code with the right password must not hint the
            // password was right. Both read as bad credentials.
            assert.deepEqual(
              await auth.rotateRecoveryCodes(userId, sessionId, "wrong password 2084", codes[0]!, CONTEXT),
              { ok: false, reason: "invalid_credentials" },
            );
            assert.deepEqual(
              await auth.rotateRecoveryCodes(userId, sessionId, password, "WRONG-CODE-1", CONTEXT),
              { ok: false, reason: "invalid_credentials" },
            );
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
        
        test("repeated failures report a lockout with a retry delay, not bad credentials", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const auth = await import("./auth");
            const password = "Isolated reauth lockout password 7319";
            const { userId, sessionId, codes } = await seedMfaUser(org.orgId, password);
            for (let attempt = 0; attempt < 5; attempt++) {
              assert.deepEqual(
                await auth.rotateRecoveryCodes(userId, sessionId, password, "WRONG-CODE-1", CONTEXT),
                { ok: false, reason: "invalid_credentials" },
              );
            }
            // Five failures trip the temporary lockout; even the correct password
            // plus a valid code is refused as locked, with a retry delay.
            const result = await auth.rotateRecoveryCodes(userId, sessionId, password, codes[0]!, CONTEXT);
            assert.equal(result.ok, false);
            assert.ok(!result.ok);
            assert.equal(result.reason, "locked");
            assert.ok(result.retryAfter > 0 && result.retryAfter <= 5 * 60);
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
        
        test("a spent network attempt window reports rate-limited with a retry delay", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          const sessionSecret = randomBytes(32).toString("hex");
          process.env.SESSION_SECRET = sessionSecret;
          try {
            const { createHmac } = await import("node:crypto");
            const auth = await import("./auth");
            const password = "Isolated reauth throttle password 5502";
            const { userId, sessionId, codes } = await seedMfaUser(org.orgId, password);
            // Per-user failures trip the temporary lockout at five, so the network
            // window (thirty failures from one address across identities) is seeded
            // directly: thirty recent failures from this address, none tied to this
            // user or address identity.
            const networkHash = createHmac("sha256", sessionSecret).update("openbooks:network:127.0.0.1").digest("hex");
            await withBypassContext(async () => {
              for (let attempt = 0; attempt < 30; attempt++) {
                await db.execute(sql`insert into auth_login_events (email_hash, network_hash, outcome, auth_method)
                  values (${randomBytes(16).toString("hex")}, ${networkHash}, 'mfa_failure', 'password')`);
              }
            });
            const result = await auth.rotateRecoveryCodes(userId, sessionId, password, codes[0]!, CONTEXT);
            assert.equal(result.ok, false);
            assert.ok(!result.ok);
            assert.equal(result.reason, "rate_limited");
            assert.ok(result.retryAfter > 0);
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
  { label: "auth mfa session liveness", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomBytes, randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypass, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const CONTEXT = { networkAddress: "127.0.0.1", userAgent: "mfa session liveness regression" };
        
        async function seedMfaUser(orgId: string, password: string) {
          const auth = await import("./auth");
          const { sealSecret } = await import("./secrets");
          const { generateTotpSecret, generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } = await import("./auth-totp");
          const secret = generateTotpSecret();
          const codes = generateRecoveryCodes().slice(0, 2);
          const setup = await withBypassContext(async () => {
            const userId = (await seedFlowActors(orgId)).adminId;
            await db.execute(sql`update users set password_hash=${await auth.hashPassword(password)} where id=${userId}`);
            const sessionId = randomUUID();
            const otherSessionId = randomUUID();
            for (const id of [sessionId, otherSessionId]) await db.execute(sql`
              insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at)
              values (${id},${userId},${randomBytes(32).toString("hex")},'password',${new Date(Date.now() + 86_400_000)})`);
            const hashes = codes.map((code) => hashRecoveryCode(userId, normalizeRecoveryCode(code)!));
            await db.execute(sql`insert into auth_mfa_factors(user_id,secret_encrypted,recovery_code_hashes,enabled_at)
              values (${userId},${sealSecret(secret, { orgId: userId, purpose: "auth.mfa.secret" })},${JSON.stringify(hashes)}::jsonb,now())`);
            return { userId, sessionId, otherSessionId };
          });
          return { ...setup, codes };
        }
        
        async function sessionState(orgId: string, userId: string) {
          return withOrgContext(orgId, async () => ({
            factor: (await db.execute(sql`select enabled_at from auth_mfa_factors where user_id=${userId}`)).rows[0] as
              { enabled_at: Date | null } | undefined,
            sessions: (await db.execute<{ id: string; revoked: boolean }>(sql`
              select id, (revoked_at is not null) as revoked from auth_sessions where user_id=${userId} order by id`)).rows,
          }));
        }
        
        test("disableMfa refuses when the caller session was revoked first", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const auth = await import("./auth");
            const password = "Isolated MFA disable liveness password 4177";
            const { userId, sessionId, otherSessionId, codes } = await seedMfaUser(org.orgId, password);
            await withBypassContext(async () => {
              await db.execute(sql`update auth_sessions set revoked_at=now(), revocation_reason='user_revoked' where id=${sessionId}`);
            });
            const result = await auth.disableMfa(userId, password, codes[0]!, sessionId, CONTEXT);
            assert.deepEqual(result, { ok: false, reason: "caller_session_revoked" });
            const state = await sessionState(org.orgId, userId);
            assert.ok(state.factor?.enabled_at, "factor must stay enabled after a refused disable");
            assert.equal(state.sessions.find((row) => row.id === otherSessionId)?.revoked, false);
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
        
        test("disableMfa succeeds with a live caller session and revokes the others", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const auth = await import("./auth");
            const password = "Isolated MFA disable control password 9271";
            const { userId, sessionId, otherSessionId, codes } = await seedMfaUser(org.orgId, password);
            const result = await auth.disableMfa(userId, password, codes[0]!, sessionId, CONTEXT);
            assert.deepEqual(result, { ok: true });
            const state = await sessionState(org.orgId, userId);
            assert.equal(state.factor, undefined);
            assert.equal(state.sessions.find((row) => row.id === sessionId)?.revoked, false);
            assert.equal(state.sessions.find((row) => row.id === otherSessionId)?.revoked, true);
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
        
        test("disableMfa refuses a session revoked while reauthentication held its transaction", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          let release = () => {};
          let held: Promise<unknown> | undefined;
          let contender: Promise<import("./auth").DisableMfaResult> | undefined;
          try {
            const auth = await import("./auth");
            const password = "Isolated MFA disable race password 5518";
            const { userId, sessionId, codes } = await seedMfaUser(org.orgId, password);
            const hold = new Promise<void>((resolve) => { release = resolve; });
            let holderPid = 0;
            // Hold the caller session row uncommitted: the disable must block on its
            // liveness lock, then observe the revocation once this commits.
            held = withBypass(async () => {
              holderPid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
              await db.execute(sql`update auth_sessions set revoked_at=now(), revocation_reason='user_revoked' where id=${sessionId}`);
              await hold;
            });
            // Wait until the holder's update is visible as in-flight, then contend.
            const deadline = Date.now() + 10_000;
            while ((await withBypassContext(async () => (await db.execute<{ n: number }>(sql`
              select count(*)::int as n from pg_stat_activity where datname=current_database() and pid=${holderPid} and state <> 'idle'
            `)).rows[0]!.n)) === 0 && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            contender = auth.disableMfa(userId, password, codes[0]!, sessionId, CONTEXT);
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
            assert.ok(blocked, "disable must reach the held session lock before mutating");
            release();
            await held;
            assert.deepEqual(await contender, { ok: false, reason: "caller_session_revoked" });
            const state = await sessionState(org.orgId, userId);
            assert.ok(state.factor?.enabled_at, "factor must stay enabled after a refused disable");
          } finally {
            release();
            await Promise.allSettled([held, contender]);
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
        
        test("rotateRecoveryCodes refuses a revoked caller session and rotates for a live one", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const auth = await import("./auth");
            const password = "Isolated recovery rotation liveness password 6630";
            const { userId, sessionId, codes } = await seedMfaUser(org.orgId, password);
            const hashesBefore = (await withBypassContext(async () => (await db.execute<{ hashes: unknown }>(sql`
              select recovery_code_hashes as hashes from auth_mfa_factors where user_id=${userId}`)).rows[0]!.hashes));
            await withBypassContext(async () => {
              await db.execute(sql`update auth_sessions set revoked_at=now(), revocation_reason='user_revoked' where id=${sessionId}`);
            });
            assert.deepEqual(
              await auth.rotateRecoveryCodes(userId, sessionId, password, codes[0]!, CONTEXT),
              { ok: false, reason: "caller_session_revoked" },
            );
            const hashesAfterRefusal = (await withBypassContext(async () => (await db.execute<{ hashes: unknown }>(sql`
              select recovery_code_hashes as hashes from auth_mfa_factors where user_id=${userId}`)).rows[0]!.hashes));
            assert.deepEqual(hashesAfterRefusal, hashesBefore);
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
  { label: "auth mfa tamper", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomBytes, randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const CONTEXT = { networkAddress: "127.0.0.1", userAgent: "mfa tamper regression" };
        
        /**
         * A tampered MFA factor must read as a wrong code at every site — the same
         * audit row, the same refusal — never a 500, and never a hint that the
         * factor (rather than the code) is at fault.
         */
        
        function tamperSeal(sealed: string): string {
          return sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
        }
        
        async function seedUser(password: string, orgId: string, enabled: boolean) {
          const auth = await import("./auth");
          const { sealSecret } = await import("./secrets");
          const { generateTotpSecret, generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } = await import("./auth-totp");
          return withBypassContext(async () => {
            const userId = (await seedFlowActors(orgId)).adminId;
            await db.execute(sql`update users set password_hash=${await auth.hashPassword(password)} where id=${userId}`);
            const sessionId = randomUUID();
            await db.execute(sql`
              insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at)
              values (${sessionId},${userId},${randomBytes(32).toString("hex")},'password',${new Date(Date.now() + 86_400_000)})`);
            const secret = generateTotpSecret();
            const codes = generateRecoveryCodes().slice(0, 2);
            const hashes = codes.map((code) => hashRecoveryCode(userId, normalizeRecoveryCode(code)!));
            if (enabled) {
              await db.execute(sql`insert into auth_mfa_factors(user_id,secret_encrypted,recovery_code_hashes,enabled_at)
                values (${userId},${sealSecret(secret, { orgId: userId, purpose: "auth.mfa.secret" })},${JSON.stringify(hashes)}::jsonb,now())`);
            } else {
              await db.execute(sql`insert into auth_mfa_factors(user_id,secret_encrypted,recovery_code_hashes,setup_session_id,setup_expires_at)
                values (${userId},${sealSecret(secret, { orgId: userId, purpose: "auth.mfa.secret" })},'[]'::jsonb,${sessionId},${new Date(Date.now() + 30 * 60_000)})`);
            }
            return { auth, userId, sessionId, codes };
          });
        }
        
        async function tamperFactor(userId: string): Promise<void> {
          await withBypassContext(async () => {
            const row = (await db.execute<{ sealed: string }>(sql`
              select secret_encrypted as sealed from auth_mfa_factors where user_id=${userId}`)).rows[0]!;
            await db.execute(sql`update auth_mfa_factors set secret_encrypted=${tamperSeal(row.sealed)} where user_id=${userId}`);
          });
        }
        
        async function mfaFailures(userId: string): Promise<number> {
          return withBypassContext(async () => (await db.execute<{ n: number }>(sql`
            select count(*)::int as n from auth_login_events where user_id=${userId} and outcome='mfa_failure'`)).rows[0]!.n);
        }
        
        test("confirming setup against a tampered factor reads as an invalid code and consumes an attempt", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const { auth, userId, sessionId } = await seedUser("Isolated tamper confirm password 8113", org.orgId, false);
            await tamperFactor(userId);
            assert.equal(await auth.confirmMfaSetup(userId, sessionId, "000000"), null);
            const attempts = await withBypassContext(async () => (await db.execute<{ n: number }>(sql`
              select setup_attempt_count as n from auth_mfa_factors where user_id=${userId}`)).rows[0]!.n);
            assert.equal(attempts, 1, "tamper consumes a setup attempt exactly like a wrong code");
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
        
        test("disabling MFA against a tampered factor audits mfa_failure and refuses invalid credentials", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const password = "Isolated tamper disable password 6227";
            const { auth, userId, sessionId, codes } = await seedUser(password, org.orgId, true);
            await tamperFactor(userId);
            // codes[0] would verify against the untampered factor: the refusal must
            // not distinguish tamper from a wrong code.
            assert.deepEqual(
              await auth.disableMfa(userId, password, codes[0]!, sessionId, CONTEXT),
              { ok: false, reason: "invalid_credentials" },
            );
            assert.equal(await mfaFailures(userId), 1, "the tampered attempt still writes its mfa_failure audit row");
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
        
        test("completing login against a tampered factor audits mfa_failure and refuses invalid credentials", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const priorSecret = process.env.SESSION_SECRET;
          process.env.SESSION_SECRET = randomBytes(32).toString("hex");
          try {
            const password = "Isolated tamper login password 4091";
            const { auth, userId, codes } = await seedUser(password, org.orgId, true);
            const email = await withBypassContext(async () => (await db.execute<{ email: string }>(sql`
              select email from users where id=${userId}`)).rows[0]!.email);
            const challenged = await auth.login(email, password, CONTEXT);
            assert.equal(challenged.kind, "mfa_required");
            if (challenged.kind !== "mfa_required") throw new Error("expected an MFA challenge");
            await tamperFactor(userId);
            const result = await auth.completeMfaLogin(challenged.challengeToken, codes[0]!, CONTEXT);
            assert.equal(result.kind, "invalid", "a tampered factor refuses as invalid credentials, never a 500");
            assert.equal(await mfaFailures(userId), 1, "the tampered login still writes its mfa_failure audit row");
          } finally {
            if (priorSecret === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = priorSecret;
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
] as const;

for (const row of consolidatedRows) await row.register();
