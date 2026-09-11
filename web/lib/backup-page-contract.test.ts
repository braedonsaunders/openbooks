import assert from "node:assert/strict";
import test from "node:test";
import { pageSource } from "./page-source";

// The page is its wiring file and its `view.ts`; the timestamp normalization
// these assertions cover moved into the latter with the rest of the loader.
const source = pageSource("web/app/(app)/admin/backups/page.tsx");

test("backup page normalizes raw SQL timestamps before serialization", () => {
  assert.match(source, /function isoTimestamp\(/);
  assert.match(source, /value instanceof Date \? value : new Date\(value\)/);
  assert.match(source, /lastRunAt: isoTimestamp\(p\.last_run_at\)/);
  assert.match(source, /createdAt: isoTimestamp\(r\.created_at\)!/);
  assert.match(source, /purgedAt: isoTimestamp\(r\.purged_at\)/);
  assert.doesNotMatch(source, /r\.created_at\.toISOString\(\)/);
});
