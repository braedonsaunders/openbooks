import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env } from "@openbooks/engine/src/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/test-fixtures.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });

for (const action of ["mfa_enabled", "mfa_disabled", "mfa_recovery_rotated"] as const) {
  for (const failAudit of [false, true]) {
    test(`${action} ${failAudit ? "rolls back when its audit write fails" : "retains attributable non-secret audit evidence"}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      const previousSecret = env.SESSION_SECRET;
      env.SESSION_SECRET = randomBytes(32).toString("hex");
      const triggerName = "mfa_audit_" + randomUUID().replaceAll("-", "");
      let triggerInstalled = false;
      try {
        const auth = await import("./auth");
        const { sealSecret } = await import("./secrets");
        const { generateTotpSecret, totpCode, generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } = await import("./auth-totp");
        const userId = (await seedFlowActors(org.orgId)).adminId;
        const password = "Isolated audit password 3947";
        await db.execute(sql`update users set password_hash=${await auth.hashPassword(password)} where id=${userId}`);
        const sessionId = randomUUID();
        const otherSessionId = randomUUID();
        for (const id of [sessionId, otherSessionId]) await db.execute(sql`
          insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at)
          values (${id},${userId},${randomBytes(32).toString("hex")},'password',now()+interval '1 day')`);
        const secret = generateTotpSecret();
        const previousCodes = action === "mfa_enabled" ? [] : generateRecoveryCodes().slice(0, 2);
        const previousHashes = previousCodes.map(code => hashRecoveryCode(userId, normalizeRecoveryCode(code)!));
        await db.execute(sql`insert into auth_mfa_factors(user_id,secret_encrypted,recovery_code_hashes,enabled_at,setup_session_id,setup_expires_at)
          values (${userId},${sealSecret(secret)},${JSON.stringify(previousHashes)}::jsonb,${action === "mfa_enabled" ? sql`null` : sql`now()`},
            ${action === "mfa_enabled" ? sessionId : null},${action === "mfa_enabled" ? sql`now()+interval '30 minutes'` : sql`null`})`);
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
        const invoke = () => action === "mfa_enabled" ? auth.confirmMfaSetup(userId, sessionId, totpCode(secret)!.code)
          : action === "mfa_disabled" ? auth.disableMfa(userId, password, previousCodes[0]!, sessionId, { networkAddress: "127.0.0.1", userAgent: "audit regression" })
          : auth.rotateRecoveryCodes(userId, password, previousCodes[0]!, { networkAddress: "127.0.0.1", userAgent: "audit regression" });
        if (failAudit) {
          await assert.rejects(invoke, (error: unknown) => {
            const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null;
            return String(error).includes("forced MFA audit failure") || String(cause).includes("forced MFA audit failure");
          });
          assert.deepEqual((await db.execute(sql`select * from auth_mfa_factors where user_id=${userId}`)).rows[0], factorBefore);
          assert.deepEqual((await db.execute(sql`select * from auth_sessions where user_id=${userId} order by id`)).rows, sessionsBefore);
        } else {
          const result = await invoke();
          assert.ok(result);
          const codes = Array.isArray(result) ? result : [];
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
        }
        if (failAudit) assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log
          where org_id=${org.orgId} and changes->>'securityChange'=${action}`)).rows[0]!.n, 0);
      } finally {
        if (triggerInstalled) {
          await db.execute(sql.raw(`drop trigger if exists "${triggerName}" on audit_log`));
          await db.execute(sql.raw(`drop function if exists public."${triggerName}"()`));
        }
        if (previousSecret === undefined) delete env.SESSION_SECRET;
        else env.SESSION_SECRET = previousSecret;
        await dropScratchOrg(org.orgId);
      }
    });
  }
}
