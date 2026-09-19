import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { db, pool, withBypassContext, withOrg } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "../test-fixtures.ts";
import {
  EmploymentMigrationRefusalError,
  executeEmploymentMigration,
  migrationExitCode,
  parseMigrationRef,
  type EmploymentMigrationReport,
  type PersonMigrationResult,
} from "./migration-execute.ts";
import {
  fingerprintSourceRow,
  type SourcePersonRow,
} from "./migration-preflight.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

/**
 * Slice B executor proofs (integration partition): dry-run sterility,
 * ready-org migration with digest-bound evidence, idempotent re-run,
 * drift refusal with the diff, whole-org rollback versus partial
 * application, tenant RLS, and acceptance by the 0184 storage triggers
 * with no bypass anywhere on the write path.
 */

const NS = "legacy-extract";

interface PersonSeed {
  partyId: string;
  row: SourcePersonRow;
}

async function mkParty(orgId: string, name: string): Promise<string> {
  return withOrg(orgId, async () => {
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name)
      values (${orgId}, 'person', ${name}) returning id::text as id`)) as unknown as {
      rows: Array<{ id: string }>;
    };
    const id = inserted.rows[0]?.id;
    assert.ok(id, "party insert must return exactly one row");
    return id;
  });
}

function readyRow(orgId: string, subId: string, partyId: string, sourceId: string): SourcePersonRow {
  return {
    orgId,
    sourceNamespace: NS,
    sourceId,
    nativePartyId: partyId,
    sourceVersion: "extract-2026-09-01",
    party: {
      kind: "employee",
      isActive: true,
      subsidiaryId: subId,
      sourceIsNew: false,
      evidenceIds: [`party-ev-${sourceId}`],
    },
    employer: {
      assertedSubsidiaryId: subId,
      subsidiaryFacts: [{ id: subId, orgId, isActive: true, isEliminated: false }],
      historicSubsidiaryIds: [],
    },
    role: {
      present: true,
      isActive: true,
      hiredOn: "2022-03-14",
      terminatedOn: null,
      dateProvenance: `role-ev-${sourceId}`,
      countryContext: null,
      evidenceIds: [`role-ev-${sourceId}`],
    },
    payroll: {
      present: true,
      isActive: true,
      subsidiaryId: subId,
      countryContext: null,
      evidenceIds: [`pay-ev-${sourceId}`],
    },
    observation: {
      status: "active",
      observedAt: "2026-09-10T12:00:00Z",
      provenance: `collector-${sourceId}`,
    },
    resolution: null,
    existingBinding: null,
  };
}

/** Role-less payroll with no observation: classifier requires_review. */
function reviewRow(orgId: string, subId: string, partyId: string, sourceId: string): SourcePersonRow {
  const row = readyRow(orgId, subId, partyId, sourceId);
  return { ...row, role: null, observation: null };
}

/** Service dates but no current observation: ready, yet nothing to anchor. */
function unanchoredRow(orgId: string, subId: string, partyId: string, sourceId: string): SourcePersonRow {
  const row = readyRow(orgId, subId, partyId, sourceId);
  return { ...row, observation: null };
}

async function seedPerson(
  org: ScratchOrg,
  sourceId: string,
  kind: "ready" | "review" | "unanchored" = "ready",
): Promise<PersonSeed> {
  const partyId = await mkParty(org.orgId, `Migration ${sourceId}`);
  const builders = { ready: readyRow, review: reviewRow, unanchored: unanchoredRow };
  return { partyId, row: builders[kind](org.orgId, org.subsidiaryId, partyId, sourceId) };
}

interface TableCounts {
  employments: number;
  versions: number;
  assignments: number;
  changes: number;
}

async function tableCounts(orgId: string): Promise<TableCounts> {
  return withBypassContext(async () => {
    const result = (await db.execute<{
      employments: string;
      versions: string;
      assignments: string;
      changes: string;
    }>(sql`select (select count(*)::text from worker_employments where org_id = ${orgId}) as employments,
                  (select count(*)::text from worker_employment_versions where org_id = ${orgId}) as versions,
                  (select count(*)::text from employment_assignments where org_id = ${orgId}) as assignments,
                  (select count(*)::text from employment_changes where org_id = ${orgId}) as changes`)) as unknown as {
      rows: Array<{ employments: string; versions: string; assignments: string; changes: string }>;
    };
    const row = result.rows[0]!;
    return {
      employments: Number(row.employments),
      versions: Number(row.versions),
      assignments: Number(row.assignments),
      changes: Number(row.changes),
    };
  });
}

/** Tenant-scoped read through a raw RLS session: no bypass, explicit org. */
async function scopedCount(orgId: string, table: string): Promise<number> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'off', true)");
    await client.query("select set_config('app.current_org', $1, true)", [orgId]);
    const result = await client.query(`select count(*)::int as n from ${table}`);
    await client.query("rollback");
    return (result.rows[0] as { n: number }).n;
  } finally {
    client.release();
  }
}

function onlyPerson(report: EmploymentMigrationReport): PersonMigrationResult {
  assert.equal(report.persons.length, 1);
  return report.persons[0]!;
}

test("dry run writes nothing and plans would_migrate", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const seed = await seedPerson(org, "dry-001");
    const before = await tableCounts(org.orgId);
    const report = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows: [seed.row], dryRun: true }),
    );
    assert.equal(report.totals.wouldMigrate, 1);
    assert.equal(report.totals.refused, 0);
    assert.equal(report.totals.employmentsWritten, 0);
    assert.deepEqual(await tableCounts(org.orgId), before);
    assert.equal(migrationExitCode(report), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("ready org migrates with digest-bound evidence; triggers accept without bypass", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const first = await seedPerson(org, "mig-001");
    const secondParty = await mkParty(org.orgId, "Migration mig-002");
    // Observation-anchored but no service start: coverage stays unknown and
    // no hire date is invented.
    const secondRow: SourcePersonRow = {
      ...readyRow(org.orgId, org.subsidiaryId, secondParty, "mig-002"),
      role: {
        present: true,
        isActive: true,
        hiredOn: null,
        terminatedOn: null,
        dateProvenance: null,
        countryContext: null,
        evidenceIds: ["role-ev-mig-002"],
      },
      payroll: {
        present: true,
        isActive: true,
        subsidiaryId: org.subsidiaryId,
        countryContext: null,
        evidenceIds: ["pay-ev-mig-002"],
      },
    };
    const report = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows: [first.row, secondRow] }),
    );
    assert.equal(report.totals.migrated, 2);
    assert.equal(report.totals.refused, 0);
    assert.deepEqual(await tableCounts(org.orgId), {
      employments: 2,
      versions: 2,
      assignments: 2,
      changes: 2,
    });
    for (const person of report.persons) {
      assert.equal(person.outcome, "migrated");
      assert.ok(person.employmentId, "migrated persons name their employment");
      assert.equal(person.historicalCoverage, "unknown");
    }
    const [known, unknown] = report.persons;
    assert.equal(known!.serviceStart, "2022-03-14");
    assert.equal(known!.serviceStartProvenance, "role-ev-mig-001");
    assert.equal(unknown!.serviceStart, null);
    assert.equal(unknown!.serviceStartProvenance, null);

    // The evidence columns bind the candidate digest: the recorded token
    // parses to this run's namespace, source id, fingerprint, and version.
    const evidence = await withBypassContext(async () => {
      const result = (await db.execute<{
        employment_id: string;
        ref: string;
        reason: string;
        kind: string;
        source: string;
      }>(sql`select employment_id::text as employment_id, recorded_source_ref as ref,
                    reason, change_kind as kind, recorded_source as source
               from employment_changes
              where org_id = ${org.orgId} order by recorded_at`)) as unknown as {
        rows: Array<{
          employment_id: string;
          ref: string;
          reason: string;
          kind: string;
          source: string;
        }>;
      };
      return result.rows;
    });
    assert.equal(evidence.length, 2);
    for (const [index, row] of evidence.entries()) {
      const person = report.persons[index]!;
      assert.equal(row.kind, "created");
      assert.equal(row.source, "system");
      assert.equal(row.employment_id, person.employmentId);
      const parsed = parseMigrationRef(row.ref);
      assert.equal(parsed.sourceNamespace, NS);
      assert.equal(parsed.sourceId, person.sourceId);
      assert.equal(parsed.sourceFingerprint, person.candidateDigest);
      assert.equal(parsed.sourceFingerprint, fingerprintSourceRow([first.row, secondRow][index]!));
      assert.match(row.reason, new RegExp(person.candidateDigest.slice(0, 12)));
    }

    // Canonical rows carry the observation-date migration, not invented dates.
    const stored = await withBypassContext(async () => {
      const result = (await db.execute<{
        worker: string;
        employer: string;
        service_start: string | null;
        service_provenance: string | null;
        status: string;
        effective_from: string;
      }>(sql`select e.worker_party_id::text as worker,
                    e.employer_subsidiary_id::text as employer,
                    e.service_start::text as service_start,
                    e.service_start_provenance as service_provenance,
                    v.status as status, v.effective_from::text as effective_from
               from worker_employments e
               join worker_employment_versions v
                 on v.org_id = e.org_id and v.employment_id = e.id
              where e.org_id = ${org.orgId} order by e.created_at`)) as unknown as {
        rows: Array<{
          worker: string;
          employer: string;
          service_start: string | null;
          service_provenance: string | null;
          status: string;
          effective_from: string;
        }>;
      };
      return result.rows;
    });
    assert.equal(stored.length, 2);
    assert.equal(stored[0]!.worker, first.partyId);
    assert.equal(stored[0]!.employer, org.subsidiaryId);
    assert.equal(stored[0]!.service_start, "2022-03-14");
    assert.equal(stored[0]!.service_provenance, "role-ev-mig-001");
    assert.equal(stored[0]!.status, "active");
    assert.equal(stored[0]!.effective_from, "2026-09-10");
    assert.equal(stored[1]!.service_start, null);
    assert.equal(stored[1]!.service_provenance, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("re-run with the same inputs is a no-op reporting already_migrated", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const seed = await seedPerson(org, "idem-001");
    const first = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows: [seed.row] }),
    );
    assert.equal(onlyPerson(first).outcome, "migrated");
    const before = await tableCounts(org.orgId);
    const second = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows: [seed.row] }),
    );
    const person = onlyPerson(second);
    assert.equal(person.classification, "already_migrated");
    assert.equal(person.outcome, "already_migrated");
    assert.equal(person.employmentId, onlyPerson(first).employmentId);
    assert.deepEqual(await tableCounts(org.orgId), before);
    assert.equal(migrationExitCode(second), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("changed inputs refuse with the diff and write nothing", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const seed = await seedPerson(org, "drift-001");
    await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows: [seed.row] }),
    );
    const before = await tableCounts(org.orgId);
    // Same source key and version, but the hire date moved: source drift.
    const drifted: SourcePersonRow = {
      ...seed.row,
      role: { ...seed.row.role!, hiredOn: "2023-05-01" },
    };
    const refusal = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows: [drifted] }),
    ).then(
      () => {
        throw new Error("drifted re-migration was expected to refuse");
      },
      (error: unknown) => {
        assert.ok(error instanceof EmploymentMigrationRefusalError);
        return error;
      },
    );
    const person = onlyPerson(refusal.report);
    assert.equal(person.classification, "binding_conflict");
    assert.equal(person.outcome, "refused");
    assert.ok(person.diff, "drift refusal carries the diff");
    assert.notEqual(person.diff!.actual.sourceFingerprint, person.diff!.expected.sourceFingerprint);
    assert.equal(person.diff!.actual.sourceVersion, person.diff!.expected.sourceVersion);
    assert.deepEqual(await tableCounts(org.orgId), before);
    assert.equal(migrationExitCode(refusal.report), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("requires_review refuses the whole org; partial writes only the ready subset", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const ready = await seedPerson(org, "part-001");
    const review = await seedPerson(org, "part-002", "review");
    const rows = [ready.row, review.row];
    const refusal = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows }),
    ).then(
      () => {
        throw new Error("mixed-org migration was expected to refuse");
      },
      (error: unknown) => {
        assert.ok(error instanceof EmploymentMigrationRefusalError);
        return error;
      },
    );
    assert.equal(refusal.report.totals.refused, 1);
    assert.deepEqual(await tableCounts(org.orgId), {
      employments: 0,
      versions: 0,
      assignments: 0,
      changes: 0,
    });

    const partial = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows, allowPartial: true }),
    );
    assert.equal(partial.totals.migrated, 1);
    assert.equal(partial.totals.refused, 1);
    const refused = partial.persons.find((p) => p.sourceId === "part-002")!;
    assert.equal(refused.outcome, "refused");
    assert.equal(refused.classification, "requires_review");
    assert.ok(refused.issues.length > 0, "refusal names the remedy");
    assert.deepEqual(await tableCounts(org.orgId), {
      employments: 1,
      versions: 1,
      assignments: 1,
      changes: 1,
    });
    assert.equal(migrationExitCode(partial), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("ready without an observation is refused, never invented", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const seed = await seedPerson(org, "unanch-001", "unanchored");
    const refusal = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows: [seed.row] }),
    ).then(
      () => {
        throw new Error("unanchored migration was expected to refuse");
      },
      (error: unknown) => {
        assert.ok(error instanceof EmploymentMigrationRefusalError);
        return error;
      },
    );
    const person = onlyPerson(refusal.report);
    assert.equal(person.classification, "ready");
    assert.equal(person.outcome, "refused");
    assert.ok(
      person.issues.some((issue) => issue.code === "missing_current_observation"),
      "refusal names the missing observation",
    );
    assert.deepEqual(await tableCounts(org.orgId), {
      employments: 0,
      versions: 0,
      assignments: 0,
      changes: 0,
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("rows land in the right org only: cross-org reads see nothing", { skip }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    const seed = await seedPerson(orgA, "rls-001");
    await withOrg(orgA.orgId, () =>
      executeEmploymentMigration({ orgId: orgA.orgId, rows: [seed.row] }),
    );
    for (const table of [
      "worker_employments",
      "worker_employment_versions",
      "employment_assignments",
      "employment_changes",
    ]) {
      assert.equal(await scopedCount(orgB.orgId, table), 0, `${table} leaks across orgs`);
      assert.equal(await scopedCount(orgA.orgId, table), 1, `${table} missing in home org`);
    }
    assert.deepEqual(await tableCounts(orgB.orgId), {
      employments: 0,
      versions: 0,
      assignments: 0,
      changes: 0,
    });
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

test("multi-org batch is refused before any write", { skip }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    const first = await seedPerson(orgA, "multi-001");
    const second = await seedPerson(orgB, "multi-002");
    await assert.rejects(
      executeEmploymentMigration({ orgId: orgA.orgId, rows: [first.row, second.row] }),
      /multi-org batch/,
    );
    assert.deepEqual(await tableCounts(orgA.orgId), {
      employments: 0,
      versions: 0,
      assignments: 0,
      changes: 0,
    });
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

test("non-uuid tenant scope is refused", async () => {
  await assert.rejects(
    executeEmploymentMigration({ orgId: "not-a-uuid", rows: [], dryRun: true }),
    /not a valid UUID/,
  );
});
