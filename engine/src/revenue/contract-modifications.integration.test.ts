import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
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
  runRevenueRecognition,
  setContractPricing,
} from "./recognition.ts";
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
};
async function fixture(fn: (f: Fixture) => Promise<void>, postJuly = true) {
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
    const contractId = randomUUID(),
      obligationId = randomUUID();
    await db.execute(sql`insert into revenue_contracts(id,org_id,subsidiary_id,customer_id,contract_number,status,starts_on,ends_on,currency,total_transaction_price,created_by,updated_by)
   values(${contractId},${org.orgId},${org.subsidiaryId},${org.customerId},${`MOD-${contractId}`},'active','2026-07-01','2026-09-30','CAD',3000,${actors.submitterId},${actors.submitterId})`);
    await db.execute(sql`insert into performance_obligations(id,org_id,contract_id,description,recognition_rule_id,allocated_price,standalone_selling_price,recognition_starts_on,recognition_ends_on,deferred_account_id,recognized_account_id,status,created_by,updated_by)
   values(${obligationId},${org.orgId},${contractId},'Original service',${org.recognitionRuleId},3000,3000,'2026-07-01','2026-09-30',${org.accounts.deferred},${org.accounts.recognized},'open',${actors.submitterId},${actors.submitterId})`);
    await buildRecognitionSchedule(
      obligationId,
      org.orgId,
      actors.submitterId,
      org.bookId,
    );
    if (postJuly) {
      const r = await runRevenueRecognition(
        org.orgId,
        "2026-07-31",
        actors.submitterId,
        obligationId,
      );
      assert.equal(r.posted, 1);
      assert.deepEqual(r.problems, []);
    }
    await seedApprovalFlow(org.orgId, {
      subjectKind: "financial_change",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
      preventSelfApproval: false,
    });
    await fn({ org, actors, contractId, obligationId });
  } finally {
    await dropScratchOrg(org.orgId);
  }
}
function proposal(
  f: Fixture,
  patch: Partial<RevenueModificationInput> = {},
): RevenueModificationInput {
  return {
    effectiveOn: "2026-08-01",
    reason: "Signed service extension and pricing amendment",
    idempotencyKey: randomUUID(),
    subsidiaryId: f.org.subsidiaryId,
    enforceableRightsEvidence: "Customer and supplier signed amendment A1",
    assessment:
      "Remaining monthly service is distinct; same CAD functional currency; one-third already delivered.",
    bookRates: [{ bookId: f.org.bookId, fxRate: "1" }],
    groups: [
      {
        treatment: "prospective",
        existingObligationIds: [f.obligationId],
        considerationChange: "600",
        remainingDistinct: true,
        additionsAtStandalonePrice: false,
        promises: [
          {
            existingId: f.obligationId,
            description: "Amended service",
            standaloneSellingPrice: "2600",
            recognitionRuleId: f.org.recognitionRuleId,
            recognitionEndsOn: "2026-09-30",
            percentComplete: "33.3333",
            deferredAccountId: f.org.accounts.deferred,
            recognizedAccountId: f.org.accounts.recognized,
          },
        ],
      },
    ],
    ...patch,
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
test(
  "prospective amendment preserves earned history, archives old future rows, survives rebuild and posts exactly once",
  { skip: !DB },
  async () =>
    fixture(async (f) => {
      const old = (
        await db.execute<{
          id: string;
          journal_entry_id: string | null;
          planned_amount: string;
        }>(
          sql`select l.id,l.journal_entry_id,l.planned_amount::text from recognition_schedule_lines l join recognition_schedules s on s.id=l.schedule_id and s.org_id=l.org_id where s.org_id=${f.org.orgId} and s.obligation_id=${f.obligationId} order by sequence`,
        )
      ).rows;
      const input = proposal(f),
        { changeId } = await proposeRevenueModification(
          f.org.orgId,
          f.contractId,
          f.actors.submitterId,
          input,
        );
      await assert.rejects(
        applyRevenueModification(f.org.orgId, changeId, f.actors.submitterId),
        /independent approval/,
      );
      await approve(f, changeId);
      const applied = await applyRevenueModification(
        f.org.orgId,
        changeId,
        f.actors.submitterId,
      );
      assert.equal(applied.newTransactionPrice, "3600.0000");
      assert.equal(await earned(f), toUnits("1000"));
      const retained = (
        await db.execute<{
          id: string;
          journal_entry_id: string | null;
          planned_amount: string;
          superseded_by_change_id: string | null;
        }>(
          sql`select id,journal_entry_id,planned_amount::text,superseded_by_change_id from recognition_schedule_lines where org_id=${f.org.orgId} and id in(select jsonb_array_elements_text(${JSON.stringify(old.map((r) => r.id))}::jsonb)::uuid) order by sequence`,
        )
      ).rows;
      assert.deepEqual(
        retained.map(({ superseded_by_change_id, ...r }) => r),
        old,
      );
      assert.equal(
        retained.filter((r) => r.superseded_by_change_id === changeId).length,
        2,
      );
      await buildRecognitionSchedule(
        f.obligationId,
        f.org.orgId,
        f.actors.submitterId,
        f.org.bookId,
        "2026-08-15",
      );
      const posted = await runRevenueRecognition(
        f.org.orgId,
        "2026-09-30",
        f.actors.submitterId,
        f.obligationId,
      );
      assert.deepEqual(posted.problems, []);
      assert.equal(posted.posted, 2);
      assert.equal(await earned(f), toUnits("3600"));
      assert.deepEqual(
        await applyRevenueModification(
          f.org.orgId,
          changeId,
          f.actors.submitterId,
        ),
        applied,
      );
      assert.equal(
        (
          await proposeRevenueModification(
            f.org.orgId,
            f.contractId,
            f.actors.submitterId,
            input,
          )
        ).changeId,
        changeId,
      );
      await assert.rejects(
        setContractPricing(
          f.org.orgId,
          f.contractId,
          { fixedConsideration: "9000" },
          f.actors.submitterId,
        ),
        /Modify contract/,
      );
    }),
);
for (const [delta, progress, expected] of [
  ["600", "40", "1440"],
  ["-1500", "40", "600"],
])
  test(
    `catch-up ${delta} posts signed adjustment on the effective date, not a rewritten old journal`,
    { skip: !DB },
    async () =>
      fixture(async (f) => {
        const input = proposal(f);
        input.groups[0]!.treatment = "catch_up";
        input.groups[0]!.remainingDistinct = false;
        input.groups[0]!.considerationChange = delta!;
        input.groups[0]!.promises[0]!.percentComplete = progress!;
        const { changeId } = await proposeRevenueModification(
          f.org.orgId,
          f.contractId,
          f.actors.submitterId,
          input,
        );
        await approve(f, changeId);
        await applyRevenueModification(
          f.org.orgId,
          changeId,
          f.actors.submitterId,
        );
        assert.equal(await earned(f), toUnits(expected!));
        const dates = (
          await db.execute<{ posting_date: string }>(
            sql`select posting_date::text from journal_entries where org_id=${f.org.orgId} and origin='revenue_recognition' order by posting_date`,
          )
        ).rows.map((r) => r.posting_date);
        assert.deepEqual(dates, ["2026-07-31", "2026-08-01"]);
        const r = await runRevenueRecognition(
          f.org.orgId,
          "2026-09-30",
          f.actors.submitterId,
          f.obligationId,
        );
        assert.deepEqual(r.problems, []);
        assert.equal(
          await earned(f),
          toUnits(delta === "600" ? "3600" : "1500"),
        );
      }),
  );
test(
  "a separate addition creates a linked contract and leaves original terms and schedule intact",
  { skip: !DB },
  async () =>
    fixture(async (f) => {
      const input = proposal(f),
        g = input.groups[0]!;
      g.treatment = "separate";
      g.existingObligationIds = [];
      g.considerationChange = "900";
      g.additionsAtStandalonePrice = true;
      g.promises[0] = {
        ...g.promises[0]!,
        existingId: undefined,
        standaloneSellingPrice: "900",
        percentComplete: "0",
      };
      const { changeId } = await proposeRevenueModification(
        f.org.orgId,
        f.contractId,
        f.actors.submitterId,
        input,
      );
      await approve(f, changeId);
      const r = await applyRevenueModification(
        f.org.orgId,
        changeId,
        f.actors.submitterId,
      );
      assert.equal(r.newTransactionPrice, "3000.0000");
      assert.equal((r.separateContractIds as string[]).length, 1);
      const remaining = (
        await db.execute<{ amount: string }>(
          sql`select sum(l.planned_amount)::text as amount from recognition_schedule_lines l join recognition_schedules s on s.id=l.schedule_id and s.org_id=l.org_id where s.org_id=${f.org.orgId} and s.obligation_id=${f.obligationId} and l.journal_entry_id is null and l.superseded_by_change_id is null`,
        )
      ).rows[0]!;
      assert.equal(toUnits(remaining.amount), toUnits("2000"));
    }),
);
test(
  "a mid-month prospective amendment first recognizes elapsed service at the old price",
  { skip: !DB },
  async () =>
    fixture(async (f) => {
      const input = proposal(f, { effectiveOn: "2026-07-16" });
      input.groups[0]!.considerationChange = "0";
      const { changeId } = await proposeRevenueModification(
        f.org.orgId,
        f.contractId,
        f.actors.submitterId,
        input,
      );
      await approve(f, changeId);
      await applyRevenueModification(
        f.org.orgId,
        changeId,
        f.actors.submitterId,
      );
      assert.equal(await earned(f), toUnits("483.8710"));
      const r = await runRevenueRecognition(
        f.org.orgId,
        "2026-09-30",
        f.actors.submitterId,
        f.obligationId,
      );
      assert.deepEqual(r.problems, []);
      assert.equal(await earned(f), toUnits("3000"));
    }, false),
);
test(
  "stale approval and out-of-scope actors cannot change an allocation",
  { skip: !DB },
  async () =>
    fixture(async (f) => {
      const { changeId } = await proposeRevenueModification(
        f.org.orgId,
        f.contractId,
        f.actors.submitterId,
        proposal(f),
      );
      await approve(f, changeId);
      await db.execute(
        sql`update performance_obligations set percent_complete=10 where org_id=${f.org.orgId} and id=${f.obligationId}`,
      );
      await assert.rejects(
        applyRevenueModification(f.org.orgId, changeId, f.actors.submitterId),
        /record changed/,
      );
      await assert.rejects(
        proposeRevenueModification(
          f.org.orgId,
          f.contractId,
          f.actors.approver1Id,
          proposal(f),
        ),
        /ar.post/,
      );
      assert.equal(await earned(f), toUnits("1000"));
    }),
);
test(
  "late plan failure rolls back adjustments even when the caller catches inside withOrg",
  { skip: !DB },
  async () =>
    fixture(async (f) => {
      const input = proposal(f);
      input.groups[0]!.treatment = "catch_up";
      input.groups[0]!.remainingDistinct = false;
      input.groups[0]!.promises[0]!.percentComplete = "40";
      input.groups[0]!.promises[0]!.recognitionEndsOn = "2026-10-31";
      const { changeId } = await proposeRevenueModification(
        f.org.orgId,
        f.contractId,
        f.actors.submitterId,
        input,
      );
      await approve(f, changeId);
      await withOrg(f.org.orgId, async () => {
        await assert.rejects(
          applyRevenueModification(f.org.orgId, changeId, f.actors.submitterId),
          /no accounting period/,
        );
      });
      assert.equal(await earned(f), toUnits("1000"));
      const c = (
        await db.execute<{ revision: number }>(
          sql`select revision from revenue_contracts where org_id=${f.org.orgId} and id=${f.contractId}`,
        )
      ).rows[0]!;
      assert.equal(c.revision, 1);
    }),
);
