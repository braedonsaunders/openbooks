import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";

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
