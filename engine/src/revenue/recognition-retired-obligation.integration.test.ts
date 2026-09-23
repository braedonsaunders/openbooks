import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  type ScratchOrg,
  type FlowActors,
} from "../testing/fixtures.ts";
import {
  buildRecognitionSchedule,
  recordRecognitionEvent,
  runRevenueRecognition,
} from "./recognition.ts";
import {
  proposeRevenueModification,
  applyRevenueModification,
} from "./contract-modifications.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Fixture = {
  org: ScratchOrg;
  actors: FlowActors;
  obligationId: string;
  ruleId: string;
  slRuleId: string;
};

async function fixture(fn: (f: Fixture) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await db.execute(
      sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${actors.submitterId},'ar.post','grant')`,
    );
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
    const ruleId = randomUUID(),
      contractId = randomUUID(),
      obligationId = randomUUID();
    await db.execute(sql`insert into recognition_rules
      (id,org_id,code,name,method,is_forecast,recognition_periods,deferred_account_id,recognized_account_id,is_active)
      values(${ruleId},${org.orgId},${ruleId},'Milestone rule','milestone',false,1,${org.accounts.deferred},${org.accounts.recognized},true)`);
    const slRuleId = randomUUID();
    await db.execute(sql`insert into recognition_rules
      (id,org_id,code,name,method,is_forecast,recognition_periods,start_date_source,end_date_source,period_offset,start_offset_days,initial_amount_percent,deferred_account_id,recognized_account_id,is_active)
      values(${slRuleId},${org.orgId},${slRuleId},'Straight-line rule','straight_line_even',false,2,
             'obligation','term',0,0,'0',${org.accounts.deferred},${org.accounts.recognized},true)`);
    await db.execute(sql`insert into revenue_contracts(id,org_id,subsidiary_id,customer_id,contract_number,status,starts_on,ends_on,currency,total_transaction_price,created_by,updated_by)
   values(${contractId},${org.orgId},${org.subsidiaryId},${org.customerId},${`MS-${contractId}`},'active','2026-07-01','2026-09-30','CAD',1000,${actors.submitterId},${actors.submitterId})`);
    await db.execute(sql`insert into performance_obligations(id,org_id,contract_id,description,recognition_rule_id,allocated_price,standalone_selling_price,recognition_starts_on,deferred_account_id,recognized_account_id,status,created_by,updated_by)
   values(${obligationId},${org.orgId},${contractId},'Milestone deliverable',${ruleId},1000,1000,'2026-07-01',${org.accounts.deferred},${org.accounts.recognized},'open',${actors.submitterId},${actors.submitterId})`);
    await buildRecognitionSchedule(
      obligationId,
      org.orgId,
      actors.submitterId,
      org.bookId,
    );
    // Earn the milestone before amending: a promise with no events recorded
    // cannot be retired because the amendment's own posting pass refuses an
    // event-less open milestone before it ever reaches retirement.
    await recordRecognitionEvent({
      obligationId,
      orgId: org.orgId,
      actorId: actors.submitterId,
      periodMonth: "2026-07-01",
      amount: "1000",
      sourceReference: "milestone-1",
    });
    const posted = await runRevenueRecognition(
      org.orgId,
      "2026-07-31",
      actors.submitterId,
      obligationId,
    );
    assert.equal(posted.posted, 1);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "financial_change",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
      preventSelfApproval: false,
    });
    await fn({ org, actors, obligationId, ruleId, slRuleId });
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function eventCount(f: Fixture, obligationId: string) {
  const rows = (
    await db.execute<{ id: string }>(
      sql`select id from recognition_events where org_id=${f.org.orgId} and obligation_id=${obligationId}`,
    )
  ).rows;
  return rows.length;
}

test(
  "an event on a promise retired by modification is refused by name with no event row",
  { skip: !DB },
  async () =>
    fixture(async (f) => {
      // A prospective amendment that replaces (rather than carries) the
      // milestone promise retires it: satisfied, schedule closed.
      const { changeId } = await proposeRevenueModification(
        f.org.orgId,
        (
          await db.execute<{ id: string }>(
            sql`select contract_id as id from performance_obligations where org_id=${f.org.orgId} and id=${f.obligationId}`,
          )
        ).rows[0]!.id,
        f.actors.submitterId,
        {
          effectiveOn: "2026-08-01",
          reason: "Customer descoped the milestone and added a service",
          idempotencyKey: randomUUID(),
          subsidiaryId: f.org.subsidiaryId,
          enforceableRightsEvidence: "Customer and supplier signed amendment A1",
          assessment:
            "Remaining service is distinct; same CAD functional currency; milestone descoped.",
          bookRates: [{ bookId: f.org.bookId, fxRate: "1" }],
          groups: [
            {
              treatment: "prospective",
              existingObligationIds: [f.obligationId],
              considerationChange: "500",
              remainingDistinct: true,
              additionsAtStandalonePrice: false,
              promises: [
                {
                  description: "Replacement service",
                  standaloneSellingPrice: "500",
                  recognitionRuleId: f.slRuleId,
                  recognitionEndsOn: "2026-09-30",
                  percentComplete: "0",
                  deferredAccountId: f.org.accounts.deferred,
                  recognizedAccountId: f.org.accounts.recognized,
                },
              ],
            },
          ],
        },
      );
      await submitFinancialChange(f.org.orgId, changeId, f.actors.submitterId);
      const gate = (
        await db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${f.org.orgId} and subject_id=${changeId} and status='pending'`,
        )
      ).rows[0];
      assert.ok(gate);
      await decideGate({
        gateId: gate.id,
        userId: f.actors.approver1Id,
        decision: "approved",
      });
      await applyRevenueModification(
        f.org.orgId,
        changeId,
        f.actors.submitterId,
      );
      const status = (
        await db.execute<{ status: string }>(
          sql`select status from performance_obligations where org_id=${f.org.orgId} and id=${f.obligationId}`,
        )
      ).rows[0]!.status;
      assert.equal(status, "satisfied");

      await assert.rejects(
        recordRecognitionEvent({
          obligationId: f.obligationId,
          orgId: f.org.orgId,
          actorId: f.actors.submitterId,
          periodMonth: "2026-08-01",
          amount: "100",
          sourceReference: "late-milestone",
        }),
        /was retired by modification .* record the event against its replacement promise/,
      );
      // The pre-amendment milestone event survives; the refused late event
      // left no row.
      assert.equal(await eventCount(f, f.obligationId), 1);
    }),
);
