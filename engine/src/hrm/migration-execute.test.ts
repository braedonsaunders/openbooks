import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMigrationRef,
  EmploymentMigrationError,
  finalizeEmploymentMigrationReport,
  migrationExitCode,
  parseMigrationRef,
  type EmploymentMigrationReport,
  type PersonMigrationResult,
} from "./migration-execute.ts";

// Static imports evaluate before the module body, so the launch command MUST
// set OPENBOOKS_DB_URL= explicitly; these assignments only re-assert that for
// anything resolved lazily afterwards. These tests never touch a database —
// every helper exercised here is pure.
process.env.OPENBOOKS_DB_URL = "";
process.env.OPENBOOKS_MIGRATION_DB_URL = "";

function person(overrides: Partial<PersonMigrationResult> = {}): PersonMigrationResult {
  return {
    orgId: "org-001",
    sourceNamespace: "legacy-extract",
    sourceId: "person-001",
    nativePartyId: "party-001",
    classification: "ready",
    outcome: "migrated",
    employmentId: "employment-001",
    candidateDigest: "a".repeat(64),
    historicalCoverage: "unknown",
    serviceStart: "2022-03-14",
    serviceStartProvenance: "role-ev-hire",
    issues: [],
    notes: [],
    diff: null,
    ...overrides,
  };
}

function finalize(
  persons: readonly PersonMigrationResult[],
  overrides: { dryRun?: boolean; allowPartial?: boolean; status?: "evaluated" | "empty_not_evaluated" } = {},
): EmploymentMigrationReport {
  const counts = {
    migrated: persons.filter((p) => p.outcome === "migrated").length,
    alreadyMigrated: persons.filter((p) => p.outcome === "already_migrated").length,
    wouldMigrate: persons.filter((p) => p.outcome === "would_migrate").length,
    refused: persons.filter((p) => p.outcome === "refused").length,
  };
  return finalizeEmploymentMigrationReport({
    orgId: "org-001",
    dryRun: overrides.dryRun ?? false,
    allowPartial: overrides.allowPartial ?? false,
    status: overrides.status ?? "evaluated",
    generatedAt: "2026-09-19T12:00:00.000Z",
    persons,
    totals: {
      persons: persons.length,
      ...counts,
      employmentsWritten: 0,
      versionsWritten: 0,
      assignmentsWritten: 0,
      changesWritten: 0,
    },
  });
}

test("report hash is deterministic and binds content", () => {
  const first = finalize([person()]);
  const second = finalize([person()]);
  assert.equal(first.reportHash, second.reportHash);
  assert.match(first.reportHash, /^[0-9a-f]{64}$/);
  const changed = finalize([person({ outcome: "refused" })]);
  assert.notEqual(first.reportHash, changed.reportHash);
});

test("report hash is stable across evaluation timestamps (production interlock)", () => {
  const at = (generatedAt: string) =>
    finalizeEmploymentMigrationReport({
      orgId: "org-001",
      dryRun: true,
      allowPartial: false,
      status: "evaluated",
      generatedAt,
      persons: [person({ outcome: "would_migrate", employmentId: null })],
      totals: {
        persons: 1,
        migrated: 0,
        alreadyMigrated: 0,
        wouldMigrate: 1,
        refused: 0,
        employmentsWritten: 0,
        versionsWritten: 0,
        assignmentsWritten: 0,
        changesWritten: 0,
      },
    }).reportHash;
  assert.equal(at("2026-09-19T12:00:00.000Z"), at("2026-09-19T12:00:01.000Z"));
});

test("summary names per-person outcome, digest, and issues with remedies", () => {
  const report = finalize([
    person({ sourceId: "person-001" }),
    person({
      sourceId: "person-002",
      classification: "requires_review",
      outcome: "refused",
      employmentId: null,
      issues: [
        {
          code: "roleless_payroll_evidence",
          level: "requires_review",
          detail: "payroll evidence exists with no role",
          remedy: "Supply collector evidence confirming the employee role",
        },
      ],
    }),
  ]);
  assert.match(report.summary, /person-001 -> migrated/);
  assert.match(report.summary, new RegExp(`digest ${"a".repeat(12)}`));
  assert.match(report.summary, /person-002 -> refused/);
  assert.match(report.summary, /requires_review\/roleless_payroll_evidence/);
  assert.match(report.summary, /remedy: Supply collector evidence/);
});

test("empty inventory is never a clean claim", () => {
  const report = finalize([], { status: "empty_not_evaluated" });
  assert.match(report.summary, /not evaluated/);
  assert.equal(migrationExitCode(report), 1);
});

test("exit code: clean and already-migrated pass; refused blocks without partial", () => {
  assert.equal(migrationExitCode(finalize([person()])), 0);
  assert.equal(
    migrationExitCode(finalize([person({ outcome: "already_migrated", employmentId: "e-1" })])),
    0,
  );
  assert.equal(migrationExitCode(finalize([person({ outcome: "would_migrate", employmentId: null })], { dryRun: true })), 0);
  const refused = finalize([
    person({ sourceId: "p-ok" }),
    person({ sourceId: "p-bad", outcome: "refused", employmentId: null }),
  ]);
  assert.equal(migrationExitCode(refused), 1);
  assert.equal(migrationExitCode(finalize(refused.persons, { allowPartial: true })), 0);
});

test("evidence token round-trips namespaces needing encoding", () => {
  const ref = buildMigrationRef("legacy/hr extract", "person 001/2", "b".repeat(64), "extract v2");
  const parsed = parseMigrationRef(ref);
  assert.equal(parsed.sourceNamespace, "legacy/hr extract");
  assert.equal(parsed.sourceId, "person 001/2");
  assert.equal(parsed.sourceFingerprint, "b".repeat(64));
  assert.equal(parsed.sourceVersion, "extract v2");
});

test("corrupt evidence token fails closed, never guesses", () => {
  assert.throws(
    () => parseMigrationRef("hrm-employment-migration/v1 ns=only-ns"),
    (error: unknown) =>
      error instanceof EmploymentMigrationError &&
      /corrupt employment migration evidence/.test(error.message),
  );
  assert.throws(
    () => parseMigrationRef("some-other-process ref"),
    EmploymentMigrationError,
  );
});
