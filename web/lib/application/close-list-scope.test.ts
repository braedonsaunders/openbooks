import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Close diagnostics are organization-wide: listCloseRuns must refuse a
// subsidiary-scoped caller by name, never report them as having no runs.
const source = readFileSync(join(import.meta.dirname, "close.ts"), "utf8");
const start = source.indexOf("export async function listCloseRuns");
assert.ok(start >= 0, "listCloseRuns must exist in web/lib/application/close.ts");
const nextExport = source.indexOf("export async function", start + 1);
const body = nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);

test("listCloseRuns refuses subsidiary-scoped callers with the org-wide diagnostics message", () => {
  // The named refusal and its 403 guard live at module scope (above
  // listCloseRuns); the body must wire that guard in.
  assert.ok(
    source.includes("CLOSE_ORG_WIDE_DIAGNOSTICS_REFUSAL"),
    "close.ts must define CLOSE_ORG_WIDE_DIAGNOSTICS_REFUSAL",
  );
  assert.ok(
    source.includes("assertUnrestrictedCloseDiagnostics"),
    "close.ts must define the unrestricted-subsidiary guard",
  );
  assert.ok(
    source.includes('throw new ApplicationError("forbidden", CLOSE_ORG_WIDE_DIAGNOSTICS_REFUSAL, 403)'),
    "the guard must throw ApplicationError forbidden 403 with the named refusal",
  );
  assert.ok(
    body.includes("assertUnrestrictedCloseDiagnostics"),
    "listCloseRuns must enforce the unrestricted-subsidiary guard",
  );
});

test("listPeriodReopenRequests refuses subsidiary-scoped callers with the same org-wide message", () => {
  const start = source.indexOf("export async function listPeriodReopenRequests");
  assert.ok(start >= 0, "listPeriodReopenRequests must exist");
  const next = source.indexOf("export async function", start + 1);
  const body = next === -1 ? source.slice(start) : source.slice(start, next);
  assert.ok(body.includes("assertUnrestrictedCloseDiagnostics"), "reopen list must enforce the org-wide guard");
  assert.ok(!body.includes("return []"), "reopen list must not return [] for a scoped caller");
});

test("listPeriodLocks refuses subsidiary-scoped callers with the same org-wide message", () => {
  const lockStart = source.indexOf("export async function listPeriodLocks");
  assert.ok(lockStart >= 0, "listPeriodLocks must exist in web/lib/application/close.ts");
  const lockNext = source.indexOf("export async function", lockStart + 1);
  const lockBody = lockNext === -1 ? source.slice(lockStart) : source.slice(lockStart, lockNext);
  assert.ok(
    lockBody.includes("assertUnrestrictedCloseDiagnostics"),
    "listPeriodLocks must enforce the unrestricted-subsidiary guard",
  );
  assert.ok(!lockBody.includes("return []"), "listPeriodLocks must not return [] for a scoped caller");
});

test("listCloseRuns never reports a scoped caller as an empty list", () => {
  assert.ok(!body.includes("return []"), "listCloseRuns must not return [] for a scoped caller");
  const scopeIndex = body.indexOf("allowedSubsidiaryIds");
  if (scopeIndex >= 0) {
    assert.ok(
      !body.slice(scopeIndex).includes("return []"),
      "no empty-list return may follow the subsidiary-scope check",
    );
  }
});
