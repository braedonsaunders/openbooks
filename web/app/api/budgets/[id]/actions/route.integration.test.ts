import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../../../lib/auth";

const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __budgetActionsUser: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier === "./auth" || specifier.endsWith("/lib/auth")) &&
      context.parentURL?.endsWith("/web/lib/authz.ts")
    ) {
      return virtual(
        "export async function currentUser(){return globalThis.__budgetActionsUser.user}",
      );
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg, seedApprovalFlow } =
  await import("@openbooks/engine/testing/fixtures");
const { POST } = await import("./route");
const { installEngineSeams } = await import("@openbooks/engine/composition/install");
const { decideGate } = await import("@openbooks/engine/testing/flows/gates");
installEngineSeams();

const request = (id: string, body: unknown) =>
  new Request(`http://budget.local/api/budgets/${id}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function asUser(id: string, orgId: string, name: string): SessionUser {
  return {
    id,
    orgId,
    name,
    email: `${name}@scratch.test`,
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: id,
  };
}

async function scenarioState(orgId: string, id: string) {
  return withBypassContext(
    async () =>
      (
        await db.execute<{
          status: string;
          revision: number;
          submitted_by: string | null;
          approved_by: string | null;
        }>(
          sql`
      select status, revision, submitted_by, approved_by from budget_scenarios where id = ${id} and org_id = ${orgId}`,
          "objects",
        )
      )[0]!,
  );
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const manager = await withBypassContext(() =>
    createScratchUser(org.orgId, "Budget manager", "budget_manager"),
  );
  const approver = await withBypassContext(() =>
    createScratchUser(org.orgId, "Budget approver", "budget_approver"),
  );
  await withBypassContext(async () => {
    await db.execute(
      sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'), '{features,budgets}', 'true') where id = ${org.orgId}`,
    );
    await db.execute(
      sql`update app_roles set permissions = '["budgets.read","budgets.manage","budgets.approve"]'::jsonb where org_id = ${org.orgId} and key = 'budget_manager'`,
    );
    await db.execute(
      sql`update app_roles set permissions = '["budgets.read","budgets.approve"]'::jsonb where org_id = ${org.orgId} and key = 'budget_approver'`,
    );
  });
  async function draft(withLines = true) {
    const id = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into budget_scenarios (id,org_id,book_id,fiscal_year,name,kind,status,created_by,updated_by)
        values (${id},${org.orgId},${org.bookId},2026,${"Operating " + id},'budget','draft',${manager},${manager})`);
      if (withLines)
        await db.execute(sql`insert into budget_lines (org_id,scenario_id,account_id,period_id,amount,created_by,updated_by)
        values (${org.orgId},${id},${org.accounts.revenue},${org.periodId},'-900.0000',${manager},${manager})`);
    });
    return id;
  }
  async function submit(id: string, expectedRevision = 1) {
    state.user = asUser(manager, org.orgId, "manager");
    return withOrgContext(org.orgId, () =>
      POST(request(id, { action: "submit", expectedRevision }), params(id)),
    );
  }
  async function pendingGate(id: string) {
    return withBypassContext(async () => {
      const rows = await db.execute<{ id: string }>(
        sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${id} and status='pending'`,
        "objects",
      );
      assert.equal(rows.length, 1);
      return rows[0]!.id;
    });
  }
  return { org, manager, approver, draft, submit, pendingGate };
}

test("budget submission without a configured gate releases once and refuses a stale retry", async () => {
  const f = await fixture();
  try {
    const id = await f.draft();
    const response = await f.submit(id);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { revision: 3, status: "approved" });
    assert.equal((await scenarioState(f.org.orgId, id)).approved_by, f.manager);
    assert.equal((await f.submit(id)).status, 409);
    assert.equal((await scenarioState(f.org.orgId, id)).revision, 3);
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test("budget gates approve or reject through Flows with assignment, revision and audit protection", async () => {
  const f = await fixture();
  try {
    await withBypassContext(() =>
      seedApprovalFlow(f.org.orgId, {
        subjectKind: "budget_scenario",
        assignees: [{ type: "user", userId: f.approver }],
        mode: "all",
        preventSelfApproval: true,
      }),
    );
    const id = await f.draft();
    const submitted = await f.submit(id);
    assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()));
    assert.deepEqual(await submitted.json(), { revision: 2, status: "pending_approval" });
    assert.equal((await f.submit(id, 2)).status, 409);
    const gateId = await f.pendingGate(id);
    await assert.rejects(
      () =>
        withOrgContext(f.org.orgId, () =>
          decideGate({ gateId, userId: f.manager, decision: "approved" }),
        ),
      /not an approver/,
    );
    assert.equal((await scenarioState(f.org.orgId, id)).status, "pending_approval");
    await withOrgContext(f.org.orgId, () =>
      decideGate({ gateId, userId: f.approver, decision: "approved" }),
    );
    assert.equal((await scenarioState(f.org.orgId, id)).approved_by, f.approver);
    assert.equal((await scenarioState(f.org.orgId, id)).revision, 3);
    await assert.rejects(
      () =>
        withOrgContext(f.org.orgId, () =>
          decideGate({ gateId, userId: f.approver, decision: "approved" }),
        ),
      /already resolved/,
    );

    const rejectedId = await f.draft();
    assert.equal((await f.submit(rejectedId)).status, 200);
    const reason = "Reduce operating expense assumptions before resubmission.";
    await withOrgContext(f.org.orgId, async () =>
      decideGate({
        gateId: await f.pendingGate(rejectedId),
        userId: f.approver,
        decision: "rejected",
        comment: reason,
      }),
    );
    const rejected = await scenarioState(f.org.orgId, rejectedId);
    assert.equal(rejected.status, "draft");
    assert.equal(rejected.submitted_by, null);
    assert.equal(rejected.revision, 3);
    const evidence = await withBypassContext(() =>
      db.execute<{ actor_id: string; changes: Record<string, unknown> }>(
        sql`select actor_id,changes from audit_log where org_id=${f.org.orgId} and table_name='budget_scenarios' and row_id=${rejectedId} and changes->>'event'='rejected'`,
        "objects",
      ),
    );
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]!.actor_id, f.approver);
    assert.equal(evidence[0]!.changes.comment, reason);
    assert.equal(evidence[0]!.changes.mode, "gated");
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test("submitting an empty budget returns an actionable refusal and preserves the draft", async () => {
  const f = await fixture();
  try {
    const id = await f.draft(false);
    const refused = await f.submit(id);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), {
      error: "Add at least one nonzero budget line before submitting.",
    });
    assert.equal((await scenarioState(f.org.orgId, id)).status, "draft");
    assert.equal((await scenarioState(f.org.orgId, id)).revision, 1);
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test("the tenant Flow chooses whether a budget maker may approve", async () => {
  for (const preventSelfApproval of [true, false]) {
    const f = await fixture();
    try {
      await withBypassContext(() =>
        seedApprovalFlow(f.org.orgId, {
          subjectKind: "budget_scenario",
          assignees: [
            { type: "user", userId: f.manager },
            { type: "user", userId: f.approver },
          ],
          mode: "any",
          preventSelfApproval,
        }),
      );
      const id = await f.draft();
      const response = await f.submit(id);
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      const gates = await withBypassContext(() =>
        db.execute<{ id: string; assignee_user_id: string }>(
          sql`select id,assignee_user_id from flow_gates where org_id=${f.org.orgId} and subject_id=${id} and status='pending'`,
          "objects",
        ),
      );
      if (preventSelfApproval) {
        assert.ok(gates.every((gate) => gate.assignee_user_id !== f.manager));
        assert.equal((await scenarioState(f.org.orgId, id)).status, "pending_approval");
        await withOrgContext(f.org.orgId, () =>
          decideGate({ gateId: gates[0]!.id, userId: f.approver, decision: "approved" }),
        );
      } else {
        const own = gates.find((gate) => gate.assignee_user_id === f.manager);
        assert.ok(own);
        await withOrgContext(f.org.orgId, () =>
          decideGate({ gateId: own.id, userId: f.manager, decision: "approved" }),
        );
      }
      assert.equal((await scenarioState(f.org.orgId, id)).status, "approved");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  }
});
