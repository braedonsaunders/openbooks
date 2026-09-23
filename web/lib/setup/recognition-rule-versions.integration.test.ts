import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * Recognition-rule policy is effective-dated: once a rule is referenced by
 * any obligation, a policy edit creates a successor version instead of
 * rewriting the row, and the obligation keeps its pinned row. Proved here
 * against the real setup writer and a real database:
 * - after the first posting, editing the rule leaves the old obligation's
 *   future plan unchanged while items repoint at the successor and a new
 *   obligation built from it follows the new policy;
 * - a later modification snapshots the pinned (old) policy for its stub;
 * - a name-only edit stays in place, and an unused rule edits in place.
 */

// The writer imports the server-only marker; shim it like the other
// route-level tests do (same seam as subsidiary-scope.test.ts).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  seedApprovalFlow,
} = await import("@openbooks/engine/src/testing/fixtures.ts");
const {
  buildRecognitionSchedule,
  runRevenueRecognition,
} = await import("@openbooks/engine/src/revenue/recognition.ts");
const {
  proposeRevenueModification,
  applyRevenueModification,
} = await import("@openbooks/engine/src/revenue/contract-modifications.ts");
const { submitFinancialChange } = await import(
  "@openbooks/engine/src/flows/financial-changes-adapter.ts"
);
const { decideGate } = await import("@openbooks/engine/src/flows/gates.ts");
const { toUnits } = await import("@openbooks/engine/src/money/money.ts");
const { createSetupRecord, updateSetupRecord } = await import("./write.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Fixture = {
  orgId: string;
  subsidiaryId: string;
  bookId: string;
  deferred: string;
  recognized: string;
  customerId: string;
  actorId: string;
  approverId: string;
  contractId: string;
  obligationId: string;
  itemId: string;
  ruleId: string;
};

async function fixture(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  await db.execute(
    sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${actors.submitterId},'ar.post','grant')`,
  );
  const actor = { orgId: org.orgId, id: actors.submitterId, permissions: [] as string[] };
  const calendar = (
    await db.execute<{ id: string }>(
      sql`select fiscal_calendar_id as id from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`,
    )
  ).rows[0]!.id;
  for (const [month, last] of [
    ["08", "31"],
    ["09", "30"],
  ])
    await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,custom)
   values(${randomUUID()},${org.orgId},${calendar},2026,${Number(month)},${`2026-${month}`},${`2026-${month}-01`},${`2026-${month}-${last}`},false,'{}'::jsonb)`);
  // A 3-month straight-line rule, created through the real setup writer.
  const code = `SL3-${randomUUID().slice(0, 8)}`;
  const created = await createSetupRecord(actor, "recognition-rules", {
    code,
    name: "3-month straight line",
    method: "straight_line_even",
    recognitionPeriods: 3,
    isActive: true,
  });
  assert.equal(created.status, 200);
  const ruleId = String((created.body as { id: string }).id);
  const itemId = randomUUID();
  await db.execute(sql`insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation,
                       income_account_id, recognition_rule_id, deferred_account_id)
    values (${itemId}, ${org.orgId}, 'service', 'Quarterly service', false, true, '{}'::jsonb, 'billing', 'normal',
            ${org.accounts.revenue}, ${ruleId}, ${org.accounts.deferred})`);
  const contractId = randomUUID(), obligationId = randomUUID();
  await db.execute(sql`insert into revenue_contracts(id,org_id,subsidiary_id,customer_id,contract_number,status,starts_on,ends_on,currency,total_transaction_price,created_by,updated_by)
   values(${contractId},${org.orgId},${org.subsidiaryId},${org.customerId},${`VER-${contractId}`},'active','2026-07-01','2026-09-30','CAD',3000,${actors.submitterId},${actors.submitterId})`);
  await db.execute(sql`insert into performance_obligations(id,org_id,contract_id,description,recognition_rule_id,allocated_price,standalone_selling_price,recognition_starts_on,recognition_ends_on,deferred_account_id,recognized_account_id,status,created_by,updated_by)
   values(${obligationId},${org.orgId},${contractId},'Quarterly service',${ruleId},3000,3000,'2026-07-01','2026-09-30',${org.accounts.deferred},${org.accounts.recognized},'open',${actors.submitterId},${actors.submitterId})`);
  await buildRecognitionSchedule(obligationId, org.orgId, actors.submitterId, org.bookId);
  const posted = await runRevenueRecognition(org.orgId, "2026-07-31", actors.submitterId, obligationId);
  assert.equal(posted.posted, 1);
  await seedApprovalFlow(org.orgId, {
    subjectKind: "financial_change",
    assignees: [{ type: "user", userId: actors.approver1Id }],
    mode: "any",
    preventSelfApproval: false,
  });
  return {
    orgId: org.orgId,
    subsidiaryId: org.subsidiaryId,
    bookId: org.bookId,
    deferred: org.accounts.deferred,
    recognized: org.accounts.recognized,
    customerId: org.customerId,
    actorId: actors.submitterId,
    approverId: actors.approver1Id,
    contractId,
    obligationId,
    itemId,
    ruleId,
  };
}

async function editRule(f: Fixture, patch: Record<string, unknown>) {
  const actor = { orgId: f.orgId, id: f.actorId, permissions: [] as string[] };
  return updateSetupRecord(actor, "recognition-rules", {
    id: f.ruleId,
    name: "3-month straight line",
    method: "straight_line_even",
    ...patch,
  });
}

async function planLines(f: Fixture, obligationId: string) {
  return (
    await db.execute<{ planned: string; posted: boolean }>(
      sql`select l.planned_amount::text as planned, (l.journal_entry_id is not null) as posted
        from recognition_schedule_lines l join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
       where s.org_id = ${f.orgId} and s.obligation_id = ${obligationId} and l.superseded_by_change_id is null
       order by l.sequence`,
    )
  ).rows;
}

async function earned(f: Fixture) {
  const row = (
    await db.execute<{ amount: string }>(
      sql`select coalesce(-sum(l.amount),0)::text as amount from journal_lines l join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=${f.orgId} and l.account_id=${f.recognized} and e.status in('posted','reversed')`,
    )
  ).rows[0]!;
  return toUnits(row.amount);
}

test(
  "a policy edit on a used rule creates a successor; the old plan is unchanged and new work follows the successor",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const res = await editRule(f, { method: "point_in_time" });
      assert.equal(res.status, 200);
      const successorId = String((res.body as { id: string }).id);
      assert.notEqual(successorId, f.ruleId);

      const oldRow = (
        await db.execute<{ version: number; superseded_by: string | null; is_active: boolean; method: string }>(
          sql`select version, superseded_by, is_active, method from recognition_rules where org_id=${f.orgId} and id=${f.ruleId}`,
        )
      ).rows[0]!;
      assert.equal(oldRow.version, 1);
      assert.equal(oldRow.superseded_by, successorId);
      assert.equal(oldRow.is_active, false);
      assert.equal(oldRow.method, "straight_line_even");

      const newRow = (
        await db.execute<{ version: number; code: string; method: string; is_active: boolean }>(
          sql`select version, code, method, is_active from recognition_rules where org_id=${f.orgId} and id=${successorId}`,
        )
      ).rows[0]!;
      assert.equal(newRow.version, 2);
      assert.equal(newRow.method, "point_in_time");
      assert.equal(newRow.is_active, true);

      // Items repoint at the successor; the obligation keeps its pinned row.
      const itemRule = (
        await db.execute<{ rule: string }>(
          sql`select recognition_rule_id as rule from items where org_id=${f.orgId} and id=${f.itemId}`,
        )
      ).rows[0]!.rule;
      assert.equal(itemRule, successorId);
      const obligationRule = (
        await db.execute<{ rule: string }>(
          sql`select recognition_rule_id as rule from performance_obligations where org_id=${f.orgId} and id=${f.obligationId}`,
        )
      ).rows[0]!.rule;
      assert.equal(obligationRule, f.ruleId);

      // The old obligation's future plan is unchanged: July posted, August
      // and September still straight-line monthly amounts.
      assert.deepEqual(
        (await planLines(f, f.obligationId)).map((l) => [l.planned, l.posted]),
        [
          ["1000.0000", true],
          ["1000.0000", false],
          ["1000.0000", false],
        ],
      );

      // Rebuilding after the edit still reads the pinned version: the plan
      // stays straight-line instead of collapsing to one point_in_time line.
      await buildRecognitionSchedule(f.obligationId, f.orgId, f.actorId, f.bookId);
      assert.deepEqual(
        (await planLines(f, f.obligationId)).map((l) => [l.planned, l.posted]),
        [
          ["1000.0000", true],
          ["1000.0000", false],
          ["1000.0000", false],
        ],
      );

      // A new obligation built after the edit follows the successor policy:
      // point_in_time plans the whole amount in a single line.
      const obligation2 = randomUUID();
      await db.execute(sql`insert into performance_obligations(id,org_id,contract_id,description,recognition_rule_id,allocated_price,standalone_selling_price,recognition_starts_on,recognition_ends_on,deferred_account_id,recognized_account_id,status,created_by,updated_by)
       values(${obligation2},${f.orgId},${f.contractId},'Later service',${successorId},3000,3000,'2026-07-01','2026-09-30',${f.deferred},${f.recognized},'open',${f.actorId},${f.actorId})`);
      await buildRecognitionSchedule(obligation2, f.orgId, f.actorId, f.bookId);
      assert.deepEqual(
        (await planLines(f, obligation2)).map((l) => l.planned),
        ["3000.0000"],
      );
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "a modification after a rule edit snapshots the pinned version for its stub",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const res = await editRule(f, { method: "point_in_time" });
      assert.equal(res.status, 200);
      const successorId = String((res.body as { id: string }).id);

      const { changeId } = await proposeRevenueModification(f.orgId, f.contractId, f.actorId, {
        effectiveOn: "2026-08-15",
        reason: "Signed service extension and pricing amendment",
        idempotencyKey: randomUUID(),
        subsidiaryId: f.subsidiaryId,
        enforceableRightsEvidence: "Customer and supplier signed amendment A1",
        assessment: "Remaining monthly service is distinct; same CAD functional currency.",
        bookRates: [{ bookId: f.bookId, fxRate: "1" }],
        groups: [
          {
            treatment: "prospective",
            existingObligationIds: [f.obligationId],
            considerationChange: "0",
            remainingDistinct: true,
            additionsAtStandalonePrice: false,
            promises: [
              {
                existingId: f.obligationId,
                description: "Amended service",
                standaloneSellingPrice: "3000",
                recognitionRuleId: successorId,
                percentComplete: "0",
                deferredAccountId: f.deferred,
                recognizedAccountId: f.recognized,
              },
            ],
          },
        ],
      });
      await submitFinancialChange(f.orgId, changeId, f.actorId);
      const gate = (
        await db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${f.orgId} and subject_id=${changeId} and status='pending'`,
        )
      ).rows[0];
      assert.ok(gate);
      await decideGate({ gateId: gate.id, userId: f.approverId, decision: "approved" });
      await applyRevenueModification(f.orgId, changeId, f.actorId);
      // July posted 1000 under the old policy; the mid-August stub accrues
      // 14 of August's 31 days at the PINNED straight-line rate. Had the
      // snapshot read the successor point_in_time policy, the stub would
      // have posted the full August 1000 instead.
      assert.equal(await earned(f), toUnits("1451.6129"));
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "a name-only edit stays in place and an unused rule edits in place",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const renamed = await editRule(f, {});
      assert.equal(renamed.status, 200);
      assert.equal(String((renamed.body as { id: string }).id), f.ruleId);
      // No successor was created: the edited row is still the only row
      // carrying its code.
      const count = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from recognition_rules where org_id=${f.orgId} and code=(select code from recognition_rules where org_id=${f.orgId} and id=${f.ruleId})`,
        )
      ).rows[0]!.n;
      assert.equal(count, 1);

      const actor = { orgId: f.orgId, id: f.actorId, permissions: [] as string[] };
      const fresh = await createSetupRecord(actor, "recognition-rules", {
        code: `UNUSED-${randomUUID().slice(0, 8)}`,
        name: "Unused rule",
        method: "straight_line_even",
        recognitionPeriods: 12,
        isActive: true,
      });
      assert.equal(fresh.status, 200);
      const freshId = String((fresh.body as { id: string }).id);
      const edited = await updateSetupRecord(actor, "recognition-rules", {
        id: freshId,
        name: "Unused rule",
        method: "point_in_time",
      });
      assert.equal(edited.status, 200);
      assert.equal(String((edited.body as { id: string }).id), freshId);
      const method = (
        await db.execute<{ method: string }>(
          sql`select method from recognition_rules where org_id=${f.orgId} and id=${freshId}`,
        )
      ).rows[0]!.method;
      assert.equal(method, "point_in_time");
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);
