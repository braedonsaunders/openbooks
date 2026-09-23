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
import { buildRecognitionSchedule } from "./recognition.ts";
import {
  proposeRevenueModification,
  applyRevenueModification,
  type RevenueModificationInput,
} from "./contract-modifications.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { toUnits } from "../money/money.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Fixture = {
  org: ScratchOrg;
  actors: FlowActors;
  contractId: string;
  obligationId: string;
  ruleId: string;
};

/**
 * A March-2026 contract whose rule carries a 20-day start offset: recognition
 * starts Mar 1 but the contractual event / service start is Mar 21.
 */
async function fixture(
  method: "point_in_time" | "straight_line_daily",
  fn: (f: Fixture) => Promise<void>,
) {
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
    await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,custom)
   values(${randomUUID()},${org.orgId},${calendar},2026,3,'2026-03','2026-03-01','2026-03-31',false,'{}'::jsonb)`);
    const ruleId = randomUUID(),
      contractId = randomUUID(),
      obligationId = randomUUID();
    await db.execute(sql`insert into recognition_rules
      (id,org_id,code,name,method,is_forecast,recognition_periods,start_date_source,end_date_source,
       period_offset,start_offset_days,initial_amount_percent,deferred_account_id,recognized_account_id,is_active)
      values(${ruleId},${org.orgId},${ruleId},'Offset rule',${method},false,null,
             'obligation','term',0,20,'0',${org.accounts.deferred},${org.accounts.recognized},true)`);
    await db.execute(sql`insert into revenue_contracts(id,org_id,subsidiary_id,customer_id,contract_number,status,starts_on,ends_on,currency,total_transaction_price,created_by,updated_by)
   values(${contractId},${org.orgId},${org.subsidiaryId},${org.customerId},${`OFF-${contractId}`},'active','2026-03-01','2026-03-31','CAD',3000,${actors.submitterId},${actors.submitterId})`);
    await db.execute(sql`insert into performance_obligations(id,org_id,contract_id,description,recognition_rule_id,allocated_price,standalone_selling_price,recognition_starts_on,recognition_ends_on,deferred_account_id,recognized_account_id,status,created_by,updated_by)
   values(${obligationId},${org.orgId},${contractId},'Offset service',${ruleId},3000,3000,'2026-03-01','2026-03-31',${org.accounts.deferred},${org.accounts.recognized},'open',${actors.submitterId},${actors.submitterId})`);
    await buildRecognitionSchedule(
      obligationId,
      org.orgId,
      actors.submitterId,
      org.bookId,
    );
    await seedApprovalFlow(org.orgId, {
      subjectKind: "financial_change",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
      preventSelfApproval: false,
    });
    await fn({ org, actors, contractId, obligationId, ruleId });
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

function proposal(f: Fixture, effectiveOn: string): RevenueModificationInput {
  return {
    effectiveOn,
    reason: "Signed amendment with no price change",
    idempotencyKey: randomUUID(),
    subsidiaryId: f.org.subsidiaryId,
    enforceableRightsEvidence: "Customer and supplier signed amendment A1",
    assessment:
      "Remaining service is distinct; same CAD functional currency; no consideration change.",
    bookRates: [{ bookId: f.org.bookId, fxRate: "1" }],
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
            description: "Amended offset service",
            standaloneSellingPrice: "3000",
            recognitionRuleId: f.ruleId,
            recognitionEndsOn: "2026-03-31",
            percentComplete: "0",
            deferredAccountId: f.org.accounts.deferred,
            recognizedAccountId: f.org.accounts.recognized,
          },
        ],
      },
    ],
  };
}

async function approve(f: Fixture, id: string) {
  await submitFinancialChange(f.org.orgId, id, f.actors.submitterId);
  const gate = (
    await db.execute<{ id: string }>(
      sql`select id from flow_gates where org_id=${f.org.orgId} and subject_id=${id} and status='pending'`,
    )
  ).rows[0];
  assert.ok(gate);
  await decideGate({
    gateId: gate.id,
    userId: f.actors.approver1Id,
    decision: "approved",
  });
}

async function earned(f: Fixture) {
  const row = (
    await db.execute<{ amount: string }>(
      sql`select coalesce(-sum(l.amount),0)::text as amount from journal_lines l join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=${f.org.orgId} and l.account_id=${f.org.accounts.recognized} and e.status in('posted','reversed')`,
    )
  ).rows[0]!;
  return toUnits(row.amount);
}

async function amend(f: Fixture, effectiveOn: string) {
  const { changeId } = await proposeRevenueModification(
    f.org.orgId,
    f.contractId,
    f.actors.submitterId,
    proposal(f, effectiveOn),
  );
  await approve(f, changeId);
  await applyRevenueModification(f.org.orgId, changeId, f.actors.submitterId);
}

test(
  "point-in-time with a 20-day offset accrues nothing before the event date",
  { skip: !DB },
  async () =>
    fixture("point_in_time", async (f) => {
      await amend(f, "2026-03-10");
      assert.equal(await earned(f), toUnits("0"));
    }),
);

test(
  "point-in-time with a 20-day offset accrues the full amount on the event date",
  { skip: !DB },
  async () =>
    fixture("point_in_time", async (f) => {
      await amend(f, "2026-03-21");
      assert.equal(await earned(f), toUnits("3000"));
    }),
);

test(
  "daily straight-line with a 20-day offset accrues nothing before service starts",
  { skip: !DB },
  async () =>
    fixture("straight_line_daily", async (f) => {
      await amend(f, "2026-03-10");
      assert.equal(await earned(f), toUnits("0"));
    }),
);

test(
  "daily straight-line with a 20-day offset accrues only post-offset days",
  { skip: !DB },
  async () =>
    fixture("straight_line_daily", async (f) => {
      await amend(f, "2026-03-25");
      // 4 elapsed days (Mar 21-25) of the 11-day Mar 21-31 service window.
      assert.equal(await earned(f), toUnits("1090.9091"));
    }),
);
