import { installEngineSeams } from "@openbooks/engine/composition/install";
installEngineSeams();
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../lib/auth";
import { sql } from "drizzle-orm";

// Estimate Issue must emit the native submit event and consult the Flow gate
// exactly as purchase orders do: an applicable on_submit flow owns the Issue
// (pending approval with a run and a gate), while no applicable flow issues
// straight through. Approvals are optional Flows — never a second engine.

// The real route resolves the caller from the session exactly as in
// production: the test supplies only the signed-in identity, and the user's
// roles grant its permissions and subsidiary scope.
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __orderIssueGatingSession: session });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__orderIssueGatingSession.user}",
      };
    }
    return nextResolve(specifier, context);
  },
});

function signIn(orgId: string, userId: string): void {
  session.user = {
    id: userId,
    orgId,
    name: "Order editor",
    email: "order-editor@scratch.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
}

const { PATCH } = await import("../estimates/[id]/route.ts");

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedApprovalFlow, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");

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
    return {
      orgId: org.orgId,
      actorId: actors.submitterId,
      approverId: actors.approver1Id,
      orderId,
    };
  });
}

async function seedThresholdFlow(orgId: string, approverId: string): Promise<void> {
  await withBypassContext(async () => {
    await seedApprovalFlow(orgId, {
      subjectKind: "quote",
      assignees: [{ type: "user", userId: approverId }],
      mode: "any",
      condition: { field: "total", op: "gt", value: 2500 },
    });
  });
}

async function issueRequest(fixture: Fixture): Promise<Request> {
  signIn(fixture.orgId, fixture.actorId);
  const revision = await withOrgContext(
    fixture.orgId,
    async () =>
      (
        await db.execute<{ revision: string }>(
          sql`
      select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
        from documents where id = ${fixture.orderId}`,
          "objects",
        )
      )[0]!.revision,
  );
  return new Request(`http://openbooks.test/api/quotes/${fixture.orderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedUpdatedAt: revision, status: "approved" }),
  });
}

async function docStatus(orgId: string, orderId: string): Promise<string> {
  const rows = await withOrgContext(
    orgId,
    async () =>
      await db.execute<{ status: string }>(
        sql`
      select status from documents where id = ${orderId}`,
        "objects",
      ),
  );
  return rows[0]!.status;
}

async function runCount(orgId: string, orderId: string): Promise<number> {
  const rows = await withBypassContext(
    async () =>
      await db.execute<{ n: number }>(
        sql`
      select count(*)::int as n from flow_runs where org_id = ${orgId} and subject_id = ${orderId}`,
        "objects",
      ),
  );
  return rows[0]!.n;
}

async function pendingGateCount(orgId: string, orderId: string): Promise<number> {
  const rows = await withBypassContext(
    async () =>
      await db.execute<{ n: number }>(
        sql`
      select count(*)::int as n from flow_gates
       where org_id = ${orgId} and subject_id = ${orderId} and status = 'pending'`,
        "objects",
      ),
  );
  return rows[0]!.n;
}

test("issuing an estimate over the flow threshold gates with a run and a gate", async () => {
  const fixture = await seedDraftQuote("EST-OVER", "15540.00");
  try {
    await seedThresholdFlow(fixture.orgId, fixture.approverId);
    const response = await withOrgContext(fixture.orgId, async () =>
      PATCH(await issueRequest(fixture), {
        params: Promise.resolve({ id: fixture.orderId }),
      }),
    );
    assert.equal(
      response.status,
      202,
      `gated issue must answer 202: ${JSON.stringify(await response.json())}`,
    );
    assert.equal(await docStatus(fixture.orgId, fixture.orderId), "pending_approval");
    assert.equal(
      await runCount(fixture.orgId, fixture.orderId),
      1,
      "one flow run records the gating",
    );
    assert.equal(
      await pendingGateCount(fixture.orgId, fixture.orderId),
      1,
      "one pending gate holds the estimate",
    );
  } finally {
    session.user = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("issuing an estimate under the flow threshold issues directly", async () => {
  const fixture = await seedDraftQuote("EST-UNDER", "100.00");
  try {
    await seedThresholdFlow(fixture.orgId, fixture.approverId);
    const response = await withOrgContext(fixture.orgId, async () =>
      PATCH(await issueRequest(fixture), {
        params: Promise.resolve({ id: fixture.orderId }),
      }),
    );
    assert.equal(
      response.status,
      200,
      `ungated issue must answer 200: ${JSON.stringify(await response.json())}`,
    );
    assert.equal(await docStatus(fixture.orgId, fixture.orderId), "approved");
    assert.equal(
      await runCount(fixture.orgId, fixture.orderId),
      0,
      "an unmet condition creates no run",
    );
  } finally {
    session.user = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("issuing an estimate with no flow issues directly", async () => {
  const fixture = await seedDraftQuote("EST-NOFLOW", "15540.00");
  try {
    const response = await withOrgContext(fixture.orgId, async () =>
      PATCH(await issueRequest(fixture), {
        params: Promise.resolve({ id: fixture.orderId }),
      }),
    );
    assert.equal(
      response.status,
      200,
      `flow-less issue must answer 200: ${JSON.stringify(await response.json())}`,
    );
    assert.equal(await docStatus(fixture.orgId, fixture.orderId), "approved");
    assert.equal(await runCount(fixture.orgId, fixture.orderId), 0, "no flow means no runs");
  } finally {
    session.user = null;
    await dropScratchOrg(fixture.orgId);
  }
});
