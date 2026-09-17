import assert from "node:assert/strict";
import test from "node:test";
import type { ParsedSessionToken } from "./auth-token-format";
import { checkSessionLiveness } from "./session-gate";

const parsed: ParsedSessionToken = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  expiresEpoch: Math.floor(Date.now() / 1000) + 3600,
  payload: "v2.payload",
  signature: "signature",
};

test("a live session record verifies active", async () => {
  assert.equal(await checkSessionLiveness("token", parsed, { lookup: async () => true }), "active");
});

test("a revoked or unknown session verifies inactive", async () => {
  assert.equal(await checkSessionLiveness("token", parsed, { lookup: async () => false }), "inactive");
});

test("a database failure verifies unavailable instead of throwing", async () => {
  const result = await checkSessionLiveness("token", parsed, {
    lookup: async () => {
      throw new Error("timeout exceeded when trying to connect");
    },
  });
  assert.equal(result, "unavailable");
});

test("a hung database verifies unavailable within the bound instead of parking the request", async () => {
  const started = Date.now();
  const result = await checkSessionLiveness("token", parsed, {
    lookup: () => new Promise<boolean>(() => {}),
    timeoutMs: 25,
  });
  assert.equal(result, "unavailable");
  assert.ok(Date.now() - started < 10_000, "hung lookup must fail fast per request");
});
