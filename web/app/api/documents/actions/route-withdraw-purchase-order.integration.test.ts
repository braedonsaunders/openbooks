import { installEngineSeams } from "@openbooks/engine/composition/install";
installEngineSeams();
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../../lib/auth";

/**
 * Withdraw through /api/documents/actions: a pending-approval estimate or
 * order recalls through the same native withdraw path other
 * documents use (same service, same reasoned audit, same run cancellation).
 * Every other order action still meets "not actionable here" — withdraw is
 * the only order action this route serves.
 */
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __poWithdrawUser: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next-intl/server")
      return virtual(
        'export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}',
      );
    if (
      (specifier === "./auth" || specifier.endsWith("/lib/auth")) &&
      context.parentURL?.endsWith("/web/lib/authz.ts")
    ) {
      return virtual(
        "export async function currentUser(){return globalThis.__poWithdrawUser.user}",
      );
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg, seedApprovalFlow, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { submitForApproval } = await import("@openbooks/engine/flows/module");
const { POST } = await import("./route");

const request = (body: unknown) =>
  new Request("http://po-withdraw.local/api/documents/actions", {
    method: "POST",
    body: JSON.stringify(body),
  });

function actorFor(id: string, orgId: string): SessionUser {
  return {
    id,
    orgId,
    name: "Buyer",
    email: "buyer@scratch.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: id,
  };
}

async function seedClerk(orgId: string, permissions: string[]): Promise<string> {
  const actor = await withBypassContext(() => createScratchUser(orgId, "Buyer", "po_buyer"));
  await withBypassContext(() =>
    db.execute(
      sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb where org_id=${orgId} and key='po_buyer'`,
    ),
  );
  return actor;
}

async function seedPendingOrder(
  orgId: string,
  kind: "purchase_order" | "quote" | "sales_order",
  submitterId: string,
  approverId: string,
): Promise<{ orderId: string; runId: string }> {
  const orderId = randomUUID();
  const numberPrefix = kind === "quote" ? "EST" : kind === "sales_order" ? "SO" : "PO";
  await withBypassContext(() =>
    db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${orderId}, ${orgId}, ${kind}, 'draft', ${`${numberPrefix}-${orderId.slice(0, 8)}`},
            ${null}, ${null}, '2026-08-01', '2026-09-01', 'CAD', '1', '100', '0', '100', ${submitterId})`),
  );
  await withBypassContext(() =>
    seedApprovalFlow(orgId, {
      subjectKind: kind,
      assignees: [{ type: "user", userId: approverId }],
      mode: "any",
    }),
  );
  const submitted = await withBypassContext(() => submitForApproval(kind, orderId, submitterId));
  assert.equal(submitted.gated, true);
  return { orderId, runId: submitted.runId! };
}

test("a pending purchase order withdraws through the native document path with a reasoned audit", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    // The clerk both submits and withdraws: the withdraw authority is the
    // submit grant plus being the submitter.
    const clerk = await seedClerk(org.orgId, ["purchase_orders.read", "purchase_orders.create"]);
    const { orderId, runId } = await seedPendingOrder(
      org.orgId,
      "purchase_order",
      clerk,
      actors.approver1Id,
    );
    state.user = actorFor(clerk, org.orgId);

    const withdrawn = await withOrgContext(org.orgId, () =>
      POST(request({ action: "withdraw", documentId: orderId, reason: "vendor pulled the quote" })),
    );
    const body = (await withdrawn.json()) as { status: string; cancelledRunIds: string[] };
    assert.equal(withdrawn.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { status: "draft", cancelledRunIds: [runId] });

    const facts = await withBypassContext(
      async () =>
        (
          await db.execute<{ status: string }>(
            sql`select status from documents where id = ${orderId}`,
            "objects",
          )
        )[0]!,
    );
    assert.equal(facts.status, "draft");

    const audit = await withBypassContext(
      async () =>
        (
          await db.execute<{ action: string; changes: Record<string, unknown> }>(
            sql`
        select action, changes from audit_log
         where org_id = ${org.orgId} and table_name = 'documents' and row_id = ${orderId}
         order by at desc, id desc limit 1`,
            "objects",
          )
        )[0]!,
    );
    assert.equal(audit.action, "update");
    const changes = audit.changes as {
      reason: string;
      before: { document: { status: string } };
      after: { document: { status: string } };
    };
    assert.equal(changes.reason, "vendor pulled the quote");
    assert.equal(changes.before.document.status, "pending_approval");
    assert.equal(changes.after.document.status, "draft");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an approved purchase order withdraw refusal names return-to-draft; other actions remain outside this route", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const clerk = await seedClerk(org.orgId, ["purchase_orders.read", "purchase_orders.create"]);
    const { orderId } = await seedPendingOrder(
      org.orgId,
      "purchase_order",
      clerk,
      actors.approver1Id,
    );
    await withBypassContext(() =>
      db.execute(sql`update documents set status = 'approved' where id = ${orderId}`),
    );
    state.user = actorFor(clerk, org.orgId);

    const refused = await withOrgContext(org.orgId, () =>
      POST(request({ action: "withdraw", documentId: orderId, reason: "changed my mind" })),
    );
    assert.equal(refused.status, 422);
    assert.match(String(((await refused.json()) as { error: string }).error), /return it to draft/);

    const submit = await withOrgContext(org.orgId, () =>
      POST(request({ action: "submit", documentId: orderId })),
    );
    assert.equal(submit.status, 422);
    assert.match(String(((await submit.json()) as { error: string }).error), /not actionable here/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a pending quote withdraws through the route for its submitter and returns to draft", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    // The estimator submits under the quote create grant; withdraw needs the
    // read grant the route checks before the kind-specific rules apply.
    const estimator = await seedClerk(org.orgId, ["estimates.read", "estimates.create"]);
    const { orderId, runId } = await seedPendingOrder(
      org.orgId,
      "quote",
      estimator,
      actors.approver1Id,
    );
    state.user = actorFor(estimator, org.orgId);

    const withdrawn = await withOrgContext(org.orgId, () =>
      POST(
        request({
          action: "withdraw",
          documentId: orderId,
          reason: "customer asked for a revised scope",
        }),
      ),
    );
    const body = (await withdrawn.json()) as { status: string; cancelledRunIds: string[] };
    assert.equal(withdrawn.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { status: "draft", cancelledRunIds: [runId] });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a quote withdraw by a colleague with only the create grant is refused as forbidden", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const estimator = await seedClerk(org.orgId, ["estimates.read", "estimates.create"]);
    const colleague = await seedClerk(org.orgId, ["estimates.read", "estimates.create"]);
    const { orderId, runId } = await seedPendingOrder(
      org.orgId,
      "quote",
      estimator,
      actors.approver1Id,
    );
    state.user = actorFor(colleague, org.orgId);

    const refused = await withOrgContext(org.orgId, () =>
      POST(
        request({
          action: "withdraw",
          documentId: orderId,
          reason: "withdrawing a colleague quote",
        }),
      ),
    );
    assert.equal(refused.status, 403);
    assert.match(
      String(((await refused.json()) as { error: string }).error),
      /only the submitter or an approver/,
    );
    const preserved = await withBypassContext(
      async () =>
        (
          await db.execute<{ status: string; submittedBy: string; runStatus: string }>(
            sql`
        select d.status, d.submitted_by as "submittedBy", r.status as "runStatus"
          from documents d join flow_runs r on r.org_id = d.org_id and r.subject_id = d.id
         where d.org_id = ${org.orgId} and d.id = ${orderId} and r.id = ${runId}
      `,
            "objects",
          )
        )[0]!,
    );
    assert.equal(preserved.status, "pending_approval");
    assert.equal(preserved.submittedBy, estimator);
    assert.equal(preserved.runStatus, "waiting");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an issue-only quote approver may withdraw another estimator submission without create rights", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const estimator = await seedClerk(org.orgId, ["estimates.read", "estimates.create"]);
    const { orderId, runId } = await seedPendingOrder(
      org.orgId,
      "quote",
      estimator,
      actors.approver1Id,
    );
    // Kind approval authority is sufficient even when this viewer is not
    // assigned the live workflow gate and cannot author an estimate.
    const approver = await seedClerk(org.orgId, ["estimates.read", "estimates.issue"]);
    state.user = actorFor(approver, org.orgId);

    const withdrawn = await withOrgContext(org.orgId, () =>
      POST(
        request({
          action: "withdraw",
          documentId: orderId,
          reason: "scope needs review before customer issue",
        }),
      ),
    );
    const body = await withdrawn.json();
    assert.equal(withdrawn.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { status: "draft", cancelledRunIds: [runId] });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a pending sales order withdraws through the native document route", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const clerk = await seedClerk(org.orgId, ["ar.read", "ar.create"]);
    const { orderId, runId } = await seedPendingOrder(
      org.orgId,
      "sales_order",
      clerk,
      actors.approver1Id,
    );
    state.user = actorFor(clerk, org.orgId);

    const withdrawn = await withOrgContext(org.orgId, () =>
      POST(
        request({
          action: "withdraw",
          documentId: orderId,
          reason: "customer requested a new delivery schedule",
        }),
      ),
    );
    const body = await withdrawn.json();
    assert.equal(withdrawn.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { status: "draft", cancelledRunIds: [runId] });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
