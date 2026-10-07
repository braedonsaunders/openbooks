import { seedPayrollBenefitProgram, approveBenefitFixture as approveThroughWorkflow, seedCommittedBenefitRunWithoutStubs } from "../../testing/benefit-fixtures.ts";
import { refusal } from "../../testing/refusal.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { neg, toUnits } from "../../money/money.ts";
import { db } from "../../platform/db.ts";
import { seedBenefitIncentivePosting as postEntry } from "../../testing/benefit-incentive-posting.ts";
import {
  linkPerson,
  seedComponent,
  seedEmployment,
  setupHarness as setupBaseHarness,
  setFeatures,
  withHarness,
} from "../../testing/hrm-harness.ts";
import { getBenefitTransactionPolicy, saveBenefitTransactionPolicy, type BenefitTransactionPolicy } from "./transaction-policy.ts";
import { exportedPayrollEvidence } from "../../testing/dsar-fixture.ts";
import { errorChainMatches } from "../../testing/error-chain.ts";
import { seedApprovalFlow } from "../../testing/fixtures.ts";
import { installEngineSeams } from "../../composition/install.ts";
import { BenefitsError } from "./errors.ts";
import {
  activateBenefitProgram,
  addProgramMembership,
  createBenefitProgram,
  getBenefitProgram,
  closeBenefitProgram,
  updateBenefitProgram,
} from "./programs.ts";
import {
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
    { key: "settlerId", name: "Settle Operator", handle: "settle_operator", permissions: ["hrm.benefits.read", "hrm.benefits.manage", "gl.read", "ar.read"], link: true },
    { key: "approverId", name: "Settle Approver", handle: "settle_approver", permissions: ["hrm.benefits.read", "hrm.benefits.manage", "gl.read"], link: true },
    { key: "financeId", name: "Settle Finance", handle: "settle_finance", permissions: ["hrm.benefits.read", "payroll.manage", "gl.read"], link: true },
    // Plain employee: self-service grants only, deliberately no HR grant.
    { key: "noSelfId", name: "No Self Grant", handle: "settle_no_self", permissions: [], link: true },
    { key: "employeeId", name: "Settle Employee", handle: "settle_employee", permissions: ["hrm.self.read"], link: true },
  ],
} as const;

type Harness = Awaited<ReturnType<typeof setupBaseHarness<typeof SETTLE_SPEC>>>;

async function setupHarness(spec: typeof SETTLE_SPEC): Promise<Harness> {
  installEngineSeams();
  const h = await setupBaseHarness(spec);
  // These settlements and their posted source facts are denominated in USD.
  // Declare that employer currency before native program authoring checks it.
  await db.execute(sql`update subsidiaries set base_currency='USD'
    where org_id=${h.org.orgId} and id=${h.org.subsidiaryId}`);
  await seedApprovalFlow(h.org.orgId, { subjectKind: "hrm_benefit_award",
    assignees: [{ type: "user", userId: h.approverId }], mode: "any", preventSelfApproval: true });
  return h;
}

async function seedProgram(h: Harness, overrides: Record<string, unknown> = {}, activate = true) {
  const component = await seedComponent(h.org.orgId, { kind: "earning", code: `INC_${randomUUID().slice(0, 6)}` });
  return seedPayrollBenefitProgram({ orgId: h.org.orgId, actorId: h.settlerId,
    subsidiaryId: h.org.subsidiaryId, componentId: component, currency: "USD" }, {
    code: `QPS_${randomUUID().slice(0, 6)}`, name: "Quarterly profit share", family: "incentive",
    approvalMode: "flows", valuation: "percent", metric: "net_profit", metricScope: "company",
    allocation: "equal", percentRate: "10", frequency: "manual", periodBasis: "calendar",
    sourceAccountIds: [h.org.accounts.revenue, h.org.accounts.cogs], ...overrides,
  } as Parameters<typeof seedPayrollBenefitProgram>[1], { activate });
}

function settlementTest(name: string, body: (h: Harness) => Promise<void>) {
  test(name, { skip: !DB }, () => withHarness(() => setupHarness(SETTLE_SPEC), body));
}

function settlementQuery(h: Harness, programId: string) {
  return {
    orgId: h.org.orgId, actorId: h.settlerId, programId,
    periodFrom: "2026-07-01", periodTo: "2026-07-31",
  };
}

async function seedMember(h: Harness, programId: string, worker: Parameters<typeof seedEmployment>[2], effectiveFrom = "2026-01-01") {
  const member = await seedEmployment(h.org.orgId, h.org.subsidiaryId, worker);
  await addProgramMembership({
    orgId: h.org.orgId, actorId: h.settlerId, programId,
    employmentId: member.employmentId, effectiveFrom,
  });
  return member;
}

async function postRevenue(h: Harness, amount = "10000.0000") {
  await postEntry(h, [
    { account: h.org.accounts.revenue, amount: neg(amount) },
    { account: h.org.accounts.bank, amount },
  ]);
}

async function seedSettlement(h: Harness, displayName: string, overrides: Record<string, unknown> = {}) {
  const program = await seedProgram(h, overrides);
  const worker = await seedMember(h, program.id, { displayName });
  await postRevenue(h);
  return { program, worker, query: settlementQuery(h, program.id) };
}

async function approveSettlementAward(h: Harness, awardId: string) {
  await submitBenefitAward({ orgId: h.org.orgId, actorId: h.settlerId, awardId });
  return approveThroughWorkflow({ orgId: h.org.orgId, actorId: h.approverId, awardId });
}

async function awardCount(orgId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_benefit_awards where org_id = ${orgId}
  `)).rows[0]!.n;
}

const refuses = async (fn: () => unknown, pattern: RegExp) =>
  (await refusal(Promise.resolve().then(fn), BenefitsError, pattern)).message;

settlementTest("settle records one draft award per payable recipient from posted profit", async (h) => {
  const { program, worker, query } = await seedSettlement(h, "Profit Crew");
  await postEntry(h, [
    { account: h.org.accounts.cogs, amount: "4000.0000" },
    { account: h.org.accounts.bank, amount: "-4000.0000" },
  ]);
  const settled = await settleIncentivePeriod(query);
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

settlementTest("a retried settlement returns the same awards instead of recording twice", async (h) => {
  const { query } = await seedSettlement(h, "Retry Crew");

  const first = await settleIncentivePeriod(query);
  const second = await settleIncentivePeriod(query);
  assert.deepEqual(
    second.awards.map((a) => a.id).sort(),
    first.awards.map((a) => a.id).sort(),
  );
  assert.equal(await awardCount(h.org.orgId), first.awards.length);
});

settlementTest("moved sources refuse the overlap and direct corrections to adjusting awards", async (h) => {
  const { query } = await seedSettlement(h, "Overlap Crew");

  await settleIncentivePeriod(query);
  // A late posting moves the base: the same settlement must not rewrite.
  await postRevenue(h, "2000.0000");
  await refuses(() => settleIncentivePeriod(query), /never rewritten.*adjusting awards/);
  assert.equal(await awardCount(h.org.orgId), 1);
});

settlementTest("nothing owed records nothing: a threshold miss refuses with no rows", async (h) => {
  const { query } = await seedSettlement(h, "Threshold Crew", { thresholdAmount: "999999.0000" });
  await refuses(
    () => settleIncentivePeriod(query),
    /owes nothing/,
  );
  assert.equal(await awardCount(h.org.orgId), 0);
});

settlementTest("open periods settle never; previews label them estimates", async (h) => {
  const program = await seedProgram(h);
  await seedMember(h, program.id, { displayName: "Future Crew" });
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

settlementTest("mid-period members take no share without a proration policy", async (h) => {
  const program = await seedProgram(h);
  const full = await seedMember(h, program.id, { displayName: "Full Crew" });
  const partial = await seedMember(h, program.id, { displayName: "Partial Crew" }, "2026-07-15");
  await postRevenue(h);
  const settled = await settleIncentivePeriod(settlementQuery(h, program.id));
  assert.equal(settled.awards.length, 1);
  assert.equal(settled.awards[0]!.employmentId, full.employmentId);
  assert.equal(settled.awards[0]!.value, "1000.0000");
  assert.ok(settled.preview.excluded.some((l) => l.includes(partial.employmentId)));
});

settlementTest("concurrent settlers record one award set, never duplicates", async (h) => {
  const { query } = await seedSettlement(h, "Race Crew");

  const [first, second] = await Promise.all([settleIncentivePeriod(query), settleIncentivePeriod(query)]);
  assert.equal(await awardCount(h.org.orgId), 1);
  assert.deepEqual(
    [first.awards[0]!.id, second.awards[0]!.id].sort(),
    [first.awards[0]!.id, first.awards[0]!.id].sort(),
  );
});

settlementTest("signed adjustments have caller-stable identity and retain the original policy", async (h) => {
  const { program, query } = await seedSettlement(h, "Adjust Crew");
  const settled = await settleIncentivePeriod(query);
  const award = settled.awards[0]!;
  await approveSettlementAward(h, award.id);
  const correction = {
    orgId: h.org.orgId, actorId: h.settlerId, awardId: award.id,
    correctionId: randomUUID(), value: "50.0000", reason: "July revenue restated upward",
  };
  const topUp = await createAdjustingAward(correction);
  assert.equal(topUp.value, "50.0000");
  assert.equal(topUp.status, "draft");
  // The same top-up retried returns the same award.
  const replay = await createAdjustingAward(correction);
  assert.equal(replay.id, topUp.id);
  await refuses(() => createAdjustingAward({
    ...correction, reason: "different evidence",
  }), /different details/);
  const separate = await createAdjustingAward({
    ...correction, correctionId: randomUUID(), reason: "another independent restatement",
  });
  assert.notEqual(separate.id, topUp.id);
  await closeBenefitProgram({ orgId: h.org.orgId, actorId: h.settlerId, programId: program.id, reason: "Replace policy after restatement" });
  // Overpayments correct as signed recovery awards linked to the original.
  const recovery = await createAdjustingAward({
    ...correction, correctionId: randomUUID(), value: "-10.0000", reason: "June hours restated downward",
  });
  assert.equal(recovery.value, "-10.0000");
  assert.equal(recovery.adjustsAwardId, award.id);
  // Zero corrects nothing.
  await refuses(
    () => createAdjustingAward({
      ...correction, correctionId: randomUUID(), value: "0.0000", reason: "no change",
    }),
    /corrects nothing/,
  );
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

settlementTest("hourly incentives retain dated approved time through settlement, approval and delayed payroll queue", async (h) => {
  const policy = { valuation: "per_unit", metric: "approved_hours", allocation: "hours", percentRate: null,
    fixedAmount: "0.3333", sourceAccountIds: [], paymentDelayDays: 30 };
  await refuses(() => seedProgram(h, { ...policy, allocation: "equal" }, false), /hours allocation/);
  assert.equal(await awardCount(h.org.orgId), 0);
  const program = await seedProgram(h, policy);
  const worker = await seedMember(h, program.id, { displayName: "Hourly incentive member" }, "2026-07-10");
  const entries: string[] = [];
  for (const [date, hours, status] of [
    ["2026-07-09", "2", "approved"], ["2026-07-15", "0.5", "approved"],
    ["2026-07-15", "0.5", "approved"], ["2026-07-15", "100", "draft"],
  ] as const) {
    const id = randomUUID(); entries.push(id);
    await db.execute(sql`insert into time_entries (id,org_id,employee_party_id,worked_on,hours,status,approved_at)
      values (${id},${h.org.orgId},${worker.workerPartyId},${date}::date,${hours},${status},${status === "approved" ? new Date() : null})`);
  }
  const query = settlementQuery(h, program.id);
  const preview = await previewIncentiveSettlement(query);
  assert.equal(preview.computation.measuredValue, "3.0000");
  assert.equal(preview.computation.totalAwarded, "0.3300", "sum member hours before rounding; rounding the two lines would incorrectly pay 0.34");
  assert.deepEqual((preview.sourceSnapshot.entryIds as string[]).slice().sort(), entries.slice(0, 3).sort());
  assert.equal(await awardCount(h.org.orgId), 0, "preview creates no obligation");
  await refuses(() => settleIncentivePeriod(query), /no program .* membership covers this employment/);
  assert.equal(await awardCount(h.org.orgId), 0, "an uncovered award span records no obligation");
  // Preview retains the whole month's source and dated member attribution;
  // the payable award itself covers only the member's enrolled span.
  const coveredQuery = { ...query, periodFrom: "2026-07-10" };
  const settled = await settleIncentivePeriod(coveredQuery);
  const award = settled.awards[0]!;
  assert.equal(award.value, "0.3300");
  assert.deepEqual((await settleIncentivePeriod(coveredQuery)).awards.map(a => a.id), [award.id]);
  assert.equal(await awardCount(h.org.orgId), 1);
  const source = (await db.execute<{ source_snapshot: Record<string, Record<string, Record<string, unknown>>> }>(sql`
    select source_snapshot from hrm_benefit_awards where org_id=${h.org.orgId} and id=${award.id}`)).rows[0]!.source_snapshot.measurement!.settlement!;
  assert.deepEqual(source.hoursAttribution, [{ employmentId: worker.employmentId, hours: "1.0000" }]);
  assert.deepEqual((source.entryIds as string[]).sort(), entries.slice(1, 3).sort());
  assert.equal(source.measuredValue, "1.0000");
  await refuses(() => updateBenefitProgram({ orgId:h.org.orgId,actorId:h.settlerId,programId:program.id,
    fixedAmount:"4",reason:"Change hourly price" }), /active.*immutable|close.*replacement/i);
  assert.equal((await getBenefitProgram(db, h.org.orgId, h.settlerId, program.id)).fixedAmount, "0.3333");
  const runDocumentId = await seedRun(h, worker.employmentId, worker.workerPartyId);
  const delivery = { orgId:h.org.orgId, actorId:h.financeId, awardId:award.id, runDocumentId };
  await refuses(() => queueAwardForPayRun(delivery), /approved|approval/i);
  await approveSettlementAward(h, award.id);
  await refuses(() => queueAwardForPayRun(delivery), /payable after 2026-08-30/);
  await db.execute(sql`update pay_runs set pay_date='2026-08-31' where org_id=${h.org.orgId} and document_id=${runDocumentId}`);
  const queued = await queueAwardForPayRun(delivery);
  assert.equal((await queueAwardForPayRun(delivery)).adjustmentId, queued.adjustmentId);
  const inputs = (await db.execute<{ amount:string; hours:string|null }>(sql`
    select amount::text,hours::text from pay_run_adjustments where org_id=${h.org.orgId} and id=${queued.adjustmentId}`)).rows;
  assert.equal(inputs.length, 1); assert.equal(inputs[0]!.amount, "0.3300");
  assert.ok(inputs[0]!.hours === null || toUnits(inputs[0]!.hours) === 0n, "an incentive payout never creates more worked hours");
});

settlementTest("approved awards queue onto a draft run as one idempotent adjustment", async (h) => {
  const { worker, query } = await seedSettlement(h, "Queue Crew");
  const settled = await settleIncentivePeriod(query);
  const award = settled.awards[0]!;
  await approveSettlementAward(h, award.id);
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
  await seedCommittedBenefitRunWithoutStubs(h.org.orgId, runDocumentId);
  await refuses(() => confirmAwardPayrollDelivery({
    orgId: h.org.orgId, actorId: h.financeId, awardId: award.id,
    runDocumentId, adjustmentId: queued.adjustmentId,
  }), /no matching payroll representation.*review the employee.s inclusion and calculation.*does not prove this benefit was processed/);
  // A committed flag alone is never payment evidence; the end-to-end
  // test below supplies the positive proof through native calculate/commit.
  assert.equal((await db.execute<{status:string}>(sql`select status from hrm_benefit_awards where org_id=${h.org.orgId} and id=${award.id}`)).rows[0]!.status, "queued");
});

settlementTest("a run paying before the payable date refuses the queue", async (h) => {
  const { worker, query } = await seedSettlement(h, "Delay Crew", { paymentDelayDays: 30 });
  const settled = await settleIncentivePeriod(query);
  const award = settled.awards[0]!;
  await approveSettlementAward(h, award.id);
  // Payable after 2026-08-30; this run pays 2026-08-05.
  const runDocumentId = await seedRun(h, worker.employmentId, worker.workerPartyId, "2026-08-05");
  await refuses(
    () => queueAwardForPayRun({
      orgId: h.org.orgId, actorId: h.financeId, awardId: award.id, runDocumentId,
    }),
    /payable after 2026-08-30/,
  );
});

settlementTest("provider programs refuse missing or cash payroll representations before any award exists", async (h) => {
  const component = await seedComponent(h.org.orgId, { kind: "earning", code: `CASH_${randomUUID().slice(0, 6)}` });
  const program = {
    orgId: h.org.orgId, actorId: h.settlerId, code: `GIFTS_${randomUUID().slice(0, 6)}`,
    name: "Gift cards", family: "reward" as const, currency: "USD", legalEntityId: h.org.subsidiaryId,
    effectiveFrom: "2026-01-01", deliveryMethod: "external" as const,
    valuation: "fixed" as const, fixedAmount: "25.0000", frequency: "manual" as const,
  };
  await refuses(() => createBenefitProgram(program), /link a non-cash earning component/);
  await refuses(() => createBenefitProgram({ ...program, payComponentId: component }), /requires a non-cash earning component/);
  assert.equal(await awardCount(h.org.orgId), 0);
  assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from hrm_benefit_programs where org_id = ${h.org.orgId}`)).rows[0]!.n, 0);
});

settlementTest("statements union awards and payroll records without duplicating payments", async (h) => {
  const program = await seedProgram(h);
  const party = await linkPerson(h.org.orgId, h.employeeId, "Statement Worker");
  const worker = await seedMember(h, program.id, { workerPartyId: party });
  await postRevenue(h);
  const settled = await settleIncentivePeriod(settlementQuery(h, program.id));
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
  const pendingRun = await seedRun(h, worker.employmentId, worker.workerPartyId);
  await db.execute(sql`
    insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, employment_id, province, periods_per_year, pay_date, tax_year, country, country_source, currency_code, gross, net_pay)
    values (${h.org.orgId}, ${pendingRun}, ${worker.workerPartyId}, ${worker.employmentId}, 'TX', 26, '2026-08-05', 2026, 'US', 'calculation', 'USD', '1000.0000', '1000.0000')
  `);
  const beforeCommit = await myBenefitStatement({orgId: h.org.orgId, actorId: h.employeeId});
  assert.deepEqual(beforeCommit[0]!.payrollRecords, [], "an uncommitted stub is an estimate, not paid payroll");
  // Leakage proof: no company measure, snapshot, or digest key appears
  // anywhere in the employee-visible statement.
  const forbiddenKeys = new Set([
    "measuredValue", "poolValue", "revenueTotal", "expenseTotal", "digest",
    "entryIds", "source_snapshot", "program_snapshot", "sourceSnapshot", "programSnapshot",
    "summaryLines", "bookId", "explanation", "share", "postingFacts", "approvedHoursFacts",
    "flowRunId", "decisionSnapshot", "submissionPolicy", "submittedBy", "submittedAt", "approvalHref",
  ]);
  const assertPrivate = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(assertPrivate); return; }
    if (value === null || typeof value !== "object") return;
    for (const [key, field] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `statement leaks confidential field ${key}`);
      assertPrivate(field);
    }
  };
  assertPrivate(mine);
  // A stranger's employment refuses for the grant-less employee — never
  // an empty statement, never another worker's rows.
  const outsiderParty = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${outsiderParty}, ${h.org.orgId}, 'person', 'Stranger', true, '{}'::jsonb)
  `);
  const stranger = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: outsiderParty });
  await assert.rejects(employmentBenefitStatement({
    orgId: h.org.orgId, actorId: h.employeeId, employmentId: stranger.employmentId,
  }));
});


settlementTest("a linked employment does not replace the self-service read grant", async (h) => {
  const party = await linkPerson(h.org.orgId, h.noSelfId, "Linked without self-service");
  const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {workerPartyId: party});
  await assert.rejects(myBenefitStatement({orgId: h.org.orgId, actorId: h.noSelfId}), /hrm.self.read|Self-service|permission|authorized/i);
  await assert.rejects(employmentBenefitStatement({orgId: h.org.orgId, actorId: h.noSelfId, employmentId: worker.employmentId}), /hrm.self.read|Self-service|permission|authorized/i);
});


settlementTest("project-completion awards require native closed projects and freeze completion facts", async (h) => {
  await setFeatures(h.org.orgId, {hrm: true, projects: true});
  const projectId = randomUUID();
  await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, status, is_active) values (${projectId}, ${h.org.orgId}, ${h.org.subsidiaryId}, 'COMPLETE-JOB', 'Completion project', 'active', true)`);
  const program = await seedProgram(h, {metric: "revenue", metricScope: "project", scopeIds: [projectId], sourceAccountIds: [h.org.accounts.revenue], frequency: "project_complete"});
  await seedMember(h, program.id, { displayName: "Project crew" });
  await postEntry(h, [{account: h.org.accounts.revenue, amount: "-10000.0000", project: projectId}, {account: h.org.accounts.bank, amount: "10000.0000"}]);
  const query = {orgId: h.org.orgId, actorId: h.settlerId, programId: program.id, periodFrom: "2026-07-01", periodTo: "2026-07-31"};
  assert.equal((await previewIncentiveSettlement(query)).isEstimate, true);
  await refuses(() => settleIncentivePeriod(query), /not closed.*close each selected project/);
  for (const status of ["substantially_complete", "cancelled"]) {
    await db.execute(sql`update projects set status=${status}, updated_at=now() where org_id=${h.org.orgId} and id=${projectId}`);
    await refuses(() => settleIncentivePeriod(query), /not closed/);
  }
  // This is the native project record's Closed status, not a parallel
  // benefit flag or a fabricated completion percentage.
  await db.execute(sql`update projects set status='closed', updated_at=now() where org_id=${h.org.orgId} and id=${projectId}`);
  const settled = await settleIncentivePeriod(query);
  assert.equal(settled.preview.isEstimate, false);
  const completion = settled.preview.sourceSnapshot.projectCompletion as Array<{projectId: string; status: string}>;
  assert.equal(completion[0]!.projectId, projectId);
  assert.equal(completion[0]!.status, "closed");
  assert.equal((await settleIncentivePeriod(query)).awards[0]!.id, settled.awards[0]!.id);
  await postEntry(h, [{account: h.org.accounts.revenue, amount: "-100.0000", project: projectId}, {account: h.org.accounts.bank, amount: "100.0000"}], { date: "2026-08-15" });
  await refuses(() => settleIncentivePeriod({...query, periodFrom: "2026-08-01", periodTo: "2026-08-31"}), /completion was already settled/);
});


settlementTest("transaction policies govern dated shares, group ceilings, approval, delayed payroll and private recipient exports", async h => {
  await setFeatures(h.org.orgId, { orders: true });
  const program = await seedProgram(h, { metric: "transactions", allocation: "responsibility", sourceAccountIds: [], paymentDelayDays: 30 }, false);
  const lead = await seedMember(h, program.id, { displayName: "Assigned Lead" });
  const support = await seedMember(h, program.id, { displayName: "Assigned Support" });
  const policy: BenefitTransactionPolicy = {
    documentKind: "sales_order", dateBasis: "document_date", groupingSegmentId: null, itemIds: [h.org.items.service],
    positions: [{ key: "lead", name: "Lead", weight: "2" }, { key: "support", name: "Support", weight: "1" }],
    responsibilities: [["lead", lead.employmentId], ["support", support.employmentId]].map(([positionKey, employmentId]) => ({ groupId: h.org.subsidiaryId, positionKey: positionKey!, employmentId: employmentId!, effectiveFrom: "2026-01-01", effectiveTo: null })),
    limits: [{ groupId: h.org.subsidiaryId, kind: "amount", amount: "60" }],
  };
  const revision = (await getBenefitProgram(db, h.org.orgId, h.settlerId, program.id)).revision;
  const command = { orgId: h.org.orgId, actorId: h.settlerId, programId: program.id, expectedRevision: revision, policy, reason: "Record dated source and recipient policy" };
  await refuses(() => saveBenefitTransactionPolicy({ ...command, policy: { ...policy, limits: [{ ...policy.limits[0]!, amount: "1,234" }] } }), /ambiguous/);
  assert.equal(await getBenefitTransactionPolicy(command), null, "a refused policy has no partial configuration");
  await refuses(() => saveBenefitTransactionPolicy({ ...command, policy: {
    ...policy, responsibilities: [...policy.responsibilities, policy.responsibilities[0]!],
  } }), /overlapping assignments/);
  const saved = await saveBenefitTransactionPolicy(command);
  assert.ok(saved.programRevision > revision);
  assert.equal(saved.policy.limits[0]!.amount, "60.0000");
  await refuses(() => saveBenefitTransactionPolicy(command), /changed.*reload/);
  assert.ok((await db.execute(sql`select id from audit_log where org_id=${h.org.orgId} and table_name='hrm_benefit_transaction_responsibilities' and actor_id=${h.settlerId} and changes->>'reason'=${command.reason}`)).rows.length >= 2);
  const seedSource = async (date: string) => {
    const id = randomUUID(), line = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,subsidiary_id,kind,document_number,document_date,currency) values(${id},${h.org.orgId},${h.org.subsidiaryId},'sales_order',${id},${date}::date,'USD')`);
    await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,quantity,unit_price,amount) values(${line},${h.org.orgId},${id},1,${h.org.items.service},'4','250','1000')`);
    await db.execute(sql`update documents set status='approved' where org_id=${h.org.orgId} and id=${id}`);
    return { id, line };
  };
  const source = await seedSource("2026-07-09");
  await activateBenefitProgram(command);
  await refuses(async () => saveBenefitTransactionPolicy({ ...command, expectedRevision: (await getBenefitProgram(db,h.org.orgId,h.settlerId,program.id)).revision }), /Only draft.*replacement/);
  await assert.rejects(() => db.execute(sql`update hrm_benefit_transaction_positions set weight=3 where org_id=${h.org.orgId} and program_id=${program.id}`), error => errorChainMatches(error,/immutable.*replacement/));
  const query = settlementQuery(h, program.id), preview = await previewIncentiveSettlement(query);
  assert.equal(preview.computation.measuredValue, "1000.0000");
  assert.equal(preview.computation.totalAwarded, "60.0000");
  assert.equal(preview.computation.recipients.find(r => r.employmentId === lead.employmentId)!.value, "40.0000");
  assert.equal(preview.computation.recipients.find(r => r.employmentId === support.employmentId)!.value, "20.0000");
  assert.equal(preview.payableAfter, "2026-08-30");
  const settled = await settleIncentivePeriod(query);
  assert.deepEqual((await settleIncentivePeriod(query)).awards.map(r => r.id), settled.awards.map(r => r.id));
  const award = settled.awards.find(r => r.employmentId === lead.employmentId)!;
  const stored = (await db.execute<{source_snapshot: {measurement:{settlement:{entryIds:string[];entryCount:number;lineCount:number;transaction:{source:{lines:{sourceId:string}[]}}}}}}>(sql`select source_snapshot from hrm_benefit_awards where org_id=${h.org.orgId} and id=${award.id}`)).rows[0]!.source_snapshot.measurement.settlement;
  assert.deepEqual(stored.entryIds, [source.id]);
  assert.equal(stored.entryCount, 1); assert.equal(stored.lineCount, 1);
  assert.equal(stored.transaction.source.lines[0]!.sourceId, source.line);
  await approveSettlementAward(h, award.id);
  const early = await seedRun(h, lead.employmentId, lead.workerPartyId);
  await refuses(() => queueAwardForPayRun({orgId:h.org.orgId,actorId:h.financeId,awardId:award.id,runDocumentId:early}), /payable after 2026-08-30/);
  await db.execute(sql`update pay_runs set pay_date='2026-08-31' where org_id=${h.org.orgId} and document_id=${early}`);
  const delivery = {orgId:h.org.orgId,actorId:h.financeId,awardId:award.id,runDocumentId:early};
  const queued = await queueAwardForPayRun(delivery);
  assert.equal((await queueAwardForPayRun(delivery)).adjustmentId, queued.adjustmentId);
  assert.equal((await db.execute<{amount:string}>(sql`select amount::text from pay_run_adjustments where org_id=${h.org.orgId} and id=${queued.adjustmentId}`)).rows[0]!.amount, "40.0000");
  await seedSource("2026-08-09");
  const later = {...query,periodFrom:"2026-08-01",periodTo:"2026-08-31"};
  assert.equal((await previewIncentiveSettlement(later)).computation.totalAwarded,"0.0000","pending and queued obligations both consume the configured group ceiling");
  await refuses(()=>settleIncentivePeriod(later),/owes nothing/);
  assert.equal(await awardCount(h.org.orgId),2);
  const exported = await exportedPayrollEvidence({orgId:h.org.orgId,actorId:h.settlerId,partyId:lead.workerPartyId}) as unknown as {benefitTransactionResponsibilities:Record<string,unknown>[]};
  assert.equal(exported.benefitTransactionResponsibilities.length,1);
  const own = exported.benefitTransactionResponsibilities[0]!;
  assert.equal(own.employment_id,lead.employmentId); assert.equal(own.position_name,"Lead");
  assert.ok(!JSON.stringify(exported.benefitTransactionResponsibilities).includes(support.employmentId));
  for (const key of ["group_id","reason","created_by","updated_by","source_snapshot","limits"]) assert.equal(own[key],undefined,"the subject export excludes company policy and operator data");
});
