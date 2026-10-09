import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { createCabinetFile } from "../platform/file-ingestion.ts";
import { seedApprovalFlow, seedFlowActors, dropScratchOrg } from "../testing/fixtures.ts";
import { seedAdoption, calculatedRun } from "./filing-test-fixtures.ts";
import { proposeHolidayObligation, applyHolidayObligation } from "./holiday-obligations.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { submitForApproval } from "../flows/submit.ts";

test("approved unpaid holiday hours settle once through native payroll and survive recalculation", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seedAdoption();
  try {
    const actors = await seedFlowActors(fx.orgId);
    await db.execute(sql`update orgs set settings=jsonb_set(jsonb_set(settings,'{features,payroll}','true'),'{payroll,statutoryHolidayPay}','true') where id=${fx.orgId}`);
    await db.execute(sql`insert into worker_employment_versions(org_id,employment_id,version_no,status,effective_from)
      values(${fx.orgId},${fx.employmentId},1,'active','2020-01-06')`);
    for (const actor of [fx.actorId, actors.approver1Id]) {
      await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect)
        values(${fx.orgId},${actor},'payroll.run','grant') on conflict(user_id,permission) do update set effect='grant'`);
    }
    await seedApprovalFlow(fx.orgId, { subjectKind: "financial_change", assignees: [{ type: "user", userId: actors.approver1Id }], mode: "any", preventSelfApproval: true });
    const folderId = randomUUID();
    await db.execute(sql`insert into folders(id,org_id,name) values(${folderId},${fx.orgId},'Holiday instructions')`);
    const bytes = Buffer.from("Approve eight unpaid Canada Day hours for payment July 21, priced at the July 18 wage.");
    const file = await withOrgTransaction(fx.orgId, () => createCabinetFile({ orgId: fx.orgId, folderId, filename: "holiday.txt", contentType: "text/plain", bytes, createdBy: fx.actorId, auditActorId: fx.actorId, executor: db }));
    // The Cabinet ACL is an external boundary of the payroll command. Its
    // refusal and exact file identity are exercised without mocking pricing.
    const input = { orgId: fx.orgId, actorId: fx.actorId, employmentId: fx.employmentId,
      instruction: { employeePartyId: fx.employeeId, holidayDates: ["2026-07-01"], hours: "8", assessedOn: "2026-07-18", wageBasisDate: "2026-07-18", paymentDate: "2026-07-21", instructionKey: "canada-day-unpaid", sourceReference: "Approved Canada Day entitlement", sourceDigest: createHash("sha256").update(bytes).digest("hex") },
      source: { fileId: file.id, versionId: file.currentVersionId }, reason: "Settle independently reviewed unpaid holiday hours", idempotencyKey: randomUUID(), authorizeFile: async (id: string) => id === file.id };
    await assert.rejects(proposeHolidayObligation({ ...input, authorizeFile: async () => false }), /File Cabinet read access/);
    const proposed = await proposeHolidayObligation(input);
    assert.deepEqual(await proposeHolidayObligation(input), proposed);
    await assert.rejects(applyHolidayObligation({ ...input, changeId: proposed.changeId }), /approval/i);
    await withOrgContext(fx.orgId, async () => {
      await submitFinancialChange(fx.orgId, proposed.changeId, fx.actorId);
      const gate = (await db.execute<{ id: string }>(sql`select id from flow_gates where org_id=${fx.orgId} and subject_id=${proposed.changeId} and status='pending'`)).rows[0]!;
      assert.ok(gate);
      await assert.rejects(decideGate({ gateId: gate.id, decision: "approved", userId: fx.actorId }), /self|assignee|permission|decide/i);
      await decideGate({ gateId: gate.id, decision: "approved", userId: actors.approver1Id });
    });
    const applied = await applyHolidayObligation({ ...input, changeId: proposed.changeId });
    assert.deepEqual(await applyHolidayObligation({ ...input, changeId: proposed.changeId }), applied);
    assert.deepEqual(await proposeHolidayObligation(input), proposed);
    await assert.rejects(proposeHolidayObligation({ ...input, idempotencyKey: randomUUID() }), /already belong/);
    const { input: runInput } = await calculatedRun(fx);
    const settlement = async () => (await db.execute<{ amount: string; hours: string; rate: string; status: string; lineId: string | null }>(sql`
      select amount::text,hours::text,rate::text,status,pay_stub_line_id as "lineId" from pay_run_holiday_allocations where org_id=${fx.orgId} and obligation_id=${applied.obligationId}`)).rows;
    const initial = await settlement();
    assert.equal(initial.length, 1);
    assert.equal(initial[0]!.amount, "240.0000");
    assert.equal(initial[0]!.hours, "8.00");
    assert.equal(initial[0]!.rate, "30.0000");
    assert.equal(initial[0]!.status, "calculated");
    assert.ok(initial[0]!.lineId);
    assert.deepEqual((await calculatePayRun(runInput)).errors, []);
    const recalculated = await settlement();
    assert.equal(recalculated.length, 1);
    assert.deepEqual({ ...recalculated[0], lineId: null }, { ...initial[0], lineId: null });
    assert.ok(recalculated[0]!.lineId);
    await commitPayRun(runInput);
    const committed = await settlement();
    assert.equal(committed.length, 1);
    assert.equal(committed[0]!.status, "committed");
    assert.equal(committed[0]!.amount, "240.0000");
    await withOrgContext(fx.orgId, async () => {
      await seedApprovalFlow(fx.orgId, { subjectKind: "pay_run", assignees: [{ type: "user", userId: actors.approver1Id }], mode: "any", preventSelfApproval: true });
      await submitForApproval("pay_run", runInput.documentId, fx.actorId);
      const payGate = (await db.execute<{ id: string }>(sql`select id from flow_gates where org_id=${fx.orgId} and subject_id=${runInput.documentId} and status='pending'`)).rows[0]!;
      assert.ok(payGate);
      await decideGate({ gateId: payGate.id, decision: "approved", userId: actors.approver1Id });
      const accounts = (await db.execute<{ id: string; type: string }>(sql`select id,type from accounts where org_id=${fx.orgId}`)).rows;
      const account = (type: string) => {
        const id = accounts.find(row => row.type === type)?.id;
        assert.ok(id, `Missing fixture account ${type}`);
        return id;
      };
      await postDocument(runInput.documentId, { control: { ar: account("asset_receivable"), ap: account("liability_payable"), bank: account("asset_bank") } }, { audit: { actorId: fx.actorId, source: "payroll" } });
    });
    await requestDocumentVoid({ ...runInput, reason: "Reverse payroll containing the holiday settlement", reversalDate: "2026-07-21" });
    const voided = await settlement();
    assert.equal(voided.length, 1);
    assert.equal(voided[0]!.status, "voided");
    assert.equal(voided[0]!.amount, "240.0000");
    assert.equal(voided[0]!.lineId, committed[0]!.lineId);
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
