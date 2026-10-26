import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../../../../lib/auth";

/** Pending bank details use tenant Flows: zero gates apply directly, while
 * gated details remain unusable until every configured reviewer decides. */
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __bankSubmitUser: state });
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
        "export async function currentUser(){return globalThis.__bankSubmitUser.user}",
      );
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { isDocumentRevisionToken } = await import("@openbooks/engine/records/revision");
const { encryptAccountNumber } = await import("@openbooks/engine/payments-core/rail-settings");
const { createScratchOrg, createScratchUser, dropScratchOrg, seedFlowActors, seedApprovalFlow } =
  await import("@openbooks/engine/testing/fixtures");
const { decideGate } = await import("@openbooks/engine/testing/flows/gates");
const { POST: submit } = await import("./route");
const { GET: getParty } = await import("../../route");
const { PATCH: patchAccount } = await import("../route");

const paramsFor = (partyId: string): { params: Promise<{ id: string }> } => ({
  params: Promise.resolve({ id: partyId }),
});
const submitRequest = (partyId: string, accountId: string) =>
  new Request(
    `http://bank.local/api/parties/${partyId}/bank-accounts/submit?accountId=${accountId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );

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

async function runCount(orgId: string, accountId: string): Promise<number> {
  return withBypassContext(async () =>
    Number(
      (
        await db.execute<{ count: string }>(
          sql`select count(*)::text as count from flow_runs where org_id = ${orgId} and subject_id = ${accountId}`,
          "objects",
        )
      )[0]!.count,
    ),
  );
}

test("pending bank details submit into tenant Flows exactly once", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const manager = actors.submitterId;
    const approver = actors.approver1Id;
    await withBypassContext(async () => {
      await db.execute(
        sql`update app_roles set permissions = '["parties.read","parties.manage"]'::jsonb where org_id = ${org.orgId} and key in ('accountant','approver')`,
      );
    });
    const accountId = await seedPendingAccount(org.orgId, org.vendorId, manager, "Initial Bank");
    const params = paramsFor(org.vendorId);
    state.user = asUser(manager, org.orgId, "manager");

    // The stranded precondition: pending, and the engine has never seen it.
    assert.equal(await runCount(org.orgId, accountId), 0);

    // With no enabled flow, the explicit submit applies the details
    // directly (audited) instead of refusing with nowhere to go.
    const noFlow = await withOrgContext(org.orgId, () =>
      submit(submitRequest(org.vendorId, accountId), params),
    );
    assert.equal(noFlow.status, 200, JSON.stringify(await noFlow.clone().json()));
    const directBody = (await noFlow.json()) as {
      id: string;
      approvalStatus: string;
      directApplied?: boolean;
    };
    assert.equal(directBody.id, accountId);
    assert.equal(directBody.approvalStatus, "approved");
    assert.equal(directBody.directApplied, true);
    assert.equal(await runCount(org.orgId, accountId), 0, "direct apply creates no phantom run");
    const directAudit = await withBypassContext(
      async () =>
        (
          await db.execute<{ action: string }>(
            sql`
        select action from audit_log where org_id = ${org.orgId} and table_name = 'party_bank_accounts'
         and row_id = ${accountId} order by id desc limit 1`,
            "objects",
          )
        )[0],
    );
    assert.equal(directAudit?.action, "approve");

    // A second record exercises the flow-driven path below.
    const flowAccountId = await seedPendingAccount(org.orgId, org.vendorId, manager, "Flow Bank");
    const flowParams = paramsFor(org.vendorId);

    // The tenant authors the creation-side flow; submit drives it now.
    await withBypassContext(() =>
      seedApprovalFlow(org.orgId, {
        subjectKind: "party_bank_account",
        trigger: "on_create",
        assignees: [{ type: "user", userId: approver }],
        mode: "any",
      }),
    );
    const submitted = await withOrgContext(org.orgId, () =>
      submit(submitRequest(org.vendorId, flowAccountId), flowParams),
    );
    assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()));
    const submittedBody = (await submitted.json()) as {
      id: string;
      approvalStatus: string;
      runId: string;
      gatesCreated: number;
    };
    assert.equal(submittedBody.id, flowAccountId);
    assert.equal(submittedBody.approvalStatus, "pending");
    assert.equal(submittedBody.gatesCreated, 1);

    // The record is now genuinely in a flow: exactly one live gate.
    const gates = await withBypassContext(
      async () =>
        await db.execute<{ id: string; status: string }>(
          sql`select id, status from flow_gates where org_id = ${org.orgId} and subject_id = ${flowAccountId} order by created_at`,
          "objects",
        ),
    );
    assert.equal(gates.length, 1);
    assert.equal(gates[0]!.status, "pending");

    // A second submit is a lifecycle refusal, not a second gate.
    const resubmit = await withOrgContext(org.orgId, () =>
      submit(submitRequest(org.vendorId, flowAccountId), flowParams),
    );
    assert.equal(resubmit.status, 409, JSON.stringify(await resubmit.clone().json()));
    assert.match(((await resubmit.json()) as { error: string }).error, /already awaiting approval/);
    assert.equal(
      await withBypassContext(
        async () =>
          (
            await db.execute<{ count: string }>(
              sql`select count(*)::text as count from flow_gates where org_id = ${org.orgId} and subject_id = ${flowAccountId} and status = 'pending'`,
              "objects",
            )
          )[0]!.count,
      ),
      "1",
    );

    // The submitted gate approves cleanly through the engine release.
    state.user = asUser(approver, org.orgId, "approver");
    const decision = await withBypassContext(() =>
      decideGate({ gateId: gates[0]!.id, decision: "approved", userId: approver }),
    );
    assert.equal(decision.runStatus, "completed");
    const released = await withBypassContext(
      async () =>
        (
          await db.execute<{ approvalStatus: string; isActive: boolean }>(
            sql`select approval_status as "approvalStatus", is_active as "isActive" from party_bank_accounts where id = ${flowAccountId} and org_id = ${org.orgId}`,
            "objects",
          )
        )[0]!,
    );
    assert.equal(released.approvalStatus, "approved");
    assert.equal(released.isActive, true);

    // An approved record is no longer submittable.
    state.user = asUser(manager, org.orgId, "manager");
    const afterApproval = await withOrgContext(org.orgId, () =>
      submit(submitRequest(org.vendorId, flowAccountId), flowParams),
    );
    assert.equal(afterApproval.status, 422, JSON.stringify(await afterApproval.clone().json()));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("the party payload carries a submittable revision token for bank accounts", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const manager = await withBypassContext(() =>
      createScratchUser(org.orgId, "Token manager", "bank_token_manager"),
    );
    await withBypassContext(async () => {
      await db.execute(
        sql`update app_roles set permissions = '["parties.read","parties.manage"]'::jsonb where org_id = ${org.orgId} and key = 'bank_token_manager'`,
      );
    });
    await seedPendingAccount(org.orgId, org.vendorId, manager, "Token Bank");
    state.user = asUser(manager, org.orgId, "manager");

    // The drawer edits with the token the party payload publishes: the two
    // sides must agree, or every Edit-then-Save 409s beyond any reload.
    const party = await withOrgContext(org.orgId, () =>
      getParty(new Request(`http://bank.local/api/parties/${org.vendorId}`), {
        params: Promise.resolve({ id: org.vendorId }),
      }),
    );
    assert.equal(party.status, 200);
    const payload = (await party.json()) as {
      bankAccounts: Array<{ id: string; updated_at: string }>;
    };
    const published = payload.bankAccounts[0]?.updated_at;
    assert.ok(published, "the party payload must publish a bank-account revision");
    assert.ok(
      isDocumentRevisionToken(published),
      `bank-account revision must be submittable, got ${JSON.stringify(published)}`,
    );

    const saved = await withOrgContext(org.orgId, () =>
      patchAccount(
        new Request(
          `http://bank.local/api/parties/${org.vendorId}/bank-accounts?accountId=${payload.bankAccounts[0]!.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bankName: "Token Bank Updated",
              changeReason: "correct the bank name",
              expectedUpdatedAt: published,
            }),
          },
        ),
        { params: Promise.resolve({ id: org.vendorId }) },
      ),
    );
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

async function seedPendingAccount(
  orgId: string,
  partyId: string,
  manager: string,
  bankName: string,
): Promise<string> {
  const accountId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into party_bank_accounts
        (id, org_id, party_id, bank_name, country, currency, routing,
         account_number_encrypted, account_last_four,
         approval_status, is_active, approved_at, approved_by,
         submitted_by, submitted_at, created_by, updated_by)
      values (${accountId}, ${orgId}, ${partyId}, ${bankName}, 'CA', 'CAD', '{}'::jsonb,
              ${encryptAccountNumber("123456789", { orgId })}, '6789',
              'pending', false, null, null,
              ${manager}, now(), ${manager}, ${manager})`);
  });
  return accountId;
}

async function liveGateCount(orgId: string, accountId: string): Promise<number> {
  return withBypassContext(async () =>
    Number(
      (
        await db.execute<{ count: string }>(
          sql`select count(*)::text as count from flow_gates
             where org_id = ${orgId} and subject_id = ${accountId}
               and status in ('pending', 'escalated')`,
          "objects",
        )
      )[0]!.count,
    ),
  );
}

async function seedActionOnlyFlow(orgId: string, userId: string): Promise<string> {
  const flowId = randomUUID();
  const graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: "trigger",
        position: { x: 0, y: 0 },
        data: { kind: "trigger", trigger: { trigger: "on_create" } },
      },
      {
        id: "notify_1",
        position: { x: 0, y: 1 },
        data: {
          kind: "action",
          action: {
            action: "notify",
            to: [{ type: "user", userId }],
            title: "Bank details submitted",
          },
        },
      },
    ],
    edges: [{ id: "e1", source: "trigger", target: "notify_1" }],
  };
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into flows (id, org_id, name, subject_kind, enabled, graph)
      values (${flowId}, ${orgId}, 'Notify-only bank flow', 'party_bank_account', true,
              ${JSON.stringify(graph)}::jsonb)`);
  });
  return flowId;
}

test("an action-only flow runs its actions and applies bank details without inventing approval gates", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const manager = actors.submitterId;
    const approver = actors.approver1Id;
    await withBypassContext(async () => {
      await db.execute(
        sql`update app_roles set permissions = '["parties.read","parties.manage"]'::jsonb where org_id = ${org.orgId} and key in ('accountant','approver')`,
      );
    });
    const accountId = await seedPendingAccount(
      org.orgId,
      org.vendorId,
      manager,
      "Action-only Bank",
    );
    await seedActionOnlyFlow(org.orgId, approver);
    state.user = asUser(manager, org.orgId, "manager");

    const applied = await withOrgContext(org.orgId, () =>
      submit(submitRequest(org.vendorId, accountId), paramsFor(org.vendorId)),
    );
    assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()));
    const body = (await applied.json()) as { approvalStatus: string; directApplied: boolean };
    assert.equal(body.approvalStatus, "approved");
    assert.equal(body.directApplied, true);
    assert.equal(
      await runCount(org.orgId, accountId),
      1,
      "the configured notification flow is retained",
    );
    assert.equal(await liveGateCount(org.orgId, accountId), 0);
    const released = await withBypassContext(
      async () =>
        (
          await db.execute<{ isActive: boolean; runStatus: string }>(
            sql`
        select b.is_active as "isActive",r.status as "runStatus"
          from party_bank_accounts b join flow_runs r on r.org_id=b.org_id and r.subject_id=b.id
         where b.org_id=${org.orgId} and b.id=${accountId}`,
            "objects",
          )
        )[0],
    );
    assert.deepEqual(released, { isActive: true, runStatus: "completed" });
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a failing sibling flow rolls the whole bank submit back instead of committing its gates", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const manager = actors.submitterId;
    const approver = actors.approver1Id;
    await withBypassContext(async () => {
      await db.execute(
        sql`update app_roles set permissions = '["parties.read","parties.manage"]'::jsonb where org_id = ${org.orgId} and key in ('accountant','approver')`,
      );
    });
    const accountId = await seedPendingAccount(org.orgId, org.vendorId, manager, "Mixed Bank");
    const good = await withBypassContext(() =>
      seedApprovalFlow(org.orgId, {
        subjectKind: "party_bank_account",
        trigger: "on_create",
        assignees: [{ type: "user", userId: approver }],
        mode: "any",
      }),
    );
    const bad = await withBypassContext(() =>
      seedApprovalFlow(org.orgId, {
        subjectKind: "party_bank_account",
        trigger: "on_create",
        assignees: [{ type: "role", role: "nonexistent_role" }],
        mode: "any",
      }),
    );
    await withBypassContext(async () => {
      await db.execute(sql`update flows set name = 'Working bank flow' where id = ${good.flowId}`);
      await db.execute(sql`update flows set name = 'Broken bank flow' where id = ${bad.flowId}`);
    });
    state.user = asUser(manager, org.orgId, "manager");

    // A sibling refusal must roll back all gates and native bank-detail changes.
    const refused = await withOrgContext(org.orgId, () =>
      submit(submitRequest(org.vendorId, accountId), paramsFor(org.vendorId)),
    );
    assert.equal(refused.status, 422, JSON.stringify(await refused.clone().json()));
    const body = (await refused.json()) as { error: string };
    assert.match(body.error, /approval flow.*failed/);
    assert.match(body.error, /Broken bank flow/, "the refusal names the failed flow");
    assert.match(body.error, /zero assignees/, "the refusal names the cause");
    // The refusal threw, so the transaction rolled back: no run and no live
    // gate survive behind it.
    assert.equal(await runCount(org.orgId, accountId), 0);
    assert.equal(await liveGateCount(org.orgId, accountId), 0);
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

for (const count of [0, 10])
  test(`edited bank details require exactly ${count} configured Flow gates`, async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await withBypassContext(() =>
        db.execute(sql`update app_roles set permissions='["parties.read","parties.manage"]'::jsonb
      where org_id=${org.orgId} and key in ('accountant','approver')`),
      );
      state.user = asUser(actors.submitterId, org.orgId, "manager");
      const id = await seedPendingAccount(
        org.orgId,
        org.vendorId,
        actors.submitterId,
        "Operating bank",
      );
      const initial = await withOrgContext(org.orgId, () =>
        submit(submitRequest(org.vendorId, id), paramsFor(org.vendorId)),
      );
      assert.equal(initial.status, 200, JSON.stringify(await initial.clone().json()));
      const revision = (
        await withBypassContext(() =>
          db.execute<{ revision: string }>(
            sql`
      select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision
        from party_bank_accounts where org_id=${org.orgId} and id=${id}`,
            "objects",
          ),
        )
      )[0]!.revision;
      for (let index = 0; index < count; index++)
        await withBypassContext(() =>
          seedApprovalFlow(org.orgId, {
            subjectKind: "party_bank_account",
            trigger: "on_update",
            assignees: [{ type: "user", userId: actors.approver1Id }],
            mode: "all",
          }),
        );
      const changed = await withOrgContext(org.orgId, () =>
        patchAccount(
          new Request(
            `http://bank.local/api/parties/${org.vendorId}/bank-accounts?accountId=${id}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                bankName: "Updated operating bank",
                expectedUpdatedAt: revision,
                changeReason: "Bank confirmed its corrected name",
              }),
            },
          ),
          paramsFor(org.vendorId),
        ),
      );
      assert.equal(changed.status, 200, JSON.stringify(await changed.clone().json()));
      assert.equal((await changed.json()).approvalStatus, count ? "pending" : "approved");
      const read = () =>
        withBypassContext(
          async () =>
            (
              await db.execute<{ approvalStatus: string; isActive: boolean; bankName: string }>(
                sql`
      select approval_status as "approvalStatus",is_active as "isActive",bank_name as "bankName"
        from party_bank_accounts where org_id=${org.orgId} and id=${id}`,
                "objects",
              )
            )[0]!,
        );
      const gates = await withBypassContext(
        async () =>
          await db.execute<{ id: string }>(
            sql`
      select id from flow_gates where org_id=${org.orgId} and subject_id=${id} and status='pending' order by id`,
            "objects",
          ),
      );
      assert.equal(gates.length, count);
      for (const gate of gates) {
        assert.equal(
          (await read()).isActive,
          false,
          "uncompleted review cannot release payment details",
        );
        await withOrgContext(org.orgId, () =>
          decideGate({ gateId: gate.id, decision: "approved", userId: actors.approver1Id }),
        );
      }
      assert.deepEqual(await read(), {
        approvalStatus: "approved",
        isActive: true,
        bankName: "Updated operating bank",
      });
    } finally {
      state.user = null;
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  });
