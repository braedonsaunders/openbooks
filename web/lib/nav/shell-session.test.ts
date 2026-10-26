import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "@openbooks/engine/platform/db";
import { sessionSigningInput } from "../auth-token-format";

const { validateSessionToken } = await import("../auth");

test("session authentication reads a live session under a share lock and stamps activity only when stale", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const secret = "session-boundary-test-secret-at-least-32-characters";
  process.env.SESSION_SECRET = secret;
  const sessionId = randomUUID(),
    userId = randomUUID();
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const payload = `v2.${sessionId}.${userId}.${expiry}`;
  const token = `${payload}.${createHmac("sha256", secret).update(sessionSigningInput(payload)).digest("base64url")}`;
  const dialect = new PgDialect();
  const queries: { sql: string; params: unknown[] }[] = [];
  const live = { sessionId, userId, authMethod: "password", expiresAt: new Date(expiry * 1000) };
  let session: unknown[] = [{ ...live, stale: false }];
  let stamp: unknown[] = [{ id: sessionId }];
  const execute = db.execute;
  db.execute = (async (query: Parameters<typeof db.execute>[0], mode?: string) => {
    const compiled = dialect.sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]);
    queries.push(compiled);
    const rows = compiled.sql.trimStart().startsWith("update") ? stamp : session;
    return mode === "objects" ? rows : { rows, rowCount: rows.length };
  }) as typeof db.execute;
  const assertLiveness = (query: { sql: string; params: unknown[] }) => {
    assert.ok(query.sql.includes("s.revoked_at is null"));
    assert.ok(query.sql.includes("s.expires_at > now()"));
    assert.ok(query.sql.includes("u.id = s.user_id and u.is_active"));
    assert.ok(query.params.includes(sessionId));
    assert.ok(query.params.includes(userId));
    assert.ok(query.params.includes(createHash("sha256").update(token).digest("hex")));
  };
  try {
    assert.deepEqual(await validateSessionToken(token), live);
    assert.equal(
      queries.length,
      1,
      "a recently stamped session validates with one read and no write",
    );
    assert.ok(
      queries[0]!.sql.includes("for share of s"),
      "an in-flight revocation holds the row the read waits on",
    );
    assertLiveness(queries[0]!);

    session = [{ ...live, stale: true }];
    assert.deepEqual(await validateSessionToken(token), live);
    assert.equal(queries.length, 3, "a stale stamp is written once");
    assert.ok(queries[2]!.sql.includes("update auth_sessions s set last_seen_at = now()"));
    assertLiveness(queries[2]!);

    stamp = [];
    assert.equal(
      await validateSessionToken(token),
      null,
      "a stamp that matches no live row refuses the session",
    );

    session = [];
    assert.equal(
      await validateSessionToken(token),
      null,
      "no live session row cannot authenticate",
    );
    const issued = queries.length;
    assert.equal(await validateSessionToken("invalid"), null);
    assert.equal(queries.length, issued, "invalid credentials never reach the database");
  } finally {
    db.execute = execute;
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});
