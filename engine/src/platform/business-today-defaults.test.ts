import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Server-side "today" defaults must be the org's business day, never the
// UTC day: `new Date().toISOString().slice(0, 10)` is tomorrow in the
// evening for the Americas, so evening operators filed records, postings,
// certificates, and scans a day ahead. The canonical source is
// businessToday(orgId) (platform/business-date.ts); business-date.test.ts
// proves its zone semantics, and this file pins the call sites that were
// migrated to it so a UTC-today default cannot creep back.
//
// Exempt by design: sync/connection.ts keeps a `?? UTC-day` fallback because
// the validator is synchronous and pure — both production callers inject the
// business day (asserted below), so the fallback only serves direct unit
// callers that pass `today` explicitly.

const UTC_TODAY = /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/;

const CALLERS = [
  "web/app/api/hrm/org-chart/route.ts",
  "web/app/api/allocations/entry-candidates/route.ts",
  "web/app/api/payroll/certificates/route.ts",
  "web/lib/hrm/compliance.ts",
  "engine/src/projects/subcontract-commitments.ts",
  "engine/src/hrm/construction/certified.ts",
  "engine/src/hrm/recruiting/postings.ts",
  "engine/src/allocations/match.ts",
  "engine/src/automations/event-verbs.ts",
  "engine/src/automations/execute.ts",
  "engine/src/harness/scenario.ts",
];

test("server today-defaults come from the org business day, not the UTC day", () => {
  for (const file of CALLERS) {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
    assert.ok(
      !UTC_TODAY.test(source),
      `${file}: a UTC-today default remains — use businessToday(orgId)`,
    );
    assert.ok(
      source.includes("businessToday"),
      `${file}: the business-day wiring is missing`,
    );
  }
});

test("both connection validators inject the business day", () => {
  for (const file of [
    "web/app/api/platform/connections/route.ts",
    "web/app/api/platform/connections/[id]/route.ts",
  ]) {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
    assert.ok(
      source.includes("businessToday"),
      `${file}: validateSourceConfig must receive the org business day as opts.today`,
    );
  }
});
