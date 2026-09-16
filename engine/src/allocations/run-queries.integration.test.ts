import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../test-fixtures.ts";
import { RunQueryError, getRun, listRuns, queryLineage } from "./run-queries.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Seed {
  orgId: string;
  actorId: string;
  ruleId: string;
  versionId: string;
  runPosted: string;
  runPreview: string;
}

async function seed(seedIn: { orgId: string; actorId: string; periodId: string; bookId: string }): Promise<Seed> {
  const { orgId, actorId, periodId, bookId } = seedIn;
  const ruleId = randomUUID();
  const versionId = randomUUID();
  await db.execute(sql`
    insert into allocation_rules (id, org_id, key, name, mode, created_by, updated_by)
    values (${ruleId}, ${orgId}, 'sweep', 'Sweep', 'period', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, definition_hash, created_by, updated_by)
    values
      (${versionId}, ${orgId}, ${ruleId}, 1, 'published', '2026-01-01', 'hash-1', ${actorId}, ${actorId})`);
  const runPosted = randomUUID();
  const runPreview = randomUUID();
  const computation = {
    ruleId, versionId, definitionHash: "hash-1", periodId, bookId,
    sourceMeasure: "period_activity", sources: [], sourceTotal: "100.00",
    targets: [], lines: [], residualPolicy: "largest_share", impact: "reclass",
  };
  await db.execute(sql`
    insert into allocation_runs
      (id, org_id, rule_id, version_id, definition_hash, period_id, book_id,
       status, trigger_kind, source_total, allocated_total, residual,
       computation, fingerprint, requested_by, started_at, completed_at, created_by, updated_by)
    values
      (${runPosted}, ${orgId}, ${ruleId}, ${versionId}, 'hash-1', ${periodId}, ${bookId},
       'posted', 'manual', '100.00', '100.00', '0.00',
       ${JSON.stringify(computation)}::jsonb, 'fp-1', ${actorId}, now(), now(), ${actorId}, ${actorId}),
      (${runPreview}, ${orgId}, ${ruleId}, ${versionId}, 'hash-1', ${periodId}, ${bookId},
       'previewed', 'manual', '50.00', '50.00', '0.00',
       ${JSON.stringify({ ...computation, sourceTotal: "50.00" })}::jsonb, 'fp-2', ${actorId}, now(), null, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into allocation_lineage
      (org_id, mode, rule_id, version_id, definition_hash, run_id, amount, share)
    values
      (${orgId}, 'period', ${ruleId}, ${versionId}, 'hash-1', ${runPosted}, '60.00', '0.6'),
      (${orgId}, 'period', ${ruleId}, ${versionId}, 'hash-1', ${runPosted}, '40.00', '0.4')`);
  return { orgId, actorId, ruleId, versionId, runPosted, runPreview };
}

test("listRuns filters by rule/status and reports totals", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const s = await seed({ orgId: org.orgId, actorId, periodId: org.periodId, bookId: org.bookId });
    const all = await listRuns(org.orgId);
    assert.equal(all.total, 2);
    assert.equal(all.runs.length, 2);
    assert.equal(all.runs[0]?.ruleKey, "sweep");

    const posted = await listRuns(org.orgId, { status: "posted" });
    assert.equal(posted.total, 1);
    assert.equal(posted.runs[0]?.id, s.runPosted);

    const missing = await listRuns(org.orgId, { ruleId: randomUUID() });
    assert.deepEqual(missing, { runs: [], total: 0 });

    const page = await listRuns(org.orgId, { limit: 1, offset: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.runs.length, 1);

    await assert.rejects(() => listRuns(org.orgId, { status: "bogus" as never }),
      (error: unknown) => error instanceof RunQueryError);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("getRun returns the stored computation; unknown id 404s", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const s = await seed({ orgId: org.orgId, actorId, periodId: org.periodId, bookId: org.bookId });
    const detail = await getRun(org.orgId, s.runPosted);
    assert.equal(detail.status, "posted");
    assert.equal(detail.fingerprint, "fp-1");
    assert.equal((detail.computation as { sourceTotal: string }).sourceTotal, "100.00");
    await assert.rejects(() => getRun(org.orgId, randomUUID()),
      (error: unknown) => error instanceof RunQueryError && error.code === "not_found");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("lineage drill anchors on one object and joins rule labels", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const s = await seed({ orgId: org.orgId, actorId, periodId: org.periodId, bookId: org.bookId });
    const byRun = await queryLineage(org.orgId, { runId: s.runPosted });
    assert.equal(byRun.rows.length, 2);
    assert.equal(byRun.rows[0]?.ruleKey, "sweep");
    assert.deepEqual(byRun.rows.map((r) => r.amount).sort(), ["40.0000", "60.0000"]);
    assert.equal(byRun.anchor.kind, "run");

    const byEntry = await queryLineage(org.orgId, { journalEntryId: randomUUID() });
    assert.deepEqual(byEntry.rows, []);

    await assert.rejects(() => queryLineage(org.orgId, {}), /exactly one/);
    await assert.rejects(() => queryLineage(org.orgId, { runId: s.runPosted, documentId: randomUUID() }), /exactly one/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("restricted subsidiary scope hides org-wide runs", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seed({ orgId: org.orgId, actorId, periodId: org.periodId, bookId: org.bookId });
    // Both seeded runs are org-wide (subsidiary null).
    const restricted = await listRuns(org.orgId, { allowedSubsidiaryIds: new Set([org.subsidiaryId]) });
    assert.deepEqual(restricted, { runs: [], total: 0 });
    const empty = await listRuns(org.orgId, { allowedSubsidiaryIds: new Set() });
    assert.deepEqual(empty, { runs: [], total: 0 });
    const open = await listRuns(org.orgId, { allowedSubsidiaryIds: null });
    assert.equal(open.total, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
