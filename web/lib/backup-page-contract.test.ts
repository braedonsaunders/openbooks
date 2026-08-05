import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "web/app/(app)/admin/backups/page.tsx",
  "utf8",
);

test("backup page normalizes raw SQL timestamps before serialization", () => {
  assert.match(source, /function isoTimestamp\(/);
  assert.match(source, /value instanceof Date \? value : new Date\(value\)/);
  assert.match(source, /lastRunAt: isoTimestamp\(p\.last_run_at\)/);
  assert.match(source, /createdAt: isoTimestamp\(r\.created_at\)!/);
  assert.match(source, /purgedAt: isoTimestamp\(r\.purged_at\)/);
  assert.doesNotMatch(source, /r\.created_at\.toISOString\(\)/);
});
