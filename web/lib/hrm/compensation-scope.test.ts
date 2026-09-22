import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The compensation home loader must read per-band headcounts through the
 * fenced engine counter, never an org-wide count query: the loader's old
 * inline SQL filtered only by org/level/date, so a reader with an empty
 * subsidiary scope still received whole-org worker counts. A refusal from
 * the counter (permission, database) must propagate to the caller — a
 * catch that renders zero would present a false headcount.
 *
 * The `never` patterns match a CALL rather than a bare name, so the
 * unrelated department lookup elsewhere in this file (which also touches
 * employment_assignment_versions but counts nothing) does not read as
 * the removed query.
 */
const text = readFileSync(new URL("./compensation.ts", import.meta.url), "utf8");

test("compensation home reads band headcounts through the scoped helper as the caller", () => {
  assert.match(
    text,
    /from '@openbooks\/engine\/src\/hrm\/compensation\/band-headcounts\.ts'/,
  );
  assert.match(
    text,
    /await countBandHolders\(\{ orgId, actorId: authz\.user\.id, levelId: band\.levelId, asOf: today \}\)/,
  );
});

test("compensation home retains no unfenced worker count and no catch-zero", () => {
  assert.doesNotMatch(text, /count\(distinct aav\.employment_id\)/);
  assert.doesNotMatch(text, /countBandHolders\(\{[^}]*\}\)\.catch/);
});
