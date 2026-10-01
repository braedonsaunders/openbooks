import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, withBypassContext } from "../platform/db.ts";
import { add, neg, sum } from "../money/money.ts";
import { grantPermissions } from "../testing/hrm-harness.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import { calculatedRun, seedAdoption } from "../payroll/filing-test-fixtures.ts";
import { calculatePayRun } from "../payroll/run-calculation.ts";
import { commitPayRun } from "../payroll/run-commit.ts";
import { calculateT4127 } from "../payroll/canada/t4127.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { createBenefitProgram, activateBenefitProgram, addProgramMembership, updateBenefitProgram } from "../hrm/benefits/programs.ts";
import { createBenefitAward, getBenefitAward, recordExternalDelivery, submitBenefitAward, voidBenefitAward } from "../hrm/benefits/awards.ts";
import { queueAwardForPayRun } from "../hrm/benefits/settlement.ts";
import { installEngineSeams } from "./install.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function databaseRefusal(pattern: RegExp): (error: unknown) => true {
  return error => {
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current !== null && typeof current === "object" && !seen.has(current)) {
      seen.add(current);
      const detail = current as { code?: unknown; message?: unknown; cause?: unknown };
      if (detail.code === "23514") {
        assert.equal(typeof detail.message, "string");
        assert.match(detail.message as string, pattern);
        return true;
      }
      current = detail.cause;
    }
    assert.fail(`expected a native check-constraint refusal, received ${String(error)}`);
  };
}

async function fixture(value = "100.0000", clearingType = "asset_current_other") {
  const fx = await seedAdoption();
  try {
    installEngineSeams();
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"hrm":true}'::jsonb) where id = ${fx.orgId}`);
    await db.execute(sql`insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, recorded_at)
      values (${fx.orgId}, ${fx.employmentId}, 1, 'active', '2026-01-01', now())`);
    await grantPermissions(fx.orgId, fx.actorId, ["hrm.benefits.read", "hrm.benefits.manage", "gl.read"]);
    const clearing = (await db.execute<{ id: string }>(sql`insert into accounts (org_id, number, name, type, is_active, is_summary)
      values (${fx.orgId}, '1450', 'Provider benefit clearing', ${clearingType}, true, false) returning id`)).rows[0]!.id;
    const component = (await db.execute<{ id: string }>(sql`insert into pay_components
      (org_id, code, name, kind, country, basis, taxable, pensionable, insurable, vacationable, payment_kind, non_cash_account_id)
      values (${fx.orgId}, 'GIFT_VALUE', 'Gift-card value', 'earning', 'CA', 'fixed_amount', true, true, false, false, 'non_cash', ${clearing}) returning id`)).rows[0]!.id;
    const draft = await createBenefitProgram({ orgId: fx.orgId, actorId: fx.actorId, code: "PROVIDER_GIFTS", name: "Provider gifts", family: "reward",
      currency: "CAD", legalEntityId: fx.subsidiaryId, effectiveFrom: "2026-01-01", payComponentId: component,
      deliveryMethod: "external", valuation: "fixed", fixedAmount: value, frequency: "manual" });
    const program = await activateBenefitProgram({ orgId: fx.orgId, actorId: fx.actorId, programId: draft.id });
    await addProgramMembership({ orgId: fx.orgId, actorId: fx.actorId, programId: program.id, employmentId: fx.employmentId, effectiveFrom: "2026-01-01" });
    const award = await createBenefitAward({ orgId: fx.orgId, actorId: fx.actorId, programId: program.id, employmentId: fx.employmentId,
      periodFrom: "2026-07-05", periodTo: "2026-07-18", value, currency: "CAD", evidence: { kind: "provider-gift-card" } });
    const ready = await submitBenefitAward({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id });
    assert.equal(ready.status, "approved");
    assert.equal(program.approvalMode, "none", "no approvals is the program default");
    assert.equal(ready.approvedBy, null, "a program with no approvals does not invent a human approver");
    assert.equal((await db.execute(sql`select id from flows where org_id = ${fx.orgId} and subject_kind = 'hrm_benefit_award'`)).rows.length, 0, "native payroll processing needs no Flow graph when program approvals are disabled");
    const { input, entryId } = await calculatedRun(fx);
    return { fx, input, entryId, clearing, component, program, award };
  } catch (error) { await dropScratchOrgReporting(fx.orgId); throw error; }
}

async function post(input: { orgId: string; actorId: string; documentId: string }) {
  const accounts = (await db.execute<{ id: string; type: string }>(sql`select id, type from accounts where org_id = ${input.orgId}`)).rows;
  const account = (type: string) => { const row = accounts.find(a => a.type === type); assert.ok(row, type); return row.id; };
  await db.execute(sql`update documents set status = 'approved' where org_id = ${input.orgId} and id = ${input.documentId}`);
  return postDocument(input.documentId, { control: { ar: account("asset_receivable"), ap: account("liability_payable"), bank: account("asset_bank") } });
}

test("gift-card valuation feeds configured tax bases without adding cash; provider fulfillment is separate immutable evidence", { skip: !DB }, async () => {
  const { fx, input, entryId, clearing, component, award } = await fixture();
  try {
    await db.execute(sql`update time_entries set hours = 80 where org_id = ${fx.orgId} and id = ${entryId}`);
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    const queued = await queueAwardForPayRun({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, runDocumentId: input.documentId });
    assert.equal((await queueAwardForPayRun({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, runDocumentId: input.documentId })).adjustmentId, queued.adjustmentId);
    assert.equal((await db.execute(sql`select id from pay_run_adjustments where org_id = ${fx.orgId} and id = ${queued.adjustmentId}`)).rows.length, 1);
    await assert.rejects(recordExternalDelivery({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, externalRef: "ISSUED-100" }), /only after the run is committed/);
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    const stub = (await db.execute<{ gross: string; net_pay: string; pensionable_earnings: string; insurable_earnings: string; vacation_accrued: string; factors: Record<string, string> }>(sql`
      select gross, net_pay, pensionable_earnings, insurable_earnings, vacation_accrued, factors from pay_stubs where org_id = ${fx.orgId} and pay_run_document_id = ${input.documentId}`)).rows[0]!;
    const expected = calculateT4127({ payDate: "2026-07-21", province: "ON", periodsPerYear: 26,
      income: "2500", pensionable: "2500", insurable: "2400", federalClaimCode: 1, provincialClaimCode: 1 });
    assert.equal(stub.gross, "2500.0000");
    assert.equal(stub.pensionable_earnings, "2500.0000");
    assert.equal(stub.insurable_earnings, "2400.0000", "the configured flag stays authoritative");
    assert.equal(stub.vacation_accrued, "96.0000", "configured non-vacationable gift value stays out of vacation accrual");
    assert.equal(stub.factors.T, expected.periodicTax);
    assert.equal(stub.net_pay, add("2400", neg(sum([expected.cpp, expected.cpp2, expected.ei, expected.totalTax]))), "withholdings come from cash wages; gift value creates no extra cash");
    assert.equal(stub.factors.NON_CASH_EARNINGS, "100.0000");
    assert.equal((await getBenefitAward(db, fx.orgId, fx.actorId, award.id)).payrollProcessed, false);
    await commitPayRun(input);
    assert.equal((await getBenefitAward(db, fx.orgId, fx.actorId, award.id)).payrollProcessed, true);
    const legs = (await db.execute<{ account_id: string; amount: string }>(sql`select account_id, amount from document_lines where org_id = ${fx.orgId} and document_id = ${input.documentId}`)).rows;
    assert.equal(sum(legs.map(l => l.amount)), "0.0000");
    assert.equal(legs.find(l => l.account_id === clearing)?.amount, "-100.0000");
    const posting = (await db.execute<{ wage: string; net: string; tax: string }>(sql`
      select settings#>>'{payroll,wageExpenseAccountId}' as wage,
             settings#>>'{payroll,netPayAccountId}' as net,
             settings#>>'{payroll,taxPayableAccountId}' as tax
        from orgs where id = ${fx.orgId}
    `)).rows[0]!;
    assert.equal(sum(legs.filter(l => l.account_id === posting.wage).map(l => l.amount)), "2500.0000", "salary and benefit expense are each recognized once");
    assert.equal(sum(legs.filter(l => l.account_id === posting.net).map(l => l.amount)), neg(stub.net_pay), "only the actual cash net becomes wages payable");
    const liabilities = (await db.execute<{ amount: string }>(sql`
      select l.amount from pay_stub_lines l join pay_stubs s on s.org_id = l.org_id and s.id = l.stub_id
       where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${input.documentId}
         and l.kind in ('deduction', 'employer_contribution') and l.liability_account_id = ${posting.tax}
    `)).rows;
    assert.ok(liabilities.length > 0, "the native pack persisted its statutory withholding liabilities");
    assert.equal(sum(legs.filter(l => l.account_id === posting.tax).map(l => l.amount)), neg(sum(liabilities.map(l => l.amount))), "payroll tax and contribution credits match the native component liability snapshots");
    const entry = await post(input);
    assert.equal((await db.execute<{ total: string }>(sql`select sum(amount)::text as total from journal_lines where org_id = ${fx.orgId} and entry_id = ${entry}`)).rows[0]!.total, "0.0000");
    const storedLine = (await db.execute<{ id: string; non_cash_account_id: string; payment_kind: string }>(sql`
      select l.id, l.non_cash_account_id, l.payment_kind from pay_stub_lines l join pay_stubs s on s.org_id = l.org_id and s.id = l.stub_id
      where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${input.documentId} and l.component_id = ${component}`)).rows[0]!;
    const replacement = (await db.execute<{ id: string }>(sql`insert into accounts (org_id, number, name, type) values (${fx.orgId}, '1451', 'Future provider clearing', 'asset_current_other') returning id`)).rows[0]!.id;
    await db.execute(sql`update pay_components set non_cash_account_id = ${replacement}, updated_at = now(), updated_by = ${fx.actorId} where org_id = ${fx.orgId} and id = ${component}`);
    assert.equal((await db.execute<{ non_cash_account_id: string }>(sql`select non_cash_account_id from pay_stub_lines where org_id = ${fx.orgId} and id = ${storedLine.id}`)).rows[0]!.non_cash_account_id, clearing);
    await assert.rejects(withOrgTransaction(fx.orgId, () => db.execute(sql`update pay_stub_lines set non_cash_account_id = ${replacement} where org_id = ${fx.orgId} and id = ${storedLine.id}`)), databaseRefusal(/clearing account of a committed payroll line are immutable; use a correcting payroll run/));
    await assert.rejects(withOrgTransaction(fx.orgId, () => db.execute(sql`update pay_components set payment_kind = 'cash', non_cash_account_id = null where org_id = ${fx.orgId} and id = ${component}`)), databaseRefusal(/active benefit program or approved benefit obligation.*create a new program and component/));
    const fulfilled = await recordExternalDelivery({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, externalRef: "ISSUED-100" });
    assert.equal(fulfilled.externalRef, "ISSUED-100");
    assert.equal((await recordExternalDelivery({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, externalRef: "ISSUED-100" })).id, award.id);
    await assert.rejects(recordExternalDelivery({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, externalRef: "OTHER" }), /different reference/);
    await assert.rejects(requestDocumentVoid({ ...input, reason: "Correct provider benefit value", reversalDate: "2026-07-22" }), /fulfilled non-cash benefit.*adjusting benefit award/);
    assert.equal((await db.execute<{ status: string }>(sql`select status from documents where org_id = ${fx.orgId} and id = ${input.documentId}`)).rows[0]!.status, "posted");
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test("an unfulfilled non-cash payroll run reverses its balanced accounting and cannot later fulfill the provider reward", { skip: !DB }, async () => {
  const { fx, input, award, clearing } = await fixture("100.0000", "liability_current_other");
  try {
    await queueAwardForPayRun({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, runDocumentId: input.documentId });
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    await commitPayRun(input);
    await post(input);
    const result = await requestDocumentVoid({ ...input, reason: "Correct unfulfilled provider payroll", reversalDate: "2026-07-22" });
    assert.equal(result.status, "voided");
    assert.equal((await db.execute<{ total: string }>(sql`select coalesce(sum(amount),0)::text as total from journal_lines where org_id = ${fx.orgId} and account_id = ${clearing}`)).rows[0]!.total, "0.0000");
    assert.equal((await getBenefitAward(db, fx.orgId, fx.actorId, award.id)).payrollProcessed, false);
    await assert.rejects(recordExternalDelivery({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, externalRef: "LATE" }), /voided/);
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test("non-cash value with insufficient cash for configured statutory deductions refuses calculation and commit", { skip: !DB }, async () => {
  const { fx, input, entryId, award } = await fixture("1000.0000");
  try {
    await queueAwardForPayRun({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, runDocumentId: input.documentId });
    await db.execute(sql`delete from time_entries where org_id = ${fx.orgId} and id = ${entryId}`);
    const result = await calculatePayRun(input);
    assert.ok(result.errors.some(error => /cash pay cannot cover required deductions.*cash earnings.*taxes cannot be skipped/.test(error.message)), JSON.stringify(result.errors));
    await assert.rejects(commitPayRun(input), /calculated|errors|calculate/i);
    assert.equal((await db.execute(sql`select id from pay_stubs where org_id = ${fx.orgId} and pay_run_document_id = ${input.documentId}`)).rows.length, 0);
    assert.equal((await getBenefitAward(db, fx.orgId, fx.actorId, award.id)).status, "queued");
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test("an older payroll client cannot persist a non-cash benefit as a default cash earning", { skip: !DB }, async () => {
  const { fx, input, component } = await fixture();
  try {
    const stub = (await db.execute<{ id: string }>(sql`select id from pay_stubs where org_id = ${fx.orgId} and pay_run_document_id = ${input.documentId}`)).rows[0]!;
    await assert.rejects(withOrgTransaction(fx.orgId, () => db.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount)
      values (${fx.orgId}, ${stub.id}, ${component}, 'earning', 'Old-client gift value', 100)
    `)), databaseRefusal(/Update the payroll application and recalculate.*never also be paid as cash/));
    assert.equal((await db.execute(sql`select id from pay_stub_lines where org_id = ${fx.orgId} and stub_id = ${stub.id} and component_id = ${component}`)).rows.length, 0);
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test("queued benefits cannot flip into cash during recalculation and clearing changes invalidate the prior calculation", { skip: !DB }, async () => {
  const { fx, input, component, award } = await fixture();
  try {
    await queueAwardForPayRun({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, runDocumentId: input.documentId });
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    await assert.rejects(withOrgTransaction(fx.orgId, () => db.execute(sql`
      update pay_components set payment_kind = 'cash', non_cash_account_id = null where org_id = ${fx.orgId} and id = ${component}
    `)), databaseRefusal(/active benefit program or approved benefit obligation.*new program and component/));
    const replacement = (await db.execute<{ id: string }>(sql`insert into accounts (org_id, number, name, type) values (${fx.orgId}, '1452', 'Replacement clearing', 'asset_current_other') returning id`)).rows[0]!.id;
    await db.execute(sql`update pay_components set non_cash_account_id = ${replacement}, updated_at = now(), updated_by = ${fx.actorId} where org_id = ${fx.orgId} and id = ${component}`);
    await assert.rejects(commitPayRun(input), /changed|stale|recalculate/i);
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    await commitPayRun(input);
    assert.equal((await db.execute<{ account: string }>(sql`select l.non_cash_account_id as account from pay_stub_lines l join pay_stubs s on s.org_id = l.org_id and s.id = l.stub_id
      where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${input.documentId} and l.component_id = ${component}`)).rows[0]!.account, replacement);
  } finally { await dropScratchOrgReporting(fx.orgId); }
});


test("a retired queued non-cash component raises its usable remedy and reactivation preserves the original payroll input", { skip: !DB }, async () => {
  const { fx, input, component, award, clearing } = await fixture();
  try {
    const queued = await queueAwardForPayRun({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, runDocumentId: input.documentId });
    await db.execute(sql`update pay_components set is_active = false, updated_at = now(), updated_by = ${fx.actorId} where org_id = ${fx.orgId} and id = ${component}`);
    const result = await calculatePayRun(input);
    assert.ok(result.errors.some(error => /non-cash payroll component "Gift-card value" is inactive.*re-enable this component in Payroll components.*recalculate the editable run/.test(error.message)), JSON.stringify(result.errors));
    assert.equal((await db.execute(sql`select l.id from pay_stub_lines l join pay_stubs s on s.org_id = l.org_id and s.id = l.stub_id
      where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${input.documentId} and l.component_id = ${component}`)).rows.length, 0, "no cash representation is persisted on refusal");
    await assert.rejects(commitPayRun(input), /calculated|errors|calculate/i);
    await db.execute(sql`update pay_components set is_active = true, updated_at = now(), updated_by = ${fx.actorId} where org_id = ${fx.orgId} and id = ${component}`);
    const replay = await queueAwardForPayRun({ orgId: fx.orgId, actorId: fx.actorId, awardId: award.id, runDocumentId: input.documentId });
    assert.equal(replay.adjustmentId, queued.adjustmentId);
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    await commitPayRun(input);
    const lines = (await db.execute<{ payment_kind: string; non_cash_account_id: string; amount: string }>(sql`
      select l.payment_kind, l.non_cash_account_id, l.amount from pay_stub_lines l join pay_stubs s on s.org_id = l.org_id and s.id = l.stub_id
       where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${input.documentId} and l.component_id = ${component}
    `)).rows;
    assert.deepEqual(lines, [{ payment_kind: "non_cash", non_cash_account_id: clearing, amount: "100.0000" }]);
    assert.equal((await db.execute(sql`select id from pay_run_adjustments where org_id = ${fx.orgId} and pay_run_document_id = ${input.documentId} and component_id = ${component}`)).rows.length, 1);
  } finally { await dropScratchOrgReporting(fx.orgId); }
});


test("zero-value rewards refuse creation and payroll queueing without recording a zero obligation", { skip: !DB }, async () => {
  const { fx, input, program } = await fixture();
  try {
    const query = { orgId: fx.orgId, actorId: fx.actorId, programId: program.id, employmentId: fx.employmentId,
      periodFrom: "2026-08-01", periodTo: "2026-08-07", currency: "CAD" };
    const before = (await db.execute(sql`select id from hrm_benefit_awards where org_id = ${fx.orgId}`)).rows.length;
    await assert.rejects(createBenefitAward({ ...query, value: "0.0000" }), /zero-value reward creates no payroll obligation.*enter a positive award value/);
    assert.equal((await db.execute(sql`select id from hrm_benefit_awards where org_id = ${fx.orgId}`)).rows.length, before);
    // A direct database draft update exercises the queue boundary independently
    // of the creation validator. It must not create an unconsumable input.
    const malformed = await createBenefitAward({ ...query, value: "100.0000" });
    await withBypassContext(() => db.transaction(async tx => {
      await tx.execute(sql`select set_config('openbooks.amend', 'on', true), set_config('app.bypass_rls', 'on', true)`);
      const privilege = (await tx.execute<{ privileged: boolean }>(sql`select public.app_bypass_rls_active() as privileged`)).rows[0];
      assert.equal(privilege?.privileged, true, "malformed-state fixture uses the actual trusted maintenance role");
      const changed = (await tx.execute(sql`update hrm_benefit_awards set value = 0 where org_id = ${fx.orgId} and id = ${malformed.id} returning id`)).rows;
      assert.equal(changed.length, 1);
    }));
    await submitBenefitAward({ orgId: fx.orgId, actorId: fx.actorId, awardId: malformed.id });
    await assert.rejects(queueAwardForPayRun({ orgId: fx.orgId, actorId: fx.actorId, awardId: malformed.id, runDocumentId: input.documentId }), /zero-value reward cannot enter payroll.*void this reward.*positive value/);
    assert.equal((await db.execute(sql`select id from pay_run_adjustments where org_id = ${fx.orgId} and pay_run_document_id = ${input.documentId}`)).rows.length, 0);
    assert.equal((await voidBenefitAward({ orgId: fx.orgId, actorId: fx.actorId, awardId: malformed.id, reason: "Replace a reward with no monetary obligation" })).status, "voided", "the named correction action is available");
    assert.equal((await createBenefitAward({ ...query, value: "100.0000" })).status, "draft");
  } finally { await dropScratchOrgReporting(fx.orgId); }
});


test("a fixed program refuses a zero denomination on creation, editing and activation", { skip: !DB }, async () => {
  const { fx, component } = await fixture();
  try {
    const query = { orgId: fx.orgId, actorId: fx.actorId, code: "FIXED_DENOMINATION", name: "Fixed provider benefit",
      family: "reward" as const, currency: "CAD", legalEntityId: fx.subsidiaryId, effectiveFrom: "2026-01-01",
      payComponentId: component, deliveryMethod: "external" as const, valuation: "fixed" as const, frequency: "manual" as const };
    const before = (await db.execute(sql`select id from hrm_benefit_programs where org_id = ${fx.orgId}`)).rows.length;
    await assert.rejects(createBenefitProgram({ ...query, fixedAmount: "0.0000" }), /FIXED_DENOMINATION.*positive fixed reward amount.*positive denomination/);
    assert.equal((await db.execute(sql`select id from hrm_benefit_programs where org_id = ${fx.orgId}`)).rows.length, before);
    const draft = await createBenefitProgram({ ...query, fixedAmount: "100.0000" });
    await assert.rejects(updateBenefitProgram({ orgId: fx.orgId, actorId: fx.actorId, programId: draft.id, fixedAmount: "0.0000", reason: "Correct the fixed reward denomination" }), /positive fixed reward amount/);
    assert.equal((await db.execute<{ amount: string }>(sql`select fixed_amount::text as amount from hrm_benefit_programs where org_id = ${fx.orgId} and id = ${draft.id}`)).rows[0]!.amount, "100.0000");
    // Activation validates stored rules too, independently of request validation.
    await db.execute(sql`update hrm_benefit_programs set fixed_amount = 0 where org_id = ${fx.orgId} and id = ${draft.id}`);
    await assert.rejects(activateBenefitProgram({ orgId: fx.orgId, actorId: fx.actorId, programId: draft.id }), /positive fixed reward amount/);
    assert.equal((await db.execute<{ status: string }>(sql`select status from hrm_benefit_programs where org_id = ${fx.orgId} and id = ${draft.id}`)).rows[0]!.status, "draft");
    await updateBenefitProgram({ orgId: fx.orgId, actorId: fx.actorId, programId: draft.id, fixedAmount: "100.0000", reason: "Restore the positive fixed reward denomination" });
    assert.equal((await activateBenefitProgram({ orgId: fx.orgId, actorId: fx.actorId, programId: draft.id })).status, "active", "entering a positive denomination is the supported remedy");
  } finally { await dropScratchOrgReporting(fx.orgId); }
});
