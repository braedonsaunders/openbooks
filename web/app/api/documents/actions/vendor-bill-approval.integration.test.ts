import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../../lib/auth";

/** Vendor bills use the same tenant Flow routing as every financial record. */
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __vendorBillApprovalUser: state });
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
        "export async function currentUser(){return globalThis.__vendorBillApprovalUser.user}",
      );
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { seedApprovalFlow } = await import("@openbooks/engine/testing/fixtures");
const { decideGate } = await import("@openbooks/engine/flows/module");
const { grantScratchPermissions } = await import("@openbooks/engine/testing/fixtures");
const { installEngineSeams } = await import("@openbooks/engine/composition/install");
installEngineSeams();
const { POST } = await import("./route");

const AUTO_RELEASE_REASON = "released without approval: no applicable Flow approval gates";

const request = (body: unknown) =>
  new Request("http://vendor-bill.local/api/documents/actions", {
    method: "POST",
    body: JSON.stringify(body),
  });

function actorFor(id: string, orgId: string): SessionUser {
  return {
    id,
    orgId,
    name: "AP clerk",
    email: "ap@scratch.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: id,
  };
}

async function seedClerk(orgId: string, permissions: string[]): Promise<string> {
  const actor = await withBypassContext(() => createScratchUser(orgId, "AP clerk", "ap_clerk"));
  await withBypassContext(() =>
    db.execute(
      sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb where org_id=${orgId} and key='ap_clerk'`,
    ),
  );
  return actor;
}

async function seedDraftBill(
  orgId: string,
  actor: string,
  subsidiaryId: string,
  vendorId: string,
  date: string,
): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${orgId}, 'vendor_bill', 'draft', ${`BILL-${id.slice(0, 8)}`},
            ${subsidiaryId}, ${vendorId}, ${date}, ${date},
            'CAD', '1', '100', '0', '100', ${actor})`),
  );
  return id;
}

async function docState(orgId: string, id: string) {
  return withBypassContext(
    async () =>
      (
        await db.execute<{ status: string; submittedBy: string | null }>(
          sql`
      select status, submitted_by as "submittedBy" from documents where id = ${id} and org_id = ${orgId}`,
          "objects",
        )
      )[0]!,
  );
}

async function auditTrail(orgId: string, id: string) {
  return withBypassContext(
    async () =>
      await db.execute<{ action: string; changes: Record<string, unknown> }>(
        sql`
      select action, changes from audit_log where org_id = ${orgId} and table_name = 'documents' and row_id = ${id} order by action`,
        "objects",
      ),
  );
}

async function fixture(
  work: (org: Awaited<ReturnType<typeof createScratchOrg>>, actor: string) => Promise<void>,
) {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await seedClerk(org.orgId, ["ap.read", "ap.create", "ap.post"]);
    state.user = actorFor(actor, org.orgId);
    await work(org, actor);
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
}
const DB = { skip: !process.env.OPENBOOKS_DB_URL };
test(
  "zero-gate vendor-bill submission releases immediately and retains the exact tenant policy",
  DB,
  async () =>
    fixture(async (org, actor) => {
      const id = await seedDraftBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date);
      const response = await withOrgContext(org.orgId, () =>
        POST(request({ action: "submit", documentId: id })),
      );
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).autoApproved, true);
      assert.equal((await docState(org.orgId, id)).status, "approved");
      const audits = await auditTrail(org.orgId, id),
        approvals = audits.filter((row) => row.action === "approve");
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0]?.changes.reason, AUTO_RELEASE_REASON);
      const receipt = await withBypassContext(() =>
        db.execute<{ kind: string; actor_id: string }>(
          sql`select policy->>'kind' as kind,actor_id from flow_submissions where org_id=${org.orgId} and subject_id=${id}`,
          "objects",
        ),
      );
      assert.deepEqual(receipt, [{ kind: "ungated", actor_id: actor }]);
    }),
);

test("ten configured vendor-bill Flows all decide before the document releases", DB, async () =>
  fixture(async (org, actor) => {
    const reviewer = await withBypassContext(() =>
      createScratchUser(org.orgId, "Bill reviewer", "bill_reviewer"),
    );
    await withBypassContext(() => grantScratchPermissions(org.orgId, reviewer, ["ap.approve"]));
    for (let i = 0; i < 10; i++)
      await withBypassContext(() =>
        seedApprovalFlow(org.orgId, {
          subjectKind: "vendor_bill",
          assignees: [{ type: "user", userId: reviewer }],
          mode: "all",
        }),
      );
    const id = await seedDraftBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date);
    const response = await withOrgContext(org.orgId, () =>
      POST(request({ action: "submit", documentId: id })),
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await docState(org.orgId, id)).status, "pending_approval");
    const gates = await withBypassContext(() =>
      db.execute<{ id: string }>(
        sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${id} order by id`,
        "objects",
      ),
    );
    assert.equal(gates.length, 10);
    for (const [index, gate] of gates.entries()) {
      await decideGate({ gateId: gate.id, userId: reviewer, decision: "approved" });
      assert.equal(
        (await docState(org.orgId, id)).status,
        index === 9 ? "approved" : "pending_approval",
      );
    }
  }),
);

test(
  "posting a draft bill routes its configured gates and posts no journal while review remains",
  DB,
  async () =>
    fixture(async (org, actor) => {
      const reviewer = await withBypassContext(() =>
        createScratchUser(org.orgId, "Bill reviewer", "bill_reviewer"),
      );
      await withBypassContext(() => grantScratchPermissions(org.orgId, reviewer, ["ap.approve"]));
      await withBypassContext(() =>
        seedApprovalFlow(org.orgId, {
          subjectKind: "vendor_bill",
          assignees: [{ type: "user", userId: reviewer }],
          mode: "all",
        }),
      );
      const id = await seedDraftBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date);
      const response = await withOrgContext(org.orgId, () =>
        POST(request({ action: "post", documentId: id })),
      );
      assert.equal(response.status, 202, await response.clone().text());
      assert.equal((await docState(org.orgId, id)).status, "pending_approval");
      assert.equal(
        (
          await withBypassContext(() =>
            db.execute(sql`select id from journal_entries where org_id=${org.orgId}`, "objects"),
          )
        ).length,
        0,
      );
    }),
);

test("a later tenant policy never reinterprets an already released bill", DB, async () =>
  fixture(async (org, actor) => {
    const id = await seedDraftBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date);
    assert.equal(
      (await withOrgContext(org.orgId, () => POST(request({ action: "submit", documentId: id }))))
        .status,
      200,
    );
    const before = await auditTrail(org.orgId, id);
    await withBypassContext(() =>
      seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: actor }],
        mode: "all",
        preventSelfApproval: true,
      }),
    );
    const again = await withOrgContext(org.orgId, () =>
      POST(request({ action: "submit", documentId: id })),
    );
    assert.equal(again.status, 422);
    assert.equal((await docState(org.orgId, id)).status, "approved");
    assert.deepEqual(await auditTrail(org.orgId, id), before);
  }),
);
