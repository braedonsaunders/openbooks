import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { readBomPolicyVersion, saveBomPolicy } from "../inventory/bom-policy.ts";
import { submitBomRevision } from "./financial-changes-adapter.ts";
import { createManufacturingOperator } from "../testing/manufacturing.ts";
import {
  worklistApprovals,
  worklistApprovalsCount,
  worklistApprovalsPage,
  type WorklistPageScope,
} from "./approval-worklist.ts";
import { createDelegation, revokeDelegation } from "./delegations.ts";
import { submitForApproval, submitAndReleaseIfUngated } from "./submit.ts";
import { submitBudgetScenario } from "./budget-submission.ts";
import { decideGate } from "./gates.ts";
import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
import { OUTBOUND_PAYMENT_RUN_SUBJECT_KIND } from "./payment-runs-adapter.ts";
import { submitPaymentRun } from "../payments/operations.ts";
import {
  createScratchOrg,
  assertDedicatedFixtureDatabase,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
  grantScratchPermissions,
} from "../testing/fixtures.ts";

/** Native gates are the sole approval population across lists and badges. */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function assertCountMatchesWorklist(
  orgId: string,
  userId: string,
  scope: WorklistPageScope,
): Promise<number> {
  const count = await worklistApprovalsCount(orgId, userId, scope);
  const page = await worklistApprovalsPage(orgId, userId, scope, { limit: 1, offset: 0 });
  assert.equal(count, page.total, "badge and paged worklist count the same scoped union");
  const items = await worklistApprovals(orgId, userId, scope);
  const visible = scope.includeFlows === false ? [] : items;
  assert.equal(count, visible.length, "count includes every visible item without the page limit");
  return count;
}

/** A payment run submitted into its approval flow by `submitterId`. */
async function seedSubmittedRun(
  orgId: string,
  bankId: string,
  submitterId: string,
): Promise<string> {
  const formatId = randomUUID();
  const profileId = randomUUID();
  const runId = randomUUID();
  await db.execute(sql`
    insert into payment_formats
      (id, org_id, code, name, rail, direction, file_extension, content_type, created_by, updated_by)
    values (${formatId}, ${orgId}, 'W7-WIRE', 'Worklist wire', 'wire', 'credit', 'txt', 'text/plain',
            ${submitterId}, ${submitterId})`);
  await db.execute(sql`
    insert into payment_bank_profiles
      (id, org_id, name, bank_account_id, payment_format_id, currency, created_by, updated_by)
    values (${profileId}, ${orgId}, 'Worklist profile', ${bankId}, ${formatId}, 'CAD', ${submitterId}, ${submitterId})`);
  await db.execute(sql`
    insert into payment_runs
      (id, org_id, run_number, bank_account_id, payment_bank_profile_id, method,
       direction, purpose, currency, status, payment_count, total_amount, created_by, updated_by)
    values (${runId}, ${orgId}, 'W7-RUN', ${bankId}, ${profileId}, 'wire',
            'outbound', 'vendor_payments', 'CAD', 'draft', 1, '250.0000', ${submitterId}, ${submitterId})`);
  const submitted = await submitPaymentRun(runId, orgId, submitterId);
  assert.equal(submitted.gated, true);
  return runId;
}

test(
  "worklist lists configured document and payment gates once and honors live delegation and scope",
  { skip: !DB },
  async () => {
    await assertDedicatedFixtureDatabase();
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const zero = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitAndReleaseIfUngated("vendor_bill", zero, actors.submitterId);
      for (const kind of ["vendor_bill", OUTBOUND_PAYMENT_RUN_SUBJECT_KIND])
        await seedApprovalFlow(org.orgId, {
          subjectKind: kind,
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "any",
        });
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitForApproval("vendor_bill", id, actors.submitterId);
      const run = await seedSubmittedRun(org.orgId, org.accounts.bank, actors.submitterId);
      const scope = {
        roles: ["approver"],
        allowedSubsidiaryIds: null,
      };
      const items = await worklistApprovals(org.orgId, actors.approver1Id, scope);
      assert.deepEqual(new Set(items.map((item) => item.gate.subjectId)), new Set([id, run]));
      assert.ok(items.every((item) => item.kind === "flow_gate"));
      assert.equal(await assertCountMatchesWorklist(org.orgId, actors.approver1Id, scope), 2);
      assert.equal(
        await assertCountMatchesWorklist(org.orgId, actors.approver1Id, {
          ...scope,
          allowedSubsidiaryIds: new Set<string>(),
        }),
        0,
      );
      assert.equal(
        await assertCountMatchesWorklist(org.orgId, actors.submitterId, {
          roles: ["accountant"],
          allowedSubsidiaryIds: null,
        }),
        0,
      );
      const now = Date.now();
      const delegate = () =>
        createDelegation({
          orgId: org.orgId,
          fromUserId: actors.approver1Id,
          toUserId: actors.approver2Id,
          startsAt: new Date(now - 60000),
          endsAt: new Date(now + 3600000),
          reason: "Approval coverage",
        });
      const first = await delegate();
      const second = await delegate();
      assert.equal(
        await assertCountMatchesWorklist(org.orgId, actors.approver2Id, scope),
        2,
        "overlapping delegations do not duplicate gates",
      );
      await revokeDelegation(org.orgId, first.delegation.id, actors.approver1Id);
      assert.equal(await assertCountMatchesWorklist(org.orgId, actors.approver2Id, scope), 2);
      await revokeDelegation(org.orgId, second.delegation.id, actors.approver1Id);
      assert.equal(await assertCountMatchesWorklist(org.orgId, actors.approver2Id, scope), 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

async function seedBudget(
  orgId: string,
  bookId: string,
  periodId: string,
  accountId: string,
  submitterId: string,
  name: string,
) {
  const id = randomUUID();
  await db.execute(sql`insert into budget_scenarios(id,org_id,book_id,fiscal_year,name,kind,status,created_by,updated_by)
   values(${id},${orgId},${bookId},2026,${name},'budget','draft',${submitterId},${submitterId})`);
  await db.execute(sql`insert into budget_lines(org_id,scenario_id,account_id,period_id,amount,created_by,updated_by)
   values(${orgId},${id},${accountId},${periodId},'140000.0000',${submitterId},${submitterId})`);
  const row = (
    await db.execute<{ revision: number }>(
      sql`select revision from budget_scenarios where org_id=${orgId} and id=${id}`,
      "objects",
    )
  )[0]!;
  await submitBudgetScenario(orgId, submitterId, id, row.revision);
  return id;
}

test(
  "budgets use the same Flow population and all configured gates before release",
  { skip: !DB },
  async () => {
    await assertDedicatedFixtureDatabase();
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"budgets":true}'::jsonb) where id=${org.orgId}`,
      );
      const scope = {
        roles: ["approver"],
        allowedSubsidiaryIds: null,
      };
      const zero = await seedBudget(
        org.orgId,
        org.bookId,
        org.periodId,
        org.accounts.revenue,
        actors.submitterId,
        "Immediate operating budget",
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from budget_scenarios where org_id=${org.orgId} and id=${zero}`,
            "objects",
          )
        )[0]?.status,
        "approved",
      );
      assert.equal(await assertCountMatchesWorklist(org.orgId, actors.approver1Id, scope), 0);
      for (let i = 0; i < 2; i++)
        await seedApprovalFlow(org.orgId, {
          subjectKind: "budget_scenario",
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "all",
        });
      const id = await seedBudget(
        org.orgId,
        org.bookId,
        org.periodId,
        org.accounts.revenue,
        actors.submitterId,
        "Reviewed operating budget",
      );
      const items = await worklistApprovals(org.orgId, actors.approver1Id, scope);
      assert.equal(items.length, 2);
      assert.ok(items.every((item) => item.gate.subjectId === id));
      assert.equal(await assertCountMatchesWorklist(org.orgId, actors.approver1Id, scope), 2);
      assert.equal(
        await assertCountMatchesWorklist(org.orgId, actors.approver1Id, {
          ...scope,
          includeFlows: false,
        }),
        0,
      );
      await decideGate({
        gateId: items[0]!.id,
        userId: actors.approver1Id,
        decision: "approved",
      });
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from budget_scenarios where org_id=${org.orgId} and id=${id}`,
            "objects",
          )
        )[0]?.status,
        "pending_approval",
      );
      assert.equal(await assertCountMatchesWorklist(org.orgId, actors.approver1Id, scope), 1);
      await decideGate({
        gateId: items[1]!.id,
        userId: actors.approver1Id,
        decision: "approved",
      });
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from budget_scenarios where org_id=${org.orgId} and id=${id}`,
            "objects",
          )
        )[0]?.status,
        "approved",
      );
      assert.equal(await assertCountMatchesWorklist(org.orgId, actors.approver1Id, scope), 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("inbox text search matches non-document subject labels", { skip: !DB }, async () => {
  await assertDedicatedFixtureDatabase();
  const org = await createScratchOrg();
  function run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return withOrgTransaction(org.orgId, () => work(db));
  }
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const gatedId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
      number: "VB-SEARCH-1",
    });
    const submitted = await submitForApproval("vendor_bill", gatedId, actors.submitterId);
    assert.equal(submitted.gated, true);
    await grantScratchPermissions(org.orgId, actors.approver1Id, ["manufacturing.manage"]);
    // A pending recipe revision for FG-GUJI through its own approval flow.
    await withBypassContext(async () => {
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true,"warehousing":true}'::jsonb) where id=${org.orgId}`,
      );
      await db.execute(
        sql`update items set code='FG-GUJI', name='Guji Widget' where org_id=${org.orgId} and id=${org.items.assembly}`,
      );
    });
    const maker = await withBypassContext(() =>
      createManufacturingOperator(org.orgId, "Shop lead"),
    );
    await withBypassContext(() =>
      seedApprovalFlow(org.orgId, {
        subjectKind: "financial_change",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      }),
    );
    await run((tx) => businessTodayInTx(tx, org.orgId));
    const version = await run((tx) => readBomPolicyVersion(tx, org.orgId, org.items.assembly));
    const proposal = await run((tx) =>
      saveBomPolicy(tx, org.orgId, maker, {
        assemblyItemId: org.items.assembly,
        expectedVersion: version,
        reason: "Approve the next material requirement",
        subsidiaryId: org.subsidiaryId,
        requestKey: randomUUID(),
        components: [
          {
            componentItemId: org.items.component,
            quantityPer: "2",
            effectiveFrom: null,
            effectiveTo: null,
            operationSeq: null,
            scrapPct: null,
            isByproduct: false,
          },
        ],
      }),
    );
    assert.ok("changeId" in proposal);
    await withBypassContext(() => submitBomRevision(org.orgId, maker, proposal.changeId as string));
    const scope: WorklistPageScope = { roles: ["approver"], allowedSubsidiaryIds: null };
    // By assembly SKU.
    let page = await worklistApprovalsPage(org.orgId, actors.approver1Id, scope, {
      limit: 25,
      offset: 0,
      query: "FG-GUJI",
    });
    const bomGate = (items: typeof page.items) =>
      items.find(
        (item) => item.kind === "flow_gate" && item.gate.subjectKind === "financial_change",
      );
    assert.ok(bomGate(page.items), "a pending recipe revision is found by its assembly SKU");
    assert.equal(page.total, 1, "the SKU search counts exactly the matching gate");
    const hit = bomGate(page.items);
    assert.equal(hit?.kind === "flow_gate" ? hit.gate.subjectLabel : null, "FG-GUJI — Guji Widget");
    // By item name, case-insensitively.
    page = await worklistApprovalsPage(org.orgId, actors.approver1Id, scope, {
      limit: 25,
      offset: 0,
      query: "guji widget",
    });
    assert.ok(bomGate(page.items), "a pending recipe revision is found by its item name");
    assert.equal(page.total, 1);
    // A document gate is still found by its number, without the recipe gate.
    page = await worklistApprovalsPage(org.orgId, actors.approver1Id, scope, {
      limit: 25,
      offset: 0,
      query: "vb-search-1",
    });
    assert.ok(
      page.items.some((item) => item.kind === "flow_gate" && item.gate.subjectId === gatedId),
      "a document gate is found by its number",
    );
    assert.ok(!bomGate(page.items), "the recipe revision does not match the document number");
    // A non-matching query returns nothing on rows and counts alike.
    page = await worklistApprovalsPage(org.orgId, actors.approver1Id, scope, {
      limit: 25,
      offset: 0,
      query: "no-such-subject-zzz",
    });
    assert.deepEqual(page.items, []);
    assert.equal(page.total, 0);
    // The unfiltered union still carries both gates.
    page = await worklistApprovalsPage(org.orgId, actors.approver1Id, scope, {
      limit: 25,
      offset: 0,
    });
    assert.equal(page.total, 2);
    assert.ok(
      bomGate(page.items) &&
        page.items.some((item) => item.kind === "flow_gate" && item.gate.subjectId === gatedId),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
