import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
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

test("S3: lineage anchors refuse hidden subsidiaries", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const s = await seed({ orgId: org.orgId, actorId, periodId: org.periodId, bookId: org.bookId });
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Branch Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
    // Entry A: header + lines in the caller's subsidiary.
    const entryA = randomUUID();
    await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${entryA}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entryA},
              '2026-07-15', ${org.periodId}, 'Entry A', 'draft', 'manual')`);
    await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entryA}, 1, ${org.accounts.adjustment}, ${org.subsidiaryId},
              '100.0000', 'CAD', '100.0000', '1'),
             (${org.orgId}, ${entryA}, 2, ${org.accounts.bank}, ${org.subsidiaryId},
              '-100.0000', 'CAD', '-100.0000', '1')`);
    const lineA = (await db.execute<{ id: string }>(sql`
      select id from journal_lines where org_id = ${org.orgId} and entry_id = ${entryA} and line_number = 1`))
      .rows[0]!.id;
    // Entry B lives entirely in the hidden subsidiary. (The GL kernel
    // refuses per-subsidiary-imbalanced entries, so a header-visible entry
    // with hidden lines cannot be written; the line check in the drill is
    // fail-closed defense for shapes the kernel never stores.)
    const entryB = randomUUID();
    await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${entryB}, ${org.orgId}, ${org.bookId}, ${subB}, ${entryB},
              '2026-07-15', ${org.periodId}, 'Entry B', 'draft', 'manual')`);
    await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entryB}, 1, ${org.accounts.adjustment}, ${subB},
              '50.0000', 'CAD', '50.0000', '1'),
             (${org.orgId}, ${entryB}, 2, ${org.accounts.bank}, ${subB},
              '-50.0000', 'CAD', '-50.0000', '1')`);
    await db.execute(sql`update journal_entries set status = 'posted'
       where org_id = ${org.orgId} and id in (${entryA}, ${entryB})`);
    // Document B lives entirely in the hidden subsidiary.
    const docB = randomUUID();
    await db.execute(sql`insert into documents
        (id, org_id, kind, document_number, document_date, currency, subsidiary_id, status)
      values (${docB}, ${org.orgId}, 'customer_invoice', 'DOC-B', '2026-07-15', 'CAD', ${subB}, 'draft')`);
    // Run A is pinned to A with an A-only computation: fully visible.
    const runA = randomUUID();
    const cleanComputation = {
      ruleId: s.ruleId, versionId: s.versionId, definitionHash: "hash-1", periodId: org.periodId,
      bookId: org.bookId, sourceMeasure: "period_activity",
      sources: [{ subsidiaryId: org.subsidiaryId }],
      sourceTotal: "10.00", targets: [{ coordinate: { subsidiaryId: org.subsidiaryId } }],
      lines: [], residualPolicy: "largest_share", impact: "reclass",
    };
    await db.execute(sql`
      insert into allocation_runs
        (id, org_id, rule_id, version_id, definition_hash, period_id, book_id, subsidiary_id,
         status, trigger_kind, source_total, allocated_total, residual,
         computation, fingerprint, requested_by, started_at, completed_at, created_by, updated_by)
      values (${runA}, ${org.orgId}, ${s.ruleId}, ${s.versionId}, 'hash-1', ${org.periodId}, ${org.bookId},
        ${org.subsidiaryId}, 'previewed', 'manual', '10.00', '10.00', '0.00',
        ${JSON.stringify(cleanComputation)}::jsonb, 'fp-a', ${actorId}, now(), now(), ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into allocation_lineage
        (org_id, mode, rule_id, version_id, definition_hash, run_id, amount, share)
      values (${org.orgId}, 'period', ${s.ruleId}, ${s.versionId}, 'hash-1', ${runA}, '10.00', '1.0')`);
    // Run AB is pinned to A but its computation touches B.
    const runAB = randomUUID();
    const crossedComputation = {
      ruleId: s.ruleId, versionId: s.versionId, definitionHash: "hash-1", periodId: org.periodId,
      bookId: org.bookId, sourceMeasure: "period_activity",
      sources: [{ subsidiaryId: org.subsidiaryId }],
      sourceTotal: "10.00", targets: [{ coordinate: { subsidiaryId: subB } }],
      lines: [], residualPolicy: "largest_share", impact: "reclass",
    };
    await db.execute(sql`
      insert into allocation_runs
        (id, org_id, rule_id, version_id, definition_hash, period_id, book_id, subsidiary_id,
         status, trigger_kind, source_total, allocated_total, residual,
         computation, fingerprint, requested_by, started_at, completed_at, created_by, updated_by)
      values (${runAB}, ${org.orgId}, ${s.ruleId}, ${s.versionId}, 'hash-1', ${org.periodId}, ${org.bookId},
        ${org.subsidiaryId}, 'posted', 'manual', '10.00', '10.00', '0.00',
        ${JSON.stringify(crossedComputation)}::jsonb, 'fp-x', ${actorId}, now(), now(), ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into allocation_lineage
        (org_id, mode, rule_id, version_id, definition_hash, run_id, journal_entry_id, journal_line_id,
         document_id, amount, share)
      values (${org.orgId}, 'period', ${s.ruleId}, ${s.versionId}, 'hash-1', ${s.runPosted}, null, null,
              null, '10.00', '1.0'),
             (${org.orgId}, 'period', ${s.ruleId}, ${s.versionId}, 'hash-1', ${s.runPosted}, ${entryA}, ${lineA},
              null, '100.0000', '1.0'),
             (${org.orgId}, 'period', ${s.ruleId}, ${s.versionId}, 'hash-1', ${runAB}, ${entryB}, null,
              null, '50.0000', '1.0'),
             (${org.orgId}, 'period', ${s.ruleId}, ${s.versionId}, 'hash-1', ${runAB}, null, null,
              ${docB}, '20.0000', '1.0')`);
    const allowedA = new Set([org.subsidiaryId]);
    // Visible anchors drill normally.
    assert.equal((await queryLineage(org.orgId, { runId: runA }, { allowedSubsidiaryIds: allowedA })).total, 1);
    const byEntry = await queryLineage(org.orgId, { journalEntryId: entryA }, { allowedSubsidiaryIds: allowedA });
    assert.equal(byEntry.total, 1);
    // Hidden anchors are tenant-opaque not_found for every anchor kind: the
    // org-wide seeded run, the B-touching run, the B entry, the B document.
    const hidden = [{ runId: s.runPosted }, { runId: runAB }, { journalEntryId: entryB }, { documentId: docB }] as const;
    for (const query of hidden) {
      await assert.rejects(() => queryLineage(org.orgId, query, { allowedSubsidiaryIds: allowedA }),
        (error: unknown) => error instanceof RunQueryError && error.code === "not_found");
    }
    // Unrestricted callers still see everything.
    assert.equal((await queryLineage(org.orgId, { runId: runAB })).total, 2);
    assert.equal((await queryLineage(org.orgId, { journalEntryId: entryB })).total, 1);
    assert.equal((await queryLineage(org.orgId, { documentId: docB })).total, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("S3: lineage paginates instead of silently truncating", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const s = await seed({ orgId: org.orgId, actorId, periodId: org.periodId, bookId: org.bookId });
    for (let batch = 0; batch < 25; batch += 1) {
      const chunks = Array.from(
        { length: 10 },
        () => sql`(${randomUUID()}, ${org.orgId}, 'period', ${s.ruleId}, ${s.versionId}, 'hash-1', ${s.runPosted}, '1.00', '0.1')`,
      );
      await db.execute(sql`
        insert into allocation_lineage (id, org_id, mode, rule_id, version_id, definition_hash, run_id, amount, share)
        values ${sql.join(chunks, sql`, `)}`);
    }
    // 2 seeded + 250 bulk rows.
    const first = await queryLineage(org.orgId, { runId: s.runPosted });
    assert.equal(first.total, 252);
    assert.equal(first.rows.length, 200);
    assert.equal(first.truncated, true);
    const second = await queryLineage(org.orgId, { runId: s.runPosted }, { limit: 100, offset: 200 });
    assert.equal(second.total, 252);
    assert.equal(second.rows.length, 52);
    assert.equal(second.truncated, false);
    assert.equal(second.limit, 100);
    assert.equal(second.offset, 200);
    await assert.rejects(() => queryLineage(org.orgId, { runId: s.runPosted }, { limit: 0 }), /limit must be 1..500/);
    await assert.rejects(() => queryLineage(org.orgId, { runId: s.runPosted }, { offset: -1 }), /offset must be >= 0/);
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
