import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

/**
 * One compliance.waive holder used to both request and approve an exception:
 * POST stamped approved_by = requester, so every request was born approved.
 * POST now files a pending request that covers nothing; a different person
 * approves it through PATCH waivers/[id], and the evaluator only honours
 * approved exceptions.
 */
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
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }
`;

const mockCompliance = `
  export async function guardComplianceFeature(_orgId) { return null }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "@/lib/authz") return { url: "mock:waiver-approval-authz", shortCircuit: true };
    if (specifier === "@/lib/compliance") return { url: "mock:waiver-approval-gate", shortCircuit: true };
    if (specifier.startsWith("@openbooks/engine/")) {
      const engineRoot = new URL("../../../../../engine/", import.meta.url);
      return {
        url: new URL(specifier.slice("@openbooks/engine/".length), engineRoot).href,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href,
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
    return nextLoad(url, context)
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");
const { PATCH } = (await import("./[id]/route.ts")) as typeof import("./[id]/route.ts");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { vendorComplianceStatus } = await import("@openbooks/engine/src/compliance/compliance.ts");
hooks.deregister();

const DB = !!process.env.OPENBOOKS_DB_URL;

function authorize(orgId: string, actorId: string): void {
  routeState.authz = {
    user: { orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const requesterId = await withBypassContext(() => createScratchUser(org.orgId, "Requester", "compliance_manager"));
  const approverId = await withBypassContext(() => createScratchUser(org.orgId, "Approver", "compliance_manager"));
  authorize(org.orgId, requesterId);
  const partyId = randomUUID();
  const classId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${partyId},${org.orgId},'vendor','Waiver vendor',${org.subsidiaryId},true,'{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into compliance_classes (id, org_id, code, name, lien_waiver_enforcement, default_information_return, created_by, updated_by)
    values (${classId}, ${org.orgId}, 'SUB', 'Subcontractor', 'none', '1099-NEC', ${requesterId}, ${requesterId})`));
  await withBypassContext(() => db.execute(sql`
    insert into vendor_roles (org_id, party_id, compliance_class_id, created_by, updated_by)
    values (${org.orgId}, ${partyId}, ${classId}, ${requesterId}, ${requesterId})`));
  const requirementId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_requirements (org_id, code, name, category, enforcement, class_id, created_by, updated_by)
    values (${org.orgId}, 'COI', 'Certificate of insurance', 'insurance', 'block_payment', ${classId}, ${requesterId}, ${requesterId})
    returning id`))).rows[0]!.id;
  return { org, requesterId, approverId, partyId, requirementId };
}

const post = (body: unknown) =>
  withOrgContext(routeState.authz!.user.orgId, () =>
    POST(new Request("http://waivers.test/api/compliance/waivers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
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

test("a requested exception is pending and covers nothing", { skip: !DB }, async () => {
  const { org, partyId, requirementId } = await fixture();
  try {
    const response = await post({ partyId, requirementId, ...VALID });
    const json = (await response.json().catch(() => null)) as { id?: string; status?: string } | null;
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json?.status, "pending_approval");
    const status = await withOrgContext(org.orgId, () =>
      vendorComplianceStatus({ orgId: org.orgId, partyId, asOf: "2026-07-01" }),
    );
    assert.equal(status.overall, "missing");
    assert.equal(status.blocksPayment, true);
    const row = (await withBypassContext(() => db.execute<{ approved_at: string | null }>(
      sql`select approved_at from compliance_waivers where id = ${json!.id!}`,
    ))).rows[0]!;
    assert.equal(row.approved_at, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the requester cannot approve their own exception", { skip: !DB }, async () => {
  const { org, requesterId, partyId, requirementId } = await fixture();
  try {
    const created = (await (await post({ partyId, requirementId, ...VALID })).json()) as { id: string };
    authorize(org.orgId, requesterId);
    const response = await approve(created.id);
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /other than the person who requested/i);
    const status = await withOrgContext(org.orgId, () =>
      vendorComplianceStatus({ orgId: org.orgId, partyId, asOf: "2026-07-01" }),
    );
    assert.equal(status.overall, "missing");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a different approver grants the exception", { skip: !DB }, async () => {
  const { org, approverId, partyId, requirementId } = await fixture();
  try {
    const created = (await (await post({ partyId, requirementId, ...VALID })).json()) as { id: string };
    authorize(org.orgId, approverId);
    const response = await approve(created.id);
    const json = (await response.json().catch(() => null)) as { status?: string } | null;
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json?.status, "approved");
    const status = await withOrgContext(org.orgId, () =>
      vendorComplianceStatus({ orgId: org.orgId, partyId, asOf: "2026-07-01" }),
    );
    assert.equal(status.overall, "waived");
    assert.equal(status.blocksPayment, false);
    // Approving twice is a second grant, not an idempotent replay.
    const again = await approve(created.id);
    assert.equal(again.status, 404);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
