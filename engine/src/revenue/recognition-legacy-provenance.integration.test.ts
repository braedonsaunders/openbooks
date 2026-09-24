import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  buildRecognitionSchedule,
  legacyRebuildBlock,
  reconcileLegacyObligationProvenance,
  RevenueRecognitionError,
} from "./recognition.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const MONTHS_2026 = [
  ["2026-01", "2026-01-01", "2026-01-31"],
  ["2026-02", "2026-02-01", "2026-02-28"],
  ["2026-03", "2026-03-01", "2026-03-31"],
  ["2026-04", "2026-04-01", "2026-04-30"],
  ["2026-05", "2026-05-01", "2026-05-31"],
  ["2026-06", "2026-06-01", "2026-06-30"],
  ["2026-07", "2026-07-01", "2026-07-31"],
  ["2026-08", "2026-08-01", "2026-08-31"],
  ["2026-09", "2026-09-01", "2026-09-30"],
  ["2026-10", "2026-10-01", "2026-10-31"],
  ["2026-11", "2026-11-01", "2026-11-30"],
  ["2026-12", "2026-12-01", "2026-12-31"],
] as const;

/** A January 12-month straight-line obligation with its schedule built. */
async function straightLineFixture() {
  const org = await createScratchOrg();
  const actorId = randomUUID();
  const calId = (await db.execute<{ id: string }>(sql`
    select id from fiscal_calendars where org_id = ${org.orgId} and is_default = true`)).rows[0]!.id;
  for (const [num, name, start, end] of MONTHS_2026.map(([name, start, end], i) => [i + 1, name, start, end] as const)) {
    // The scratch org already opens 2026-07; every other month is added.
    if (num === 7) continue;
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${org.orgId}, 2026, ${num}, ${name}, ${start}, ${end}, false, ${calId})`);
  }
  const ruleId = randomUUID();
  await db.execute(sql`
    insert into recognition_rules
      (id, org_id, code, name, method, is_forecast, recognition_periods, start_date_source, end_date_source,
       period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
    values (${ruleId}, ${org.orgId}, 'LEGACY-SL', 'Legacy straight line', 'straight_line_even', false, 12,
            'obligation', 'term', 0, 0, '0', ${org.accounts.deferred}, ${org.accounts.recognized}, true)`);
  const contractId = randomUUID();
  await db.execute(sql`
    insert into revenue_contracts
      (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
    values (${contractId}, ${org.orgId}, ${org.customerId}, 'LEGACY-SL-001', 'active', '2026-01-01',
            'CAD', '12000', ${actorId}, ${actorId})`);
  const obligationId = randomUUID();
  await db.execute(sql`
    insert into performance_obligations
      (id, org_id, contract_id, description, recognition_rule_id,
       booked_amount, allocated_price, recognition_starts_on, status, created_by, updated_by)
    values (${obligationId}, ${org.orgId}, ${contractId}, 'Legacy annual service', ${ruleId},
            '12000', '12000', '2026-01-01', 'open', ${actorId}, ${actorId})`);
  const build = await buildRecognitionSchedule(obligationId, org.orgId, actorId);
  assert.equal(build.lineCount, 12);
  return { org, actorId, ruleId, obligationId };
}

async function scheduleLines(orgId: string, obligationId: string) {
  return (await db.execute<{ month: string; planned: string; posted: boolean }>(sql`
    select p.starts_on::text as month, l.planned_amount::text as planned, (l.journal_entry_id is not null) as posted
      from recognition_schedule_lines l
      join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
      join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
     where s.obligation_id = ${obligationId} and s.org_id = ${orgId}
     order by p.starts_on`)).rows;
}

// ---------------------------------------------------------------------------
// U8: a prior-release rule edited in place, then upgraded
// ---------------------------------------------------------------------------

test("a rebuild of a legacy-pinned obligation refuses by name and leaves the schedule untouched", { skip: !DB }, async () => {
  const { org, ruleId, obligationId } = await straightLineFixture();
  try {
    const before = await scheduleLines(org.orgId, obligationId);
    assert.equal(before.length, 12);
    assert.ok(before.every((line) => line.planned === "1000.0000"));

    // The February in-place edit the old setup writer performed: the live
    // row now says point_in_time although January's obligation was built
    // straight-line. The upgrade stamps this row version 1 and records it.
    await db.execute(sql`
      update recognition_rules set method = 'point_in_time', updated_at = now()
       where id = ${ruleId} and org_id = ${org.orgId}`);
    await db.execute(sql`
      insert into upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
      values (${org.orgId}, '0297_recognition_rule_versions', 'recognition_rules', ${ruleId}, 'test mark')`);

    const block = await legacyRebuildBlock(db, org.orgId, obligationId);
    assert.ok(block, "the obligation must read blocked");
    assert.match(block.message, /legacy-unverified/);
    assert.match(block.message, /reconcile-legacy/);

    await assert.rejects(
      buildRecognitionSchedule(obligationId, org.orgId, randomUUID()),
      (error: unknown) => {
        assert.ok(error instanceof RevenueRecognitionError);
        assert.match(error.message, /legacy-unverified/);
        assert.match(error.message, /reconcile-legacy/);
        return true;
      },
      "the rebuild must refuse instead of re-timing January under February policy",
    );
    assert.deepEqual(await scheduleLines(org.orgId, obligationId), before);
  } finally {
    await db.execute(sql`delete from upgrade_legacy_provenance where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("reconciling a legacy obligation lifts the refusal for that obligation only", { skip: !DB }, async () => {
  const { org, actorId, ruleId, obligationId } = await straightLineFixture();
  try {
    await db.execute(sql`
      update recognition_rules set method = 'point_in_time', updated_at = now()
       where id = ${ruleId} and org_id = ${org.orgId}`);
    await db.execute(sql`
      insert into upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
      values (${org.orgId}, '0297_recognition_rule_versions', 'recognition_rules', ${ruleId}, 'test mark')`);

    // The remedy exists and is guarded: short reasons refuse, and there is
    // nothing to reconcile on a current rule.
    await assert.rejects(
      reconcileLegacyObligationProvenance(db, org.orgId, obligationId, actorId, "ok", null),
      /5 to 500 characters/,
    );
    await reconcileLegacyObligationProvenance(
      db, org.orgId, obligationId, actorId,
      "January schedule verified against the signed straight-line policy memo; February point-in-time edit postdates it",
      null,
    );
    const recorded = (await db.execute<{ at: string | null; reason: string | null }>(sql`
      select legacy_reconciled_at::text as at, legacy_reconciliation_reason as reason
        from performance_obligations where id = ${obligationId}`)).rows[0]!;
    assert.ok(recorded.at);
    assert.match(recorded.reason!, /straight-line policy memo/);
    await assert.rejects(
      reconcileLegacyObligationProvenance(db, org.orgId, obligationId, actorId, "a second attestation", null),
      /already reconciled/,
    );

    // Reconciled: the rebuild proceeds under the live (point-in-time)
    // policy — exactly what the refusal prevented while unverified.
    const build = await buildRecognitionSchedule(obligationId, org.orgId, actorId);
    assert.equal(build.lineCount, 1);
    const after = await scheduleLines(org.orgId, obligationId);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.planned, "12000.0000");
  } finally {
    await db.execute(sql`delete from upgrade_legacy_provenance where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a current rule rebuilds without reconciliation", { skip: !DB }, async () => {
  const { org, actorId, obligationId } = await straightLineFixture();
  try {
    assert.equal(await legacyRebuildBlock(db, org.orgId, obligationId), null);
    await assert.rejects(
      reconcileLegacyObligationProvenance(db, org.orgId, obligationId, actorId, "nothing is wrong here", null),
      /nothing to reconcile/,
    );
    const build = await buildRecognitionSchedule(obligationId, org.orgId, actorId);
    assert.equal(build.lineCount, 12);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
