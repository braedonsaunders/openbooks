import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../schema/migrations/generated/0125_connection_posted_change_policy.sql",
    import.meta.url,
  ),
  "utf8",
);
const worker = readFileSync(
  new URL("./worker/migration-worker.ts", import.meta.url),
  "utf8",
);
const sync = readFileSync(new URL("./sync/sync.ts", import.meta.url), "utf8");

test("posted-change automation requires attributable controller authorization", () => {
  assert.match(migration, /append_only_automatic/);
  assert.match(migration, /posted_change_authorized_by is not null/);
  assert.match(migration, /posted_change_authorized_at is not null/);
});

test("connection authorization reaches only the guarded append-only posting path", () => {
  assert.match(worker, /conn\.postedChangePolicy === "append_only_automatic"/);
  assert.match(sync, /automaticCorrection/);
  assert.match(sync, /regenerateGlImpactTx\(/);
  assert.doesNotMatch(sync, /openbooks\.amend\s*=\s*off/);
});
