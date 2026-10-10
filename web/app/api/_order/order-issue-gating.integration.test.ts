import { documentRevisionCounterSql } from "@openbooks/engine/src/records/revision.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Estimate Issue must emit the native submit event and consult the Flow gate
// exactly as purchase orders do: an applicable on_submit flow owns the Issue
// (pending approval with a run and a gate), while no applicable flow issues
// straight through. Approvals are optional Flows — never a second engine.

const stateKey = Symbol.for("openbooks.order-issue-gating-test");
interface GateState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const gateState: GateState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = gateState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.order-issue-gating-test')]
  export async function guardFeaturePermission() {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../../../lib/feature-gates" &&
      context.parentURL?.includes("/api/_order/handlers")
    ) {
      return { url: "mock:order-issue-gating-feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:order-issue-gating-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { makePATCH } = await import("./handlers.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedApprovalFlow, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const PATCH = makePATCH({ kind: "quote", readPerm: "ar.read", createPerm: "ar.create" });

interface Fixture {
  orgId: string;
  actorId: string;
  approverId: string;
  orderId: string;
}

async function seedDraftQuote(tag: string, total: string): Promise<Fixture> {
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    const actors = await seedFlowActors(org.orgId);
    const orderId = randomUUID();
    await db.execute(sql`
      insert into documents(
        id, org_id, kind, document_number, document_date, party_id, subsidiary_id,
        currency, status, subtotal, tax_total, total, memo, created_by
      ) values (
        ${orderId}, ${org.orgId}, 'quote', ${tag}, ${org.date}, ${org.customerId},
        ${org.subsidiaryId}, 'CAD', 'draft', ${total}, 0, ${total}, 'Gating terms', ${actors.submitterId}
      )
    `);
    return { orgId: org.orgId, actorId: actors.submitterId, approverId: actors.approver1Id, orderId };
  });
}

async function seedThresholdFlow(orgId: string, approverId: string): Promise<void> {
  await withBypassContext(async () => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "quote",
      assignees: [{ type: "user", userId: approverId }],
      mode: "any",
      condition: { field: "total", op: "gt", value: 2500 },
    });
  });
}

async function issueRequest(fixture: Fixture): Promise<Request> {
  gateState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    allowedSubsidiaryIds: null,
  };
  const revision = await withOrgContext(fixture.orgId, async () =>
    (await db.execute<{ revision: string }>(sql`
      select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
        from documents where id = ${fixture.orderId}`)).rows[0]!.revision);
  return new Request(`http://openbooks.test/api/quotes/${fixture.orderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedUpdatedAt: revision, status: "approved" }),
  });
}

async function docStatus(orgId: string, orderId: string): Promise<string> {
  const rows = await withOrgContext(orgId, async () =>
    (await db.execute<{ status: string }>(sql`
      select status from documents where id = ${orderId}`)).rows);
  return rows[0]!.status;
}

async function runCount(orgId: string, orderId: string): Promise<number> {
  const rows = await withBypassContext(async () =>
    (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from flow_runs where org_id = ${orgId} and subject_id = ${orderId}`)).rows);
  return rows[0]!.n;
}

async function pendingGateCount(orgId: string, orderId: string): Promise<number> {
  const rows = await withBypassContext(async () =>
    (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from flow_gates
       where org_id = ${orgId} and subject_id = ${orderId} and status = 'pending'`)).rows);
  return rows[0]!.n;
}

test("issuing an estimate over the flow threshold gates with a run and a gate", async () => {
  const fixture = await seedDraftQuote("EST-OVER", "15540.00");
  try {
    await seedThresholdFlow(fixture.orgId, fixture.approverId);
    const response = await withOrgContext(fixture.orgId, async () => PATCH(await issueRequest(fixture), {
      params: Promise.resolve({ id: fixture.orderId }),
    }));
    assert.equal(response.status, 202, `gated issue must answer 202: ${JSON.stringify(await response.json())}`);
    assert.equal(await docStatus(fixture.orgId, fixture.orderId), "pending_approval");
    assert.equal(await runCount(fixture.orgId, fixture.orderId), 1, "one flow run records the gating");
    assert.equal(await pendingGateCount(fixture.orgId, fixture.orderId), 1, "one pending gate holds the estimate");
  } finally {
    gateState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("issuing an estimate under the flow threshold issues directly", async () => {
  const fixture = await seedDraftQuote("EST-UNDER", "100.00");
  try {
    await seedThresholdFlow(fixture.orgId, fixture.approverId);
    const response = await withOrgContext(fixture.orgId, async () => PATCH(await issueRequest(fixture), {
      params: Promise.resolve({ id: fixture.orderId }),
    }));
    assert.equal(response.status, 200, `ungated issue must answer 200: ${JSON.stringify(await response.json())}`);
    assert.equal(await docStatus(fixture.orgId, fixture.orderId), "approved");
    assert.equal(await runCount(fixture.orgId, fixture.orderId), 0, "an unmet condition creates no run");
  } finally {
    gateState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("issuing an estimate with no flow issues directly", async () => {
  const fixture = await seedDraftQuote("EST-NOFLOW", "15540.00");
  try {
    const response = await withOrgContext(fixture.orgId, async () => PATCH(await issueRequest(fixture), {
      params: Promise.resolve({ id: fixture.orderId }),
    }));
    assert.equal(response.status, 200, `flow-less issue must answer 200: ${JSON.stringify(await response.json())}`);
    assert.equal(await docStatus(fixture.orgId, fixture.orderId), "approved");
    assert.equal(await runCount(fixture.orgId, fixture.orderId), 0, "no flow means no runs");
  } finally {
    gateState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});
