import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

/** Bounded compliance exceptions release only through the tenant's retained Flow policy. */
const stateKey = Symbol.for("openbooks.compliance-waiver-approval-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.compliance-waiver-approval-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function guardSubsidiaryScope(authz, subsidiaryId, opts = {}) {
    const allowed = authz.allowedSubsidiaryIds
    const orgWideNull = opts.orgWideNull === true
    if (allowed === null) return null
    if ((subsidiaryId === null || subsidiaryId === undefined) && orgWideNull) return null
    if (typeof subsidiaryId === 'string' && allowed.has(subsidiaryId)) return null
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
  }
`;

const mockCompliance = `
  export async function guardComplianceFeature(_orgId) { return null }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/authz")
      return { url: "mock:waiver-approval-authz", shortCircuit: true };
    if (specifier === "@/lib/compliance")
      return { url: "mock:waiver-approval-gate", shortCircuit: true };
    if (specifier.startsWith("@openbooks/engine/")) {
      const engineRoot = new URL("../../../../../engine/", import.meta.url);
      return nextResolve(
        new URL(specifier.slice("@openbooks/engine/".length), engineRoot).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:waiver-approval-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:waiver-approval-gate") {
      return { format: "module", source: mockCompliance, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");
const { PATCH } = (await import("./[id]/route.ts")) as typeof import("./[id]/route.ts");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedApprovalFlow,
} = await import("@openbooks/engine/testing/fixtures");
const { vendorComplianceStatus } = await import("@openbooks/engine/compliance/compliance");
const { installEngineSeams } = await import("@openbooks/engine/composition/install");
const { decideGate } = await import("@openbooks/engine/testing/flows/gates");
installEngineSeams();
test.after(() => hooks.deregister());

function authorize(orgId: string, actorId: string): void {
  routeState.authz = {
    user: { orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
}

async function fixture(gated = true) {
  const org = await withBypassContext(() => createScratchOrg());
  const requesterId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Requester", "compliance_manager"),
  );
  const approverId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Approver", "compliance_manager"),
  );
  await withBypassContext(async () => {
    await grantScratchPermissions(org.orgId, requesterId, ["compliance.waive"]);
    await grantScratchPermissions(org.orgId, approverId, ["compliance.waive"]);
    await db.execute(
      sql`update orgs set settings=jsonb_set(settings,'{features,subcontractorCompliance}','true'::jsonb) where id=${org.orgId}`,
    );
    if (gated)
      await seedApprovalFlow(org.orgId, {
        subjectKind: "compliance_waiver",
        mode: "any",
        preventSelfApproval: true,
        assignees: [{ type: "user", userId: approverId }],
      });
  });
  authorize(org.orgId, requesterId);
  const partyId = randomUUID();
  const classId = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${partyId},${org.orgId},'vendor','Waiver vendor',${org.subsidiaryId},true,'{}'::jsonb)`),
  );
  await withBypassContext(() =>
    db.execute(sql`
    insert into compliance_classes (id, org_id, code, name, lien_waiver_enforcement, default_information_return, created_by, updated_by)
    values (${classId}, ${org.orgId}, 'SUB', 'Subcontractor', 'none', '1099-NEC', ${requesterId}, ${requesterId})`),
  );
  await withBypassContext(() =>
    db.execute(sql`
    insert into vendor_roles (org_id, party_id, compliance_class_id, created_by, updated_by)
    values (${org.orgId}, ${partyId}, ${classId}, ${requesterId}, ${requesterId})`),
  );
  const requirementId = (
    await withBypassContext(() =>
      db.execute<{ id: string }>(
        sql`
    insert into compliance_requirements (org_id, code, name, category, enforcement, class_id, created_by, updated_by)
    values (${org.orgId}, 'COI', 'Certificate of insurance', 'insurance', 'block_payment', ${classId}, ${requesterId}, ${requesterId})
    returning id`,
        "objects",
      ),
    )
  )[0]!.id;
  return { org, requesterId, approverId, partyId, requirementId };
}

const post = (body: unknown) =>
  withOrgContext(routeState.authz!.user.orgId, () =>
    POST(
      new Request("http://waivers.test/api/compliance/waivers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );

const approve = (id: string, body: unknown = { action: "approve" }) =>
  withOrgContext(routeState.authz!.user.orgId, () =>
    PATCH(
      new Request(`http://waivers.test/api/compliance/waivers/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );

const VALID = {
  reason: "Carrier renewal delayed by underwriter backlog",
  effectiveFrom: "2026-06-01",
  expiresOn: "2026-08-01",
};

test("a requested exception is pending and covers nothing", async () => {
  const { org, partyId, requirementId } = await fixture();
  try {
    const response = await post({ partyId, requirementId, ...VALID });
    const json = (await response.json().catch(() => null)) as {
      id?: string;
      status?: string;
    } | null;
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json?.status, "pending_approval");
    const status = await withOrgContext(org.orgId, () =>
      vendorComplianceStatus({ orgId: org.orgId, partyId, asOf: "2026-07-01" }),
    );
    assert.equal(status.overall, "missing");
    assert.equal(status.blocksPayment, true);
    const row = (
      await withBypassContext(() =>
        db.execute<{ approved_at: string | null }>(
          sql`select approved_at from compliance_waivers where id = ${json!.id!}`,
          "objects",
        ),
      )
    )[0]!;
    assert.equal(row.approved_at, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function pendingGate(orgId: string, id: string) {
  const gate = (
    await withOrgContext(orgId, () =>
      db.execute<{ id: string }>(
        sql`
    select id from flow_gates where org_id=${orgId} and subject_kind='compliance_waiver' and subject_id=${id} and status='pending'`,
        "objects",
      ),
    )
  )[0];
  assert.ok(gate, "the configured tenant gate must own the exception");
  return gate.id;
}

for (const selfDecision of [true, false]) {
  test(`the tenant's exception Flow ${selfDecision ? "refuses an unassigned requester" : "releases an assigned reviewer decision"}`, async () => {
    const { org, requesterId, approverId, partyId, requirementId } = await fixture();
    try {
      const response = await post({ partyId, requirementId, ...VALID });
      assert.equal(response.status, 200, await response.clone().text());
      const created = (await response.json()) as { id: string; status: string };
      assert.equal(created.status, "pending_approval");
      const gateId = await pendingGate(org.orgId, created.id);
      const decide = () =>
        withOrgContext(org.orgId, () =>
          decideGate({
            gateId,
            userId: selfDecision ? requesterId : approverId,
            decision: "approved",
          }),
        );
      if (selfDecision) await assert.rejects(decide());
      else await decide();
      const status = await withOrgContext(org.orgId, () =>
        vendorComplianceStatus({ orgId: org.orgId, partyId, asOf: "2026-07-01" }),
      );
      assert.equal(status.overall, selfDecision ? "missing" : "waived");
      assert.equal(status.blocksPayment, selfDecision);
      if (!selfDecision) assert.equal((await approve(created.id)).status, 404);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}

test("a tenant with no exception gate releases the authorized request and retains its decision evidence", async () => {
  const { org, requesterId, partyId, requirementId } = await fixture(false);
  try {
    const response = await post({ partyId, requirementId, ...VALID });
    assert.equal(response.status, 200, await response.clone().text());
    const created = (await response.json()) as { id: string; status: string };
    assert.equal(created.status, "approved");
    const row = (
      await withOrgContext(org.orgId, () =>
        db.execute<{ approved_by: string }>(
          sql`
      select approved_by from compliance_waivers where org_id=${org.orgId} and id=${created.id}`,
          "objects",
        ),
      )
    )[0];
    assert.equal(row?.approved_by, requesterId);
    assert.equal(
      (
        await withOrgContext(org.orgId, () =>
          vendorComplianceStatus({ orgId: org.orgId, partyId, asOf: "2026-07-01" }),
        )
      ).blocksPayment,
      false,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
