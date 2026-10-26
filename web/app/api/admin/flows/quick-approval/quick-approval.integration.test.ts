import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../../../lib/auth";

/**
 * One-step approval setup end to end: POST /quick-approval creates an
 * ENABLED, lint-clean flow (trigger → [condition] → gate, all wired) through
 * the audited native write; a submission of that kind is then gated by it.
 * Removal disables the flow through the audited PATCH — history is
 * preserved, never deleted. Refusals carry a machine code so the dialog can
 * toast translated copy (response.ok is checked first, never assumed).
 */
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __quickApprovalUser: state });
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
        "export async function currentUser(){return globalThis.__quickApprovalUser.user}",
      );
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg, seedDraftDocument, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { submitForApproval } = await import("@openbooks/engine/flows/submit");
const { GET: stateOf, POST: setup } = await import("./route.ts");
const { PATCH: patch } = await import("../[id]/route.ts");

function sessionUser(id: string, orgId: string): SessionUser {
  return {
    id,
    orgId,
    name: "tester",
    email: `tester-${id.slice(0, 8)}@scratch.test`,
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: id,
  };
}

async function setupOrg() {
  const org = await withBypassContext(() => createScratchOrg());
  await withBypassContext(() =>
    db.execute(sql`
      update orgs set settings = jsonb_set(
        settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"flows":true}'::jsonb, true)
      where id = ${org.orgId}`),
  );
  const actors = await withBypassContext(async () => seedFlowActors(org.orgId));
  const authorId = await withBypassContext(() =>
    createScratchUser(org.orgId, "flow author", "flow_author"),
  );
  await withBypassContext(() =>
    db.execute(sql`
    update app_roles set permissions = '["flows.manage"]'::jsonb
     where org_id = ${org.orgId} and key = 'flow_author'`),
  );
  state.user = sessionUser(authorId, org.orgId);
  return { org, actors };
}

function post(body: unknown) {
  return new Request("http://admin.test/api/admin/flows/quick-approval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(subjectKind: string) {
  return new Request(`http://admin.test/api/admin/flows/quick-approval?subjectKind=${subjectKind}`);
}

async function docStatus(docId: string): Promise<string | null> {
  const rows = await withBypassContext(() =>
    db.execute<{ status: string }>(
      sql`
    select status from documents where id = ${docId}`,
      "objects",
    ),
  );
  return rows[0]?.status ?? null;
}

test("quick setup creates an enabled, audited flow that gates a submission", async () => {
  const { org, actors } = await setupOrg();
  try {
    const res = await withOrgContext(org.orgId, () =>
      setup(post({ subjectKind: "vendor_bill", approver: { type: "role", role: "admin" } })),
    );
    assert.equal(
      res.status,
      200,
      `setup status: ${res.status} ${(await res.clone().text()).slice(0, 300)}`,
    );
    const { id } = (await res.json()) as { id: string };

    const row = (
      await withBypassContext(() =>
        db.execute<{ enabled: boolean; description: string; graph: unknown }>(
          sql`
      select enabled, description, graph from flows where id = ${id} and org_id = ${org.orgId}`,
          "objects",
        ),
      )
    )[0];
    assert.equal(row?.enabled, true, "quick setup leaves the flow enabled");
    assert.equal(row?.description, "quick-approval", "the setup marks its own flow");

    const audits = (
      await withBypassContext(() =>
        db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from audit_log
       where org_id = ${org.orgId} and table_name = 'flows' and row_id = ${id} and action = 'insert'`,
          "objects",
        ),
      )
    )[0]?.n;
    assert.equal(audits, "1", "creation is audited");

    const docId = await withBypassContext(() =>
      seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId }),
    );
    const result = await submitForApproval("vendor_bill", docId, actors.submitterId);
    assert.equal(result.gated, true, "the submission is gated by the quick flow");
    assert.equal(await docStatus(docId), "pending_approval");
    const gates = (
      await withBypassContext(() =>
        db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from flow_gates where subject_id = ${docId}`,
          "objects",
        ),
      )
    )[0]?.n;
    assert.equal(gates, "1", "exactly one approval gate owns the submission");

    const lookup = await withOrgContext(org.orgId, () => stateOf(get("vendor_bill")));
    assert.equal(lookup.status, 200);
    const found = (await lookup.json()) as { flow: { id: string; enabled: boolean } | null };
    assert.equal(found.flow?.id, id, "the dialog finds the setup flow again");
    assert.equal(found.flow?.enabled, true);
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a threshold gates only submissions over the amount", async () => {
  const { org, actors } = await setupOrg();
  try {
    const res = await withOrgContext(org.orgId, () =>
      setup(
        post({
          subjectKind: "vendor_bill",
          threshold: 10000,
          approver: { type: "role", role: "admin" },
        }),
      ),
    );
    assert.equal(res.status, 200, `setup status: ${res.status}`);
    assert.ok(((await res.json()) as { id: string }).id);

    const smallId = await withBypassContext(() =>
      seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        total: "100.00",
      }),
    );
    const small = await submitForApproval("vendor_bill", smallId, actors.submitterId);
    assert.equal(small.gated, false, "a submission under the threshold passes the gate by");

    const bigId = await withBypassContext(() =>
      seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        total: "20000.00",
      }),
    );
    const big = await submitForApproval("vendor_bill", bigId, actors.submitterId);
    assert.equal(big.gated, true, "a submission over the threshold is gated");
    assert.equal(await docStatus(bigId), "pending_approval");
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("removing the setup disables the flow through the audited path", async () => {
  const { org } = await setupOrg();
  try {
    const res = await withOrgContext(org.orgId, () =>
      setup(post({ subjectKind: "vendor_bill", approver: { type: "role", role: "admin" } })),
    );
    assert.equal(res.status, 200);
    const { id } = (await res.json()) as { id: string };
    const lookup = await withOrgContext(org.orgId, () => stateOf(get("vendor_bill")));
    const found = (await lookup.json()) as { flow: { id: string; updatedAt: string } | null };
    assert.ok(found.flow, "setup flow is found before removal");

    const disable = await withOrgContext(org.orgId, () =>
      patch(
        new Request(`http://admin.test/api/admin/flows/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false, expectedUpdatedAt: found.flow!.updatedAt }),
        }),
        { params: Promise.resolve({ id }) } as never,
      ),
    );
    assert.equal(disable.status, 200, `disable status: ${disable.status}`);
    const row = (
      await withBypassContext(() =>
        db.execute<{ enabled: boolean }>(
          sql`
      select enabled from flows where id = ${id} and org_id = ${org.orgId}`,
          "objects",
        ),
      )
    )[0];
    assert.equal(row?.enabled, false, "removal disables, never deletes");
    const updates = (
      await withBypassContext(() =>
        db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from audit_log
       where org_id = ${org.orgId} and table_name = 'flows' and row_id = ${id} and action = 'update'`,
          "objects",
        ),
      )
    )[0]?.n;
    assert.equal(updates, "1", "the disable is audited");
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("refusals carry a machine code for translated toasts", async () => {
  const { org } = await setupOrg();
  try {
    const res = await withOrgContext(org.orgId, () =>
      setup(post({ subjectKind: "vendor_bill", approver: { type: "role", role: "no-such-role" } })),
    );
    assert.equal(res.status, 400, "an unknown approver role is refused");
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(body.code, "unknown-role");
    assert.ok(body.error.length > 0, "the refusal still names the remedy in English");
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("quick setup preserves an explicit tenant policy allowing the submitter to decide", async () => {
  const { org, actors } = await setupOrg();
  try {
    const response = await withOrgContext(org.orgId, () =>
      setup(
        post({
          subjectKind: "vendor_bill",
          approver: { type: "user", userId: actors.adminId },
          preventSelfApproval: false,
        }),
      ),
    );
    assert.equal(response.status, 200, await response.clone().text());
    const id = await withBypassContext(() =>
      seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.adminId }),
    );
    const submitted = await submitForApproval("vendor_bill", id, actors.adminId);
    assert.equal(submitted.gated, true);
    const gate = (
      await withBypassContext(() =>
        db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${id} and status='pending'`,
          "objects",
        ),
      )
    )[0];
    assert.ok(gate);
    const { decideGate } = await import("@openbooks/engine/testing/flows/gates");
    await decideGate({ gateId: gate.id, userId: actors.adminId, decision: "approved" });
    assert.equal(await docStatus(id), "approved");
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
