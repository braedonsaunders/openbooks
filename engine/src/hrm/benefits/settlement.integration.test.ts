import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { createScratchUser, dropScratchOrg } from "../../testing/fixtures.ts";
import { seedAdoption, calculatedRun } from "../../payroll/filing-test-fixtures.ts";
import { calculatePayRun } from "../../payroll/run-calculation.ts";
import { commitPayRun } from "../../payroll/run-commit.ts";
import {
  linkPerson,
  seedComponent,
  seedEmployment,
  setupHarness,
  withHarness,
} from "../../testing/hrm-harness.ts";
import { BenefitsError } from "./errors.ts";
import {
  activateBenefitProgram,
  addProgramMembership,
  createBenefitProgram,
  closeBenefitProgram,
} from "./programs.ts";
import {
  approveBenefitAward,
  createBenefitAward,
  submitBenefitAward,
} from "./awards.ts";
import {
  createAdjustingAward,
  confirmAwardPayrollDelivery,
  previewIncentiveSettlement,
  queueAwardForPayRun,
  settleIncentivePeriod,
} from "./settlement.ts";
import {
  employmentBenefitStatement,
  myBenefitStatement,
} from "./benefit-statement.ts";

/**
 * Incentive settlement DB coverage (integration partition): full
 * program → measure → settle → approve → queue → deliver chain through the
 * real domain services, idempotent retry, overlap and revision races,
 * future-period and nothing-owed refusals, coverage exclusion, top-up
 * adjustments, external-delivery refusal, and the employee statement.
 * Every proof reads storage back; refusals assert the rows that must not
 * exist.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const SETTLE_SPEC = {
  users: [
    { key: "settlerId", name: "Settle Operator", handle: "settle_operator", permissions: ["hrm.benefits.read", "hrm.benefits.manage", "gl.read"], link: true },
    { key: "approverId", name: "Settle Approver", handle: "settle_approver", permissions: ["hrm.benefits.read", "hrm.benefits.manage", "gl.read"], link: true },
    { key: "financeId", name: "Settle Finance", handle: "settle_finance", permissions: ["hrm.benefits.read", "payroll.manage", "gl.read"], link: true },
    // Plain employee: self-service grants only, deliberately no HR grant.
    { key: "noSelfId", name: "No Self Grant", handle: "settle_no_self", permissions: [], link: true },
    { key: "employeeId", name: "Settle Employee", handle: "settle_employee", permissions: ["hrm.self.read"], link: true },
  ],
} as const;

type Harness = Awaited<ReturnType<typeof setupHarness<typeof SETTLE_SPEC>>>;

async function postEntry(
  h: Harness,
  lines: ReadonlyArray<{ account: string; amount: string }>,
  date = "2026-07-15",
): Promise<string> {
  const entry = randomUUID();
  // Native posting order: draft header, then lines, then post.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entry}, ${h.org.orgId}, ${h.org.bookId}, ${h.org.subsidiaryId},
              ${entry}, ${date}::date, ${h.org.periodId}, 'draft', 'manual')
    `);
    let n = 0;
    for (const line of lines) {
      n += 1;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${h.org.orgId}, ${entry}, ${n}, ${line.account}, ${h.org.subsidiaryId},
                ${line.amount}, 'USD', ${line.amount}, 1)
      `);
    }
    await tx.execute(sql`
      update journal_entries set status = 'posted', posted_at = now() where id = ${entry}
    `);
  });
  return entry;
}

async function seedProgram(h: Harness, overrides: Record<string, unknown> = {}) {
  const component = await seedComponent(h.org.orgId, { kind: "earning", code: `INC_${randomUUID().slice(0, 6)}` });
  const created = await createBenefitProgram({
    orgId: h.org.orgId,
    actorId: h.settlerId,
    code: `QPS_${randomUUID().slice(0, 6)}`,
    name: "Quarterly profit share",
    family: "incentive",
    currency: "USD",
    legalEntityId: h.org.subsidiaryId,
    effectiveFrom: "2026-01-01",
    payComponentId: component,
    deliveryMethod: "payroll",
    valuation: "percent",
    metric: "net_profit",
    metricScope: "company",
    allocation: "equal",
    percentRate: "10",
    frequency: "manual",
    periodBasis: "calendar",
    sourceAccountIds: [h.org.accounts.revenue, h.org.accounts.cogs],
    ...overrides,
  } as Parameters<typeof createBenefitProgram>[0]);
  return activateBenefitProgram({ orgId: h.org.orgId, actorId: h.settlerId, programId: created.id });
}

async function awardCount(orgId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_benefit_awards where org_id = ${orgId}
  `)).rows[0]!.n;
}

async function refuses(fn: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof BenefitsError, `expected BenefitsError, got ${error}`);
    assert.match((error as Error).message, pattern);
    return (error as Error).message;
  }
  assert.fail("expected a refusal");
}

test("settle records one draft award per payable recipient from posted profit", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const program = await seedProgram(h);
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Profit Crew" });
    await addProgramMembership({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      employmentId: worker.employmentId, effectiveFrom: "2026-01-01",
    });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-10000.0000" },
      { account: h.org.accounts.bank, amount: "10000.0000" },
    ]);
    await postEntry(h, [
      { account: h.org.accounts.cogs, amount: "4000.0000" },
      { account: h.org.accounts.bank, amount: "-4000.0000" },
    ]);
    const settled = await settleIncentivePeriod({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      periodFrom: "2026-07-01", periodTo: "2026-07-31",
    });
    // 10% of 6000 net = 600 payable to the single member.
    assert.equal(settled.awards.length, 1);
    assert.equal(settled.awards[0]!.value, "600.0000");
    assert.equal(settled.awards[0]!.status, "draft");
    assert.equal(settled.awards[0]!.currency, "USD");
    assert.ok(settled.preview.isEstimate === false);
    const evidence = settled.awards[0]!.evidence as Record<string, unknown>;
    // Membership writes bump the program revision (create 1, activate 2,
    // add member 3): the frozen revision is the one at settle time.
    assert.equal(evidence["programRevision"], settled.preview.programRevision);
    assert.equal(settled.preview.programRevision, 3);
    // Employee-safe evidence: no company totals, no entry ids.
    assert.equal(evidence["measuredValue"], undefined);
    assert.equal(evidence["sourceEntryIds"], undefined);
    const stored = (await db.execute<{ value: string; source_key: string }>(sql`
      select value::text as value, source_key from hrm_benefit_awards where org_id = ${h.org.orgId}
    `)).rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.value, "600.0000");
    assert.match(stored[0]!.source_key, /^settle:/);
    // The full frozen measure persists privately in source_snapshot (never
    // in employee-visible evidence): program identity, digest, book, entry
    // ids, and totals.
    const persisted = (await db.execute<{ source_snapshot: unknown; program_snapshot: unknown }>(sql`
      select source_snapshot, program_snapshot from hrm_benefit_awards where org_id = ${h.org.orgId}
    `)).rows[0]!;
    const measurement = (
      (persisted.source_snapshot as Record<string, Record<string, Record<string, unknown>>>).measurement as Record<string, Record<string, unknown>>
    ).settlement as Record<string, unknown>;
    assert.ok(measurement && typeof measurement === "object", "source_snapshot.measurement.settlement holds the frozen measure");
    assert.equal(measurement["programCode"], settled.preview.programCode);
    assert.match(String(measurement["digest"] ?? ""), /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(measurement["entryIds"]) && (measurement["entryIds"] as unknown[]).length === 2);
    assert.equal(measurement["measuredValue"], "6000.0000");
    assert.equal((measurement.postingFacts as unknown[]).length, 2);
    assert.equal((measurement.memberships as Array<{employmentId: string}>)[0]!.employmentId, worker.employmentId);
    assert.equal((persisted.program_snapshot as Record<string, unknown>)["name"], program.name);
  });
});

test("a retried settlement returns the same awards instead of recording twice", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const program = await seedProgram(h);
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Retry Crew" });
    await addProgramMembership({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      employmentId: worker.employmentId, effectiveFrom: "2026-01-01",
    });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-10000.0000" },
      { account: h.org.accounts.bank, amount: "10000.0000" },
    ]);
    const query = {
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      periodFrom: "2026-07-01", periodTo: "2026-07-31",
    };
    const first = await settleIncentivePeriod(query);
    const second = await settleIncentivePeriod(query);
    assert.deepEqual(
      second.awards.map((a) => a.id).sort(),
      first.awards.map((a) => a.id).sort(),
    );
    assert.equal(await awardCount(h.org.orgId), first.awards.length);
  });
});

test("moved sources refuse the overlap and direct corrections to adjusting awards", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const program = await seedProgram(h);
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Overlap Crew" });
    await addProgramMembership({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      employmentId: worker.employmentId, effectiveFrom: "2026-01-01",
    });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-10000.0000" },
      { account: h.org.accounts.bank, amount: "10000.0000" },
    ]);
    const query = {
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      periodFrom: "2026-07-01", periodTo: "2026-07-31",
    };
    await settleIncentivePeriod(query);
    // A late posting moves the base: the same settlement must not rewrite.
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-2000.0000" },
      { account: h.org.accounts.bank, amount: "2000.0000" },
    ]);
    await refuses(() => settleIncentivePeriod(query), /never rewritten.*adjusting awards/);
    assert.equal(await awardCount(h.org.orgId), 1);
  });
});

test("nothing owed records nothing: a threshold miss refuses with no rows", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const program = await seedProgram(h, { thresholdAmount: "999999.0000" });
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Threshold Crew" });
    await addProgramMembership({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      employmentId: worker.employmentId, effectiveFrom: "2026-01-01",
    });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-10000.0000" },
      { account: h.org.accounts.bank, amount: "10000.0000" },
    ]);
    await refuses(
      () => settleIncentivePeriod({
        orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
        periodFrom: "2026-07-01", periodTo: "2026-07-31",
      }),
      /owes nothing/,
    );
    assert.equal(await awardCount(h.org.orgId), 0);
  });
});

test("open periods settle never; previews label them estimates", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const program = await seedProgram(h);
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Future Crew" });
    await addProgramMembership({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      employmentId: worker.employmentId, effectiveFrom: "2026-01-01",
    });
    const query = {
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      periodFrom: "2096-07-01", periodTo: "2096-07-31",
    };
    await refuses(() => settleIncentivePeriod(query), /settle closed periods only/);
    assert.equal(await awardCount(h.org.orgId), 0);
    const preview = await previewIncentiveSettlement(query);
    assert.equal(preview.isEstimate, true);
    assert.ok(preview.computation.summaryLines.some((l) => l.startsWith("estimate:")));
  });
});

test("mid-period members take no share without a proration policy", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const program = await seedProgram(h);
    const full = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Full Crew" });
    const partial = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Partial Crew" });
    for (const worker of [full, partial]) {
      await addProgramMembership({
        orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
        employmentId: worker.employmentId,
        effectiveFrom: worker === full ? "2026-01-01" : "2026-07-15",
      });
    }
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-10000.0000" },
      { account: h.org.accounts.bank, amount: "10000.0000" },
    ]);
    const settled = await settleIncentivePeriod({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      periodFrom: "2026-07-01", periodTo: "2026-07-31",
    });
    assert.equal(settled.awards.length, 1);
    assert.equal(settled.awards[0]!.employmentId, full.employmentId);
    assert.equal(settled.awards[0]!.value, "1000.0000");
    assert.ok(settled.preview.excluded.some((l) => l.includes(partial.employmentId)));
  });
});

test("concurrent settlers record one award set, never duplicates", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const program = await seedProgram(h);
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Race Crew" });
    await addProgramMembership({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      employmentId: worker.employmentId, effectiveFrom: "2026-01-01",
    });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-10000.0000" },
      { account: h.org.accounts.bank, amount: "10000.0000" },
    ]);
    const query = {
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      periodFrom: "2026-07-01", periodTo: "2026-07-31",
    };
    const [first, second] = await Promise.all([settleIncentivePeriod(query), settleIncentivePeriod(query)]);
    assert.equal(await awardCount(h.org.orgId), 1);
    assert.deepEqual(
      [first.awards[0]!.id, second.awards[0]!.id].sort(),
      [first.awards[0]!.id, first.awards[0]!.id].sort(),
    );
  });
});

test("signed adjustments have caller-stable identity and retain the original policy", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const program = await seedProgram(h);
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Adjust Crew" });
    await addProgramMembership({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      employmentId: worker.employmentId, effectiveFrom: "2026-01-01",
    });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-10000.0000" },
      { account: h.org.accounts.bank, amount: "10000.0000" },
    ]);
    const settled = await settleIncentivePeriod({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      periodFrom: "2026-07-01", periodTo: "2026-07-31",
    });
    const award = settled.awards[0]!;
    await submitBenefitAward({ orgId: h.org.orgId, actorId: h.settlerId, awardId: award.id });
    await approveBenefitAward({ orgId: h.org.orgId, actorId: h.approverId, awardId: award.id });
    const correctionId = randomUUID();
    const topUp = await createAdjustingAward({
      orgId: h.org.orgId, actorId: h.settlerId, awardId: award.id,
      correctionId, value: "50.0000", reason: "July revenue restated upward",
    });
    assert.equal(topUp.value, "50.0000");
    assert.equal(topUp.status, "draft");
    // The same top-up retried returns the same award.
    const replay = await createAdjustingAward({
      orgId: h.org.orgId, actorId: h.settlerId, awardId: award.id,
      correctionId, value: "50.0000", reason: "July revenue restated upward",
    });
    assert.equal(replay.id, topUp.id);
    await refuses(() => createAdjustingAward({
      orgId: h.org.orgId, actorId: h.settlerId, awardId: award.id,
      correctionId, value: "50.0000", reason: "different evidence",
    }), /different details/);
    const separate = await createAdjustingAward({
      orgId: h.org.orgId, actorId: h.settlerId, awardId: award.id,
      correctionId: randomUUID(), value: "50.0000", reason: "another independent restatement",
    });
    assert.notEqual(separate.id, topUp.id);
    await closeBenefitProgram({ orgId: h.org.orgId, actorId: h.settlerId, programId: program.id, reason: "Replace policy after restatement" });
    // Overpayments correct as signed recovery awards linked to the original.
    const recovery = await createAdjustingAward({
      orgId: h.org.orgId, actorId: h.settlerId, awardId: award.id,
      correctionId: randomUUID(), value: "-10.0000", reason: "June hours restated downward",
    });
    assert.equal(recovery.value, "-10.0000");
    assert.equal(recovery.adjustsAwardId, award.id);
    // Zero corrects nothing.
    await refuses(
      () => createAdjustingAward({
        orgId: h.org.orgId, actorId: h.settlerId, awardId: award.id,
        correctionId: randomUUID(), value: "0.0000", reason: "no change",
      }),
      /corrects nothing/,
    );
  });
});

async function seedRun(h: Harness, employmentId: string, workerPartyId: string, payDate = "2026-08-05") {
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
    values (${scheduleId}, ${h.org.orgId}, ${`Settle ${scheduleId.slice(0, 6)}`}, 'biweekly', 26, '2026-07-18')
  `);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id, country, province)
    values (${h.org.orgId}, ${workerPartyId}, ${employmentId}, ${scheduleId}, 'US', 'TX')
  `);
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, subsidiary_id, kind, document_number, document_date, currency, status, subtotal, tax_total, total)
    values (${documentId}, ${h.org.orgId}, ${h.org.subsidiaryId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
            '2026-07-18', 'USD', 'draft', 0, 0, 0)
  `);
  await db.execute(sql`
    insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status, run_type)
    values (${documentId}, ${h.org.orgId}, ${scheduleId}, '2026-07-05', '2026-07-18', ${payDate}::date, 2026, 'draft', 'regular')
  `);
  return documentId;
}

test("approved awards queue onto a draft run as one idempotent adjustment", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const program = await seedProgram(h);
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Queue Crew" });
    await addProgramMembership({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      employmentId: worker.employmentId, effectiveFrom: "2026-01-01",
    });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-10000.0000" },
      { account: h.org.accounts.bank, amount: "10000.0000" },
    ]);
    const settled = await settleIncentivePeriod({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      periodFrom: "2026-07-01", periodTo: "2026-07-31",
    });
    const award = settled.awards[0]!;
    await submitBenefitAward({ orgId: h.org.orgId, actorId: h.settlerId, awardId: award.id });
    await approveBenefitAward({ orgId: h.org.orgId, actorId: h.approverId, awardId: award.id });
    const runDocumentId = await seedRun(h, worker.employmentId, worker.workerPartyId);
    const queued = await queueAwardForPayRun({
      orgId: h.org.orgId, actorId: h.financeId, awardId: award.id, runDocumentId,
    });
    assert.equal(queued.award.status, "queued");
    const adjustment = (await db.execute<{ amount: string; component_id: string }>(sql`
      select amount::text as amount, component_id::text as component_id from pay_run_adjustments
       where org_id = ${h.org.orgId} and id = ${queued.adjustmentId}
    `)).rows[0]!;
    assert.equal(adjustment.amount, "1000.0000");
    // Same-run retry replays the stable linkage.
    const replay = await queueAwardForPayRun({
      orgId: h.org.orgId, actorId: h.financeId, awardId: award.id, runDocumentId,
    });
    assert.equal(replay.adjustmentId, queued.adjustmentId);
    // Delivery records only after the run commits, with the exact linkage.
    await refuses(
      () => confirmAwardPayrollDelivery({
        orgId: h.org.orgId, actorId: h.financeId, awardId: award.id,
        runDocumentId, adjustmentId: queued.adjustmentId,
      }),
      /only after the run is committed|pending run proves no payout|is draft/i,
    );
    await db.execute(sql`
      update pay_runs set run_status = 'committed' where org_id = ${h.org.orgId} and document_id = ${runDocumentId}
    `);
    await refuses(() => confirmAwardPayrollDelivery({
      orgId: h.org.orgId, actorId: h.financeId, awardId: award.id,
      runDocumentId, adjustmentId: queued.adjustmentId,
    }), /no matching paid stub line/);
    // A committed flag alone is never payment evidence; the end-to-end
    // test below supplies the positive proof through native calculate/commit.
    assert.equal((await db.execute<{status:string}>(sql`select status from hrm_benefit_awards where org_id=${h.org.orgId} and id=${award.id}`)).rows[0]!.status, "queued");
  });
});

test("a run paying before the payable date refuses the queue", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const program = await seedProgram(h, { paymentDelayDays: 30 });
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Delay Crew" });
    await addProgramMembership({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      employmentId: worker.employmentId, effectiveFrom: "2026-01-01",
    });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-10000.0000" },
      { account: h.org.accounts.bank, amount: "10000.0000" },
    ]);
    const settled = await settleIncentivePeriod({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      periodFrom: "2026-07-01", periodTo: "2026-07-31",
    });
    const award = settled.awards[0]!;
    await submitBenefitAward({ orgId: h.org.orgId, actorId: h.settlerId, awardId: award.id });
    await approveBenefitAward({ orgId: h.org.orgId, actorId: h.approverId, awardId: award.id });
    // Payable after 2026-08-30; this run pays 2026-08-05.
    const runDocumentId = await seedRun(h, worker.employmentId, worker.workerPartyId, "2026-08-05");
    await refuses(
      () => queueAwardForPayRun({
        orgId: h.org.orgId, actorId: h.financeId, awardId: award.id, runDocumentId,
      }),
      /payable after 2026-08-30/,
    );
  });
});

test("external awards never enter a pay run as cash", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    // A fixed gift-card program delivers externally: no metric, no
    // component, no settlement — its awards record through the manual door.
    const created = await createBenefitProgram({
      orgId: h.org.orgId,
      actorId: h.settlerId,
      code: `GIFTS_${randomUUID().slice(0, 6)}`,
      name: "Gift cards",
      family: "reward",
      currency: "USD",
      legalEntityId: h.org.subsidiaryId,
      effectiveFrom: "2026-01-01",
      deliveryMethod: "external",
      valuation: "fixed",
      fixedAmount: "25.0000",
      frequency: "manual",
    });
    const program = await activateBenefitProgram({ orgId: h.org.orgId, actorId: h.settlerId, programId: created.id });
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Gift Crew" });
    await addProgramMembership({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      employmentId: worker.employmentId, effectiveFrom: "2026-01-01",
    });
    const award = await createBenefitAward({
      orgId: h.org.orgId, actorId: h.settlerId, programId: created.id,
      employmentId: worker.employmentId, periodFrom: "2026-07-01", periodTo: "2026-07-31",
      value: "25.0000", currency: "USD",
      evidence: { kind: "gift-card", vendor: "Acme Gifts" },
      sourceKey: null,
    });
    await submitBenefitAward({ orgId: h.org.orgId, actorId: h.settlerId, awardId: award.id });
    await approveBenefitAward({ orgId: h.org.orgId, actorId: h.approverId, awardId: award.id });
    const runDocumentId = await seedRun(h, worker.employmentId, worker.workerPartyId);
    const message = await refuses(
      () => queueAwardForPayRun({
        orgId: h.org.orgId, actorId: h.financeId, awardId: award.id, runDocumentId,
      }),
      /no cash leg/,
    );
    assert.match(message, /no native payroll representation/);
    // No adjustment row was written for the refused queue.
    const adjustments = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pay_run_adjustments
       where org_id = ${h.org.orgId} and pay_run_document_id = ${runDocumentId}
    `)).rows[0]!.n;
    assert.equal(adjustments, 0);
  });
});

test("statements union awards and payroll records without duplicating payments", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const program = await seedProgram(h);
    const party = await linkPerson(h.org.orgId, h.employeeId, "Statement Worker");
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: party });
    await addProgramMembership({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      employmentId: worker.employmentId, effectiveFrom: "2026-01-01",
    });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-10000.0000" },
      { account: h.org.accounts.bank, amount: "10000.0000" },
    ]);
    const settled = await settleIncentivePeriod({
      orgId: h.org.orgId, actorId: h.settlerId, programId: program.id,
      periodFrom: "2026-07-01", periodTo: "2026-07-31",
    });
    // Draft awards read as pending (owed, not paid), never in paid totals —
    // through the grant-less self path, no HR grant involved.
    const mine = await myBenefitStatement({ orgId: h.org.orgId, actorId: h.employeeId });
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.pendingAwards.length, 1);
    assert.equal(mine[0]!.paidAwards.length, 0);
    assert.deepEqual(mine[0]!.paidTotals, []);
    const single = await employmentBenefitStatement({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId: worker.employmentId,
    });
    assert.equal(single.pendingAwards[0]!.id, settled.awards[0]!.id);
    // A manager with scope reads the same employment through the HR gate.
    const managed = await employmentBenefitStatement({
      orgId: h.org.orgId, actorId: h.settlerId, employmentId: worker.employmentId,
    });
    assert.equal(managed.pendingAwards[0]!.id, settled.awards[0]!.id);
    // Leakage proof: no company measure, snapshot, or digest key appears
    // anywhere in the employee-visible statement.
    const serialized = JSON.stringify(mine);
    for (const forbidden of [
      "measuredValue", "poolValue", "revenueTotal", "expenseTotal", "digest",
      "entryIds", "source_snapshot", "program_snapshot", "sourceSnapshot", "programSnapshot", "summaryLines", "bookId", "explanation", "share", "postingFacts", "approvedHoursFacts",
    ]) {
      assert.ok(!serialized.includes(forbidden), `statement leaks ${forbidden}`);
    }
    // A stranger's employment refuses for the grant-less employee — never
    // an empty statement, never another worker's rows.
    const outsiderParty = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${outsiderParty}, ${h.org.orgId}, 'person', 'Stranger', true, '{}'::jsonb)
    `);
    const stranger = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: outsiderParty });
    let refused = false;
    try {
      await employmentBenefitStatement({
        orgId: h.org.orgId, actorId: h.employeeId, employmentId: stranger.employmentId,
      });
    } catch {
      refused = true;
    }
    assert.equal(refused, true);
  });
});


test("cash reward delivery proves its exact line through native payroll calculation and commit", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"hrm":true}'::jsonb) where id = ${fx.orgId}`);
    const approverId = await createScratchUser(fx.orgId, "Benefits Approver", "admin");
    const component = (await db.execute<{id: string}>(sql`
      select id from pay_components where org_id = ${fx.orgId} and system_key = 'bonus' and country = 'CA'
    `)).rows[0]!;
    assert.ok(component, "the native payroll fixture has its Canadian bonus component");
    const created = await createBenefitProgram({
      orgId: fx.orgId, actorId: fx.actorId, code: "CASH_RECOGNITION", name: "Cash recognition",
      family: "reward", currency: "CAD", legalEntityId: fx.subsidiaryId,
      effectiveFrom: "2026-01-01", payComponentId: component.id, deliveryMethod: "payroll",
      valuation: "fixed", fixedAmount: "25.0000", frequency: "manual",
    });
    const program = await activateBenefitProgram({ orgId: fx.orgId, actorId: fx.actorId, programId: created.id });
    await addProgramMembership({ orgId: fx.orgId, actorId: fx.actorId, programId: program.id, employmentId: fx.employmentId, effectiveFrom: "2026-01-01" });
    const award = await createBenefitAward({ orgId: fx.orgId, actorId: fx.actorId, programId: program.id, employmentId: fx.employmentId, periodFrom: "2026-07-05", periodTo: "2026-07-18", value: "25.0000", currency: "CAD", evidence: {kind: "recognition"} });
    await submitBenefitAward({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id });
    await approveBenefitAward({ orgId: fx.orgId, actorId: approverId, awardId: award.id });
    const { input } = await calculatedRun(fx);
    const queued = await queueAwardForPayRun({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, runDocumentId: input.documentId });
    assert.equal(queued.award.payRunDocumentId, input.documentId);
    assert.equal(queued.award.payRunAdjustmentId, queued.adjustmentId);
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    assert.ok((await commitPayRun(input)).lines > 0, "native payroll committed balanced accounting legs");
    const delivered = await confirmAwardPayrollDelivery({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, runDocumentId: input.documentId, adjustmentId: queued.adjustmentId });
    assert.equal(delivered.status, "delivered");
    const replay = await queueAwardForPayRun({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, runDocumentId: input.documentId });
    assert.equal(replay.award.status, "delivered");
    const lines = (await db.execute<{amount: string}>(sql`
      select l.amount::text as amount from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
       where s.org_id=${fx.orgId} and s.pay_run_document_id=${input.documentId} and l.description=${`Benefit award ${award.id} (${program.code} 2026-07-05..2026-07-18)`}
    `)).rows;
    assert.deepEqual(lines, [{amount: "25.0000"}]);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});


test("a linked employment does not replace the self-service read grant", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SETTLE_SPEC), async (h) => {
    const party = await linkPerson(h.org.orgId, h.noSelfId, "Linked without self-service");
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {workerPartyId: party});
    await assert.rejects(myBenefitStatement({orgId: h.org.orgId, actorId: h.noSelfId}), /hrm.self.read|Self-service|permission|authorized/i);
    await assert.rejects(employmentBenefitStatement({orgId: h.org.orgId, actorId: h.noSelfId, employmentId: worker.employmentId}), /hrm.self.read|Self-service|permission|authorized/i);
  });
});
