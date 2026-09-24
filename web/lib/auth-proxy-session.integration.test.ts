import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";

// The request proxy checks server-side session revocation on every private
// request: a revoked session cookie is refused 401 at the edge instead of
// reaching any route, while a live one passes through. Tokens are minted
// with the same HMAC scheme the proxy verifies, against real session rows.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

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
