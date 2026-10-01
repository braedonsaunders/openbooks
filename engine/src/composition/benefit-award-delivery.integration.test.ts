import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { grantPermissions } from "../testing/hrm-harness.ts";
import { seedAdoption, calculatedRun } from "../payroll/filing-test-fixtures.ts";
import { calculatePayRun } from "../payroll/run-calculation.ts";
import { commitPayRun } from "../payroll/run-commit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { activateBenefitProgram, addProgramMembership, createBenefitProgram } from "../hrm/benefits/programs.ts";
import { approveBenefitAward, createBenefitAward, submitBenefitAward } from "../hrm/benefits/awards.ts";
import { confirmAwardPayrollDelivery, queueAwardForPayRun } from "../hrm/benefits/settlement.ts";
import { measureMoneySource } from "../hrm/benefits/incentives.ts";
import { employmentBenefitStatement } from "../hrm/benefits/benefit-statement.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("cash reward delivery proves its exact line through native payroll calculation and commit", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"hrm":true}'::jsonb) where id = ${fx.orgId}`);
    // The native payroll fixture creates employment identity; benefits also
    // requires current-known active service covering the entitlement period.
    await db.execute(sql`
      insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, recorded_at)
      values (${fx.orgId}, ${fx.employmentId}, 1, 'active', '2026-01-01'::date, now())
    `);
    const approverId = await createScratchUser(fx.orgId, "Benefits Approver", "admin");
    await grantPermissions(fx.orgId, fx.actorId, ["hrm.benefits.read", "hrm.benefits.manage", "gl.read"]);
    await grantPermissions(fx.orgId, approverId, ["hrm.benefits.read", "hrm.benefits.manage"]);
    const component = (await db.execute<{id: string}>(sql`
      select id from pay_components where org_id = ${fx.orgId} and system_key = 'bonus' and (country = 'CA' or country is null) order by country nulls last
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
    const statement = await employmentBenefitStatement({orgId: fx.orgId, actorId: fx.actorId, employmentId: fx.employmentId});
    assert.equal(statement.paidAwards.length, 1);
    assert.deepEqual(statement.paidTotals, [{currency: "CAD", total: "25.0000"}]);
    assert.equal(statement.payrollRecords.length, 1);
    assert.equal(statement.payrollRecords[0]!.gross, "265.0000", "the award is already in payroll gross, never added to it twice");
    const accounts = (await db.execute<{id: string; type: string}>(sql`select id, type from accounts where org_id=${fx.orgId}`)).rows;
    const account = (type: string) => {
      const found = accounts.find((a) => a.type === type)?.id;
      assert.ok(found, `fixture has ${type} control account`);
      return found;
    };
    await db.execute(sql`update documents set status='approved' where org_id=${fx.orgId} and id=${input.documentId}`);
    await postDocument(input.documentId, {control: {ar: account("asset_receivable"), ap: account("liability_payable"), bank: account("asset_bank")}});
    const revenueAccount = accounts.find((a) => a.type === "income")?.id;
    assert.ok(revenueAccount, "the native fixture has a revenue account");
    const expenseAccount = (await db.execute<{id:string}>(sql`select settings#>>'{payroll,wageExpenseAccountId}' as id from orgs where id=${fx.orgId}`)).rows[0]!.id;
    const measure = () => measureMoneySource(db, fx.orgId, fx.actorId, {
      metric: "net_profit", scope: "company", departmentIds: [], projectIds: [],
      revenueAccountIds: [revenueAccount], expenseAccountIds: [expenseAccount], legalEntityId: fx.subsidiaryId,
      currency: "CAD", periodFrom: "2026-07-01", periodTo: "2026-07-31", incentiveExpenseAccountId: null, allowedSubsidiaryIds: null,
    });
    assert.ok((await measure()).value.startsWith("-"), "the posted payroll incurs a cost before reversal");
    const voided = await requestDocumentVoid({orgId: fx.orgId, actorId: fx.actorId, documentId: input.documentId, reason: "Correct the authorized payroll", reversalDate: "2026-07-22"});
    assert.equal(voided.status, "voided");
    const netted = await measure();
    assert.equal(netted.value, "0.0000", "the original reversed header and the posted offset both remain in the financial measure");
    assert.ok(netted.entryIds.length >= 2, "the source snapshot retains original and reversing entries");
    const afterVoid = await employmentBenefitStatement({orgId: fx.orgId, actorId: fx.actorId, employmentId: fx.employmentId});
    assert.deepEqual(afterVoid.paidAwards, []);
    assert.deepEqual(afterVoid.paidTotals, []);
    assert.deepEqual(afterVoid.payrollRecords, []);
    assert.equal(afterVoid.reversedAwards[0]!.id, award.id);
    assert.equal(afterVoid.reversedAwards[0]!.status, "delivered", "the original delivery evidence is immutable");
    assert.equal(afterVoid.reversedAwards[0]!.deliveryState, "reversed");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
