import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const commitRoute = readFileSync(
  new URL("../../app/api/assistant/commit/route.ts", import.meta.url),
  "utf8",
);

test("assistant confirmation tokens are consumed through the idempotency boundary", () => {
  // The signed token is the only stable identity available to a replayed Apply
  // request, so the claim must bind directly to it rather than to a request id.
  assert.match(commitRoute, /executeIdempotent/);
  assert.match(commitRoute, /idempotencyKey:\s*body\.confirmToken/);
  assert.match(commitRoute, /operation:\s*["']assistant\.commit\.create_journal_entry["']/);
});

test("assistant confirmation keeps proposal verification and journal writes atomic", () => {
  assert.match(commitRoute, /verifyProposal\(/);
  assert.match(commitRoute, /db\.transaction\(async \(tx\)/);
  assert.match(commitRoute, /allocateDocumentNumber\(tx/);
  assert.match(commitRoute, /insert into documents/);
  assert.match(commitRoute, /insert into document_lines/);
});
