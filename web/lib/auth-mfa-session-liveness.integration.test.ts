import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });

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
      values (${userId},${sealSecret(secret)},${JSON.stringify(hashes)}::jsonb,now())`);
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
