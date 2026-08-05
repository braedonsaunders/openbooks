import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createEmailActionToken, verifyEmailActionToken } from "./email-tokens.ts";
import { env } from "../db.ts";

const priorEmailSecret = env.FLOWS_EMAIL_SECRET;

before(() => {
  env.FLOWS_EMAIL_SECRET = "openbooks-test-only-flow-secret";
});

after(() => {
  if (priorEmailSecret === undefined) delete env.FLOWS_EMAIL_SECRET;
  else env.FLOWS_EMAIL_SECRET = priorEmailSecret;
});

/**
 * One-click email-approval tokens are the ENTIRE grant on a public, sessionless
 * route, so signing integrity is a security boundary. These assert the token
 * binds exactly one gate + decision + assignee and rejects any tampering.
 */

test("a token round-trips its claims", () => {
  const claims = { gateId: "gate-1", decision: "approved" as const, assigneeUserId: "user-1" };
  const token = createEmailActionToken(claims);
  const verified = verifyEmailActionToken(token);
  assert.ok(verified);
  assert.equal(verified.gateId, "gate-1");
  assert.equal(verified.decision, "approved");
  assert.equal(verified.assigneeUserId, "user-1");
});

test("a tampered payload is rejected (signature no longer matches)", () => {
  const token = createEmailActionToken({ gateId: "gate-1", decision: "approved", assigneeUserId: "user-1" });
  const [payload, sigHex] = token.split(".");
  // Re-pack a different gate id with the ORIGINAL signature.
  const forged = Buffer.from("gate-2|approved|user-1|" + (Date.now() + 60_000), "utf8").toString("base64url");
  assert.equal(verifyEmailActionToken(`${forged}.${sigHex}`), null);
  void payload;
});

test("an expired token is rejected", () => {
  const token = createEmailActionToken({
    gateId: "gate-1",
    decision: "approved",
    assigneeUserId: "user-1",
    expiresAt: Date.now() - 1_000,
  });
  assert.equal(verifyEmailActionToken(token), null);
});

test("a garbage token is rejected, not thrown", () => {
  assert.equal(verifyEmailActionToken("not-a-token"), null);
  assert.equal(verifyEmailActionToken(""), null);
  assert.equal(verifyEmailActionToken("a.b.c"), null);
});
