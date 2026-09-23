import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });

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
      values (${userId},${sealSecret(secret)},${JSON.stringify(hashes)}::jsonb,now())`);
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
