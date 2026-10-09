import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction, withOrgContext, withOrgTransaction } from "../platform/db.ts";
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
import { createSandbox, deleteSandbox, refreshSandbox } from "../sandbox/lifecycle.ts";

for (const approvalMode of ["independent", "solo"] as const) test(`${approvalMode} approval settles unpaid holiday hours once and preserves their history`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seedAdoption();
  const sandboxIds: string[] = [];
  try {
    const actors = await seedFlowActors(fx.orgId);
    await db.execute(sql`update orgs set settings=jsonb_set(jsonb_set(settings,'{features,payroll}','true'),'{payroll,statutoryHolidayPay}','true') where id=${fx.orgId}`);
    await db.execute(sql`insert into worker_employment_versions(org_id,employment_id,version_no,status,effective_from)
      values(${fx.orgId},${fx.employmentId},1,'active','2020-01-06')`);
    for (const actor of [fx.actorId, actors.approver1Id]) {
      await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect)
        values(${fx.orgId},${actor},'payroll.run','grant') on conflict(user_id,permission) do update set effect='grant'`);
    }
    await seedApprovalFlow(fx.orgId, { subjectKind: "financial_change", assignees: [{ type: "user", userId: approvalMode === "solo" ? fx.actorId : actors.approver1Id }], mode: "any", preventSelfApproval: approvalMode !== "solo" });
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
      if (approvalMode === "solo") {
        await assert.rejects(withOrgTransaction(fx.orgId, () => db.execute(sql`update financial_changes set status='approved',approved_by=${fx.actorId},approved_at=now() where org_id=${fx.orgId} and id=${proposed.changeId}`)),
          (error: unknown) => {
            const messages: string[] = [];
            for (let cause = error as { message?: string; cause?: unknown } | undefined; cause; cause = cause.cause as typeof cause) messages.push(cause.message ?? "");
            assert.match(messages.join("\n"), /retained.*policy/i);
            return true;
          });
        // A later policy edit cannot reinterpret the already submitted gate.
        await db.execute(sql`update flows set graph=jsonb_set(graph, '{nodes,1,data,gate,preventSelfApproval}', 'true'::jsonb) where org_id=${fx.orgId} and subject_kind='financial_change'`);
      } else {
        await assert.rejects(decideGate({ gateId: gate.id, decision: "approved", userId: fx.actorId }), /self|assignee|permission|decide/i);
      }
      await decideGate({ gateId: gate.id, decision: "approved", userId: approvalMode === "solo" ? fx.actorId : actors.approver1Id });
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
    const clone = async (masked: boolean, status: string, existing?: { sandboxId: string; sandboxOrgId: string }) => {
      if (existing) await withOrgContext(fx.orgId, () => refreshSandbox(existing.sandboxId, {
        keepCustomizations: false, authority: { actorId: fx.actorId } }));
      const result = existing ?? await withOrgContext(fx.orgId, () => createSandbox({ productionOrgId: fx.orgId,
        name: masked ? "Masked holiday settlement" : "Holiday settlement history", tier: "full", masked,
        createdBy: fx.actorId, lifecycleAuthority: { actorId: fx.actorId } }));
      if (!existing) sandboxIds.push(result.sandboxId);
      const copied = (await db.execute<{ evidence: Record<string, unknown>; source: Record<string, unknown>; payload: Record<string, unknown>; result: Record<string, unknown>; amount: string; status: string; date: string; employee: string; file: string; version: string; obligation: string }>(sql`
        select o.evidence,a.source_snapshot as source,f.payload,f.result,a.amount::text,a.status,occ.holiday_date::text as date,
          o.employee_party_id as employee,o.source_file_id as file,o.source_version_id as version,o.id as obligation
        from payroll_holiday_obligations o join financial_changes f on f.org_id=o.org_id and f.id=o.change_id
        join payroll_holiday_occurrences occ on occ.org_id=o.org_id and occ.obligation_id=o.id
        join pay_run_holiday_allocations a on a.org_id=o.org_id and a.obligation_id=o.id
        where o.org_id=${result.sandboxOrgId}`)).rows;
      assert.equal(copied.length, 1);
      const row = copied[0]!;
      assert.equal(row.amount, "240.0000");
      assert.equal(row.status, status);
      assert.equal(row.date, "2026-07-01");
      assert.notEqual(row.employee, fx.employeeId);
      assert.notEqual(row.file, file.id);
      assert.notEqual(row.version, file.currentVersionId);
      const approvalContext = (await db.execute<{ context: Record<string, unknown>; subject: string; subsidiary: string }>(sql`
        select r.context,r.subject_id as subject,f.subsidiary_id as subsidiary from flow_runs r
        join financial_changes f on f.org_id=r.org_id and f.id=r.subject_id
        where r.org_id=${result.sandboxOrgId} and r.subject_kind='financial_change' and f.operation='adjudicated_holiday_hours'`)).rows;
      assert.equal(approvalContext.length, 1);
      assert.equal(approvalContext[0]!.context.id, approvalContext[0]!.subject);
      assert.equal(approvalContext[0]!.context.subsidiaryId, approvalContext[0]!.subsidiary);
      if (masked) {
        assert.equal(approvalContext[0]!.context.reason, "REDACTED");
        assert.equal(approvalContext[0]!.context.subjectLabel, "REDACTED");
      }
      await withMaintenanceTransaction(null, async () => {
        await db.execute(sql`select set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true),set_config('openbooks.clone','on',true)`);
        const proof = (await db.execute<{ exact: boolean; altered: boolean; missingDate: boolean; changedTerms: boolean }>(sql`
          select public.holiday_historical_clone_matches('public.pay_run_holiday_allocations'::regclass,to_jsonb(a)) as exact,
            public.holiday_historical_clone_matches('public.pay_run_holiday_allocations'::regclass,to_jsonb(a)||'{"amount":241}'::jsonb) as altered,
            public.holiday_historical_clone_matches('public.payroll_holiday_occurrences'::regclass,to_jsonb(occ)||'{"holiday_date":"2026-07-02"}'::jsonb) as "missingDate",
            public.payroll_service_historical_clone_matches('public.payroll_vacation_terms'::regclass,to_jsonb(v)||'{"percent_floor":5}'::jsonb) as "changedTerms"
          from pay_run_holiday_allocations a
          join payroll_holiday_occurrences occ on occ.org_id=a.org_id and occ.obligation_id=a.obligation_id
          join payroll_holiday_obligations o on o.org_id=a.org_id and o.id=a.obligation_id
          join payroll_vacation_terms v on v.org_id=o.org_id and v.employment_id=o.employment_id
          where a.org_id=${result.sandboxOrgId}`)).rows;
        assert.deepEqual(proof, [{ exact: true, altered: false, missingDate: false, changedTerms: false }]);
      });
      if (masked) {
        for (const value of [row.evidence, row.source, row.payload, row.result]) assert.deepEqual(value, {});
      } else {
        assert.equal((row.evidence.instruction as Record<string, unknown>).employeePartyId, row.employee);
        assert.equal((row.evidence.source as Record<string, unknown>).fileId, row.file);
        assert.equal((row.evidence.source as Record<string, unknown>).versionId, row.version);
        assert.deepEqual(row.source.obligation, row.evidence);
        assert.deepEqual(row.payload.evidence, row.evidence);
        assert.equal(row.result.obligationId, row.obligation);
      }
      return result;
    };
    const fullClone = await clone(false, "committed");
    await requestDocumentVoid({ ...runInput, reason: "Reverse payroll containing the holiday settlement", reversalDate: "2026-07-21" });
    const voided = await settlement();
    assert.equal(voided.length, 1);
    assert.equal(voided[0]!.status, "voided");
    assert.equal(voided[0]!.amount, "240.0000");
    assert.equal(voided[0]!.lineId, committed[0]!.lineId);
    await clone(false, "voided", fullClone);
    const maskedClone = await clone(true, "voided");
    await clone(true, "voided", maskedClone);
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    // A failed native create retains its lifecycle record for diagnostics.
    // Include those shells so a refused copy cannot strand its source org.
    const retained = (await db.execute<{ id: string }>(sql`select id from sandboxes where production_org_id=${fx.orgId}`)).rows;
    for (const id of new Set([...sandboxIds, ...retained.map(row => row.id)])) {
      await deleteSandbox(id, { systemReason: "Remove private holiday settlement fixture" });
    }
    await dropScratchOrg(fx.orgId);
  }
});
