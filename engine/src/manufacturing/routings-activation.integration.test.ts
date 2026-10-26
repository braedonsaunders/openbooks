import { before } from "node:test";
import { createManufacturingOperator, createWorkOperator } from "../testing/manufacturing.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { ManufacturingError } from "./errors.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";

import { createWorkCenter } from "./work-centers.ts";
import {
  activateRouting,
  createNextRoutingVersion,
  createRouting,
  createRoutingOperation,
  proposeRoutingActivation,
  updateRouting,
} from "./routings.ts";
import { createWorkOrder, releaseWorkOrder } from "./work-orders.ts";
import { manufacturingOptions } from "./workspace.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
type Fixture = { org: ScratchOrg; actorId: string; departmentId: string };
function run<T>(orgId: string, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return withOrgTransaction(orgId, () => work(db));
}

async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() =>
    createManufacturingOperator(org.orgId, "Shop lead"),
  );
  const wipId = randomUUID();
  await withBypassContext(async () => {
    const account = await db.execute(
      sql`insert into accounts
      (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
      values(${wipId},${org.orgId},'1210','Manufacturing WIP','asset_current_other',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true) returning id`,
      "objects",
    );
    assert.equal(account.length, 1);
    const result = await db.execute(
      sql`update orgs set settings=jsonb_set(jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true,"warehousing":true}'::jsonb),'{controlAccounts}',
      coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('mfgWip',${wipId}::text),true) where id=${org.orgId} returning id`,
      "objects",
    );
    assert.equal(result.length, 1);
  });
  const departmentId = String(
    (
      await withBypassContext(() =>
        db.execute(
          sql`insert into departments (org_id, name) values (${org.orgId}, 'Assembly') returning id`,
          "objects",
        ),
      )
    )[0]!.id,
  );
  const rate = await withBypassContext(() =>
    db.execute(
      sql`insert into labor_cost_rates
    (org_id, department_id, currency, rate, basis, annual_hours, effective_from, is_active, created_by, updated_by)
    values (${org.orgId}, ${departmentId}, 'CAD', '0', 'hour', '2080', '2026-01-01', true, ${actorId}, ${actorId}) returning id`,
      "objects",
    ),
  );
  assert.equal(rate.length, 1);
  return { org, actorId, departmentId };
}

async function draftRouting(f: Fixture, itemId: string, from = "2026-01-01", withOperation = true) {
  const code = `WC-${randomUUID()}`;
  const center = await run(f.org.orgId, (tx) =>
    createWorkCenter(tx, f.org.orgId, f.actorId, {
      code,
      name: code,
      kind: "machine",
      capacityHoursPerDay: "8",
      efficiencyPct: "100",
      absorbsOverhead: false,
      departmentId: f.departmentId,
    }),
  );
  const routing = await run(f.org.orgId, (tx) =>
    createRouting(tx, f.org.orgId, f.actorId, {
      producedItemId: itemId,
      code: `RT-${randomUUID()}`,
      name: "Assembly route",
      effectiveFrom: from,
      defaultIssueLocationId: f.org.stockLocationId,
      defaultReceiptLocationId: f.org.stockLocationId2,
      overheadBasis: "units",
    }),
  );
  if (withOperation) {
    await run(f.org.orgId, (tx) =>
      createRoutingOperation(tx, f.org.orgId, f.actorId, String(routing.id), {
        sequence: 10,
        name: "Assemble",
        workCenterId: String(center.id),
        setupMinutes: "5",
        runMinutesPerUnit: "1",
      }),
    );
  }
  return String(routing.id);
}

async function submitRoutingActivation(
  f: Fixture,
  routingId: string,
  reason = "Activate the configured production revision",
) {
  const proposal = await run(f.org.orgId, (tx) =>
    proposeRoutingActivation(tx, f.org.orgId, f.actorId, routingId, {
      subsidiaryId: f.org.subsidiaryId,
      reason,
      idempotencyKey: randomUUID(),
    }),
  );
  await submitFinancialChange(f.org.orgId, proposal.changeId, f.actorId);
  return run(f.org.orgId, (tx) =>
    activateRouting(tx, f.org.orgId, f.actorId, routingId, proposal.changeId),
  );
}

async function rejected(work: Promise<unknown>, code: string, phrase?: string, caseName = "") {
  await assert.rejects(
    work,
    (error: unknown) =>
      error instanceof ManufacturingError &&
      error.code === code &&
      (!phrase || error.message.includes(phrase) || error.remedy?.includes(phrase)) &&
      Boolean(error.remedy?.trim()),
    caseName,
  );
}

test("routing no-flow activation then work-order selection", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const routingId = await draftRouting(f, f.org.items.assembly);
    const before = await run(f.org.orgId, (tx) => manufacturingOptions(tx, f.org.orgId, null));
    assert.equal(
      before.routings.some((row) => row.value === routingId),
      false,
    );
    const after = await submitRoutingActivation(f, routingId);
    assert.equal(after.status, "active");
    const change = await withBypassContext(
      async () =>
        (
          await db.execute<{
            status: string;
            submitted_by: string;
            approved_by: string;
            payload: unknown;
            result: unknown;
          }>(
            sql`select status, submitted_by, approved_by, payload, result from financial_changes where org_id=${f.org.orgId} and subject_id=${routingId} and operation='routing_revision_activation'`,
            "objects",
          )
        )[0],
    );
    assert.equal(change?.status, "applied");
    assert.equal(change?.approved_by, f.actorId);
    assert.equal(change?.submitted_by, f.actorId);
    const decision = (
      change?.payload as { decision?: { mode?: unknown; policy?: { flowConfigured?: unknown } } }
    ).decision;
    assert.equal(decision, undefined, "the native submission receipt owns routing");
    const options = await run(f.org.orgId, (tx) => manufacturingOptions(tx, f.org.orgId, null));
    assert.equal(
      options.routings.some(
        (row) => row.value === routingId && row.parentId === f.org.items.assembly,
      ),
      true,
    );
    const draft = await run(f.org.orgId, (tx) =>
      createWorkOrder(tx, f.org.orgId, f.actorId, {
        producedItemId: f.org.items.assembly,
        routingId,
        quantityOrdered: "1",
        subsidiaryId: f.org.subsidiaryId,
        issueLocationId: f.org.stockLocationId,
        receiptLocationId: f.org.stockLocationId2,
        plannedStart: f.org.date,
      }),
    );
    const released = await run(f.org.orgId, (tx) =>
      releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id),
    );
    assert.equal(released.status, "released");
    assert.equal(released.routingId, routingId);
    assert.equal(released.routingVersion, 1);
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("routing no-flow activation supersedes the prior revision", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const first = await draftRouting(f, f.org.items.assembly, "2026-01-01");
    await submitRoutingActivation(f, first);
    const next = await run(f.org.orgId, (tx) =>
      createNextRoutingVersion(tx, f.org.orgId, f.actorId, first),
    );
    await run(f.org.orgId, (tx) =>
      updateRouting(tx, f.org.orgId, f.actorId, String(next.id), {
        effectiveFrom: "2026-06-01",
        effectiveTo: null,
      }),
    );
    await submitRoutingActivation(f, String(next.id));
    const rows = await withBypassContext(
      async () =>
        await db.execute<{ id: string; status: string; effective_to: string | null }>(
          sql`select id, status, effective_to::text as effective_to from mfg_routings where org_id=${f.org.orgId} and produced_item_id=${f.org.items.assembly} order by version`,
          "objects",
        ),
    );
    assert.deepEqual(
      rows.map((row) => [row.status, row.effective_to]),
      [
        ["active", "2026-06-01"],
        ["active", null],
      ],
    );
    const applied = await withBypassContext(
      async () =>
        await db.execute<{ id: string }>(
          sql`select id from financial_changes where org_id=${f.org.orgId} and subject_id=${String(next.id)} and operation='routing_revision_activation' and status='applied'`,
          "objects",
        ),
    );
    assert.equal(applied.length, 1);
    const supersession = await withBypassContext(
      async () =>
        await db.execute<{
          changes: {
            before: { effectiveTo: string | null };
            after: { effectiveTo: string; approvalChangeId: string };
          };
        }>(
          sql`select changes from audit_log where org_id=${f.org.orgId} and table_name='mfg_routings' and row_id=${first} and action='update' and changes->'after'->>'effectiveTo'='2026-06-01'`,
          "objects",
        ),
    );
    assert.equal(supersession.length, 1);
    assert.equal(supersession[0]!.changes.before.effectiveTo, null);
    assert.equal(supersession[0]!.changes.after.approvalChangeId, applied[0]!.id);
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("flow-governed routing still requires approval", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const approver = await withBypassContext(() =>
      createWorkOperator(f.org.orgId, "Engineering approver", ["manufacturing.manage"]),
    );
    await withBypassContext(() =>
      seedApprovalFlow(f.org.orgId, {
        subjectKind: "financial_change",
        assignees: [{ type: "user", userId: approver }],
        mode: "any",
        preventSelfApproval: true,
      }),
    );
    const routingId = await draftRouting(f, f.org.items.assembly);
    const proposal = await run(f.org.orgId, (tx) =>
      proposeRoutingActivation(tx, f.org.orgId, f.actorId, routingId, {
        subsidiaryId: f.org.subsidiaryId,
        reason: "Approve the configured production revision",
        idempotencyKey: randomUUID(),
      }),
    );
    await submitFinancialChange(f.org.orgId, proposal.changeId, f.actorId);
    const gates = await withBypassContext(async () =>
      db.execute<{ id: string }>(
        sql`select id from flow_gates where org_id=${f.org.orgId} and subject_kind='financial_change' and subject_id=${proposal.changeId} and status='pending'`,
        "objects",
      ),
    );
    assert.equal(gates.length, 1);
    await decideGate({ gateId: gates[0]!.id, userId: approver, decision: "approved" });
    const activated = await run(f.org.orgId, (tx) =>
      activateRouting(tx, f.org.orgId, f.actorId, routingId, proposal.changeId),
    );
    assert.equal(activated.status, "active");
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("routing activation refuses fabricated approval evidence", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const routingId = await draftRouting(f, f.org.items.assembly);
    const proposal = await run(f.org.orgId, (tx) =>
      proposeRoutingActivation(tx, f.org.orgId, f.actorId, routingId, {
        subsidiaryId: f.org.subsidiaryId,
        reason: "Review the production revision",
        idempotencyKey: randomUUID(),
      }),
    );
    await assert.rejects(
      run(f.org.orgId, (tx) =>
        tx.execute(
          sql`update financial_changes set status='approved',approved_by=${f.actorId},approved_at=now() where org_id=${f.org.orgId} and id=${proposal.changeId}`,
        ),
      ),
    );
    const current = await run(f.org.orgId, (tx) =>
      tx.execute<{ status: string }>(
        sql`select status from financial_changes where org_id=${f.org.orgId} and id=${proposal.changeId}`,
        "objects",
      ),
    );
    assert.equal(current[0]?.status, "draft");
    await rejected(
      run(f.org.orgId, (tx) =>
        activateRouting(tx, f.org.orgId, f.actorId, routingId, proposal.changeId),
      ),
      "routing_approval_required",
    );
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test(
  "routing proposal confirm records a submittable change with and without a Flow",
  { skip: !DB },
  async () => {
    const f = await setup();
    try {
      const bare = await draftRouting(f, f.org.items.assembly);
      const proposal = await run(f.org.orgId, (tx) =>
        proposeRoutingActivation(tx, f.org.orgId, f.actorId, bare, {
          subsidiaryId: f.org.subsidiaryId,
          reason: "Approve the configured production revision",
          idempotencyKey: randomUUID(),
        }),
      );
      assert.ok(proposal.changeId);
      await withBypassContext(() =>
        submitFinancialChange(f.org.orgId, proposal.changeId, f.actorId),
      );
      const ready = await run(f.org.orgId, (tx) =>
        tx.execute<{ status: string }>(
          sql`select status from financial_changes where org_id=${f.org.orgId} and id=${proposal.changeId}`,
          "objects",
        ),
      );
      assert.equal(ready[0]?.status, "approved");
      const approver = await withBypassContext(() =>
        createWorkOperator(f.org.orgId, "Engineering approver", ["manufacturing.manage"]),
      );
      await withBypassContext(() =>
        seedApprovalFlow(f.org.orgId, {
          subjectKind: "financial_change",
          assignees: [{ type: "user", userId: approver }],
          mode: "any",
          preventSelfApproval: true,
        }),
      );
      const second = await draftRouting(f, f.org.items.standard);
      const governed = await run(f.org.orgId, (tx) =>
        proposeRoutingActivation(tx, f.org.orgId, f.actorId, second, {
          subsidiaryId: f.org.subsidiaryId,
          reason: "Approve the configured production revision",
          idempotencyKey: randomUUID(),
        }),
      );
      await withBypassContext(() =>
        submitFinancialChange(f.org.orgId, governed.changeId, f.actorId),
      );
      const gates = await withBypassContext(async () =>
        db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${f.org.orgId} and subject_kind='financial_change' and subject_id=${governed.changeId} and status='pending'`,
          "objects",
        ),
      );
      assert.equal(gates.length, 1);
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test("routing proposal and activation refusals retain typed remedies", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const bare = await draftRouting(f, f.org.items.standard, "2026-01-01", false);
    await rejected(
      submitRoutingActivation(f, bare),
      "routing_operations_required",
      "requires operations",
      "activation without operations",
    );
    await rejected(
      run(f.org.orgId, (tx) =>
        proposeRoutingActivation(tx, f.org.orgId, f.actorId, bare, {
          subsidiaryId: f.org.subsidiaryId,
          reason: "short",
          idempotencyKey: randomUUID(),
        }),
      ),
      "routing_proposal_invalid",
      "8–1,000",
      "short reason",
    );
    const routingId = await draftRouting(f, f.org.items.assembly);
    await submitRoutingActivation(f, routingId);
    await rejected(
      submitRoutingActivation(f, routingId),
      "routing_not_draft",
      "Only a draft routing",
      "activation of an active revision",
    );
    const overlapping = await run(f.org.orgId, (tx) =>
      createNextRoutingVersion(tx, f.org.orgId, f.actorId, routingId),
    );
    await rejected(
      submitRoutingActivation(f, String(overlapping.id)),
      "routing_version_overlap",
      "effective-from date after 2026-01-01",
      "successor starting on the predecessor start",
    );
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

// Exercise the same native Flow composition installed by application entry points.
before(async () => {
  const { installEngineSeams } = await import("../composition/install.ts");
  installEngineSeams();
});
