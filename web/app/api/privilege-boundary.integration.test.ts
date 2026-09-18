import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/src/db.ts";
import { BUILT_IN_ROLES } from "@openbooks/engine/src/permissions.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
} from "@openbooks/engine/src/test-fixtures.ts";
import { submitForApproval } from "@openbooks/engine/src/flows/submit.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Wave-3 privilege boundary battery (least-privileged insider vs mutating
 * routes). ONE stub only: the session identity (currentUser). Everything
 * else — role assignments, permission resolution, route guards, engine
 * writes — runs for real against a scratch tenant. Every cell asserts the
 * attempt does NOT succeed (2xx would be a defect); the route×role verdicts
 * feed ledger/p02.md.
 */

type SessionStub = {
  id: string; email: string; name: string;
  roles: ReadonlyArray<{ key: string; name: string }>;
  orgId: string; envKind: "production"; productionOrgId: string;
  isSuperAdmin: false; homeUserId: string; homeOrgId: string;
};

const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
const authUrl = new URL("../../lib/auth.ts", import.meta.url).href;
const authzUrl = new URL("../../lib/authz.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (
      (specifier === "./auth" && context.parentURL === authzUrl) ||
      specifier === authUrl
    ) {
      return virtual(`export async function currentUser() { return globalThis.__p02sessionUser ?? null }`);
    }
    return next(specifier, context);
  },
});
const setUser = (user: SessionStub | null) => {
  (globalThis as Record<string, unknown>).__p02sessionUser = user;
};

const base = (p: string) => new URL(p, import.meta.url).href;
const HANDLERS = {
  createUser: base("./admin/users/route.ts"),
  createRole: base("./admin/roles/route.ts"),
  mintKey: base("./admin/api-keys/route.ts"),
  docActions: base("./documents/actions/route.ts"),
  editDoc: base("./documents/[id]/route.ts"),
  postWithApps: base("./payments/post-with-applications/route.ts"),
  addBank: base("./parties/[id]/bank-accounts/route.ts"),
  decideGate: base("./flows/gates/decide/route.ts"),
  runBackup: base("./admin/backups/run/route.ts"),
  deleteBackup: base("./admin/backups/[id]/route.ts"),
  setupFeatures: base("./admin/setup/features/route.ts"),
  remitBill: base("./payroll/remittances/route.ts"),
  fileGrant: base("./file-cabinet/files/[id]/grants/route.ts"),
  fileRestore: base("./file-cabinet/files/[id]/restore/route.ts"),
  profilePatch: base("./admin/payment-operations/[resource]/[id]/route.ts"),
  runScript: base("./scripts/e/[slug]/route.ts"),
};

function req(method: string, body?: unknown): Request {
  return new Request("http://audit.local/x", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

async function seedViewer(orgId: string): Promise<SessionStub> {
  const id = await withBypassContext(() => createScratchUser(orgId, "Viewer", "viewer"));
  await withBypassContext(() => db.execute(sql`update app_roles set permissions = ${JSON.stringify(BUILT_IN_ROLES.viewer!.permissions)}::jsonb
    where org_id = ${orgId} and key = 'viewer'`));
  return {
    id, email: `viewer-${id.slice(0, 8)}@scratch.test`, name: "Viewer",
    roles: [{ key: "viewer", name: "Viewer" }],
    orgId, envKind: "production", productionOrgId: orgId,
    isSuperAdmin: false, homeUserId: id, homeOrgId: orgId,
  };
}

async function seedOnePerm(orgId: string): Promise<SessionStub> {
  const id = await withBypassContext(() => createScratchUser(orgId, "ApReader", "ap_reader"));
  await withBypassContext(() => db.execute(sql`update app_roles set permissions = '["ap.read"]'::jsonb
    where org_id = ${orgId} and key = 'ap_reader'`));
  return {
    id, email: `apr-${id.slice(0, 8)}@scratch.test`, name: "ApReader",
    roles: [{ key: "ap_reader", name: "ap reader" }],
    orgId, envKind: "production", productionOrgId: orgId,
    isSuperAdmin: false, homeUserId: id, homeOrgId: orgId,
  };
}

test("least-privileged viewer is refused by every mutating route", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    // Enable gated features so refusals prove permission checks, not dormant flags.
    await withBypassContext(() => db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"features":{"apiAccess":true}}'::jsonb where id = ${org.orgId}`));
    const viewer = await seedViewer(org.orgId);
    // A draft bill plus a live gate so permission checks (not lookups) decide.
    const draftId = await withBypassContext(() => seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId }));
    await withBypassContext(() => seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    }));
    await withBypassContext(() => submitForApproval("vendor_bill", draftId, actors.submitterId));
    const gateId = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`select id from flow_gates where subject_id = ${draftId} order by created_at limit 1`))).rows[0]!.id;

    setUser(viewer);
    const cells: Array<{ name: string; run: () => Promise<Response> }> = [
      { name: "POST admin/users", run: async () => (await import(HANDLERS.createUser)).POST(req("POST", { email: "x@y.zz", name: "X" })) },
      { name: "POST admin/roles", run: async () => (await import(HANDLERS.createRole)).POST(req("POST", { key: "k", name: "K" })) },
      { name: "POST admin/api-keys", run: async () => (await import(HANDLERS.mintKey)).POST(req("POST", { name: "k", scopes: ["gl.read"] })) },
      { name: "POST documents/actions", run: async () => (await import(HANDLERS.docActions)).POST(req("POST", { action: "submit", documentId: draftId })) },
      { name: "PATCH documents/[id]", run: async () => (await import(HANDLERS.editDoc)).PATCH(req("PATCH", { memo: "hijack" }), params({ id: draftId })) },
      { name: "POST payments/post-with-applications", run: async () => (await import(HANDLERS.postWithApps)).POST(req("POST", { documentId: draftId })) },
      { name: "POST parties bank-accounts", run: async () => (await import(HANDLERS.addBank)).POST(req("POST", {}), params({ id: org.vendorId })) },
      { name: "POST flows gates decide", run: async () => (await import(HANDLERS.decideGate)).POST(req("POST", { gateId, decision: "approved" })) },
      { name: "POST admin/backups/run", run: async () => (await import(HANDLERS.runBackup)).POST(req("POST", {})) },
      { name: "DELETE admin/backups/[id]", run: async () => (await import(HANDLERS.deleteBackup)).DELETE(req("DELETE"), params({ id: randomUUID() })) },
      { name: "PUT admin/setup/features", run: async () => (await import(HANDLERS.setupFeatures)).PUT(req("PUT", { features: {} })) },
      { name: "POST payroll/remittances", run: async () => (await import(HANDLERS.remitBill)).POST(req("POST", { action: "create-bill", partyId: org.vendorId, from: org.date, to: org.date })) },
      { name: "POST file-cabinet grants", run: async () => (await import(HANDLERS.fileGrant)).POST(req("POST", { principalType: "user", principalId: viewer.id, access: "manager" }), params({ id: randomUUID() })) },
      { name: "POST file-cabinet restore", run: async () => (await import(HANDLERS.fileRestore)).POST(req("POST", {}), params({ id: randomUUID() })) },
      { name: "PATCH payment-operations profile", run: async () => (await import(HANDLERS.profilePatch)).PATCH(req("PATCH", { requireRunApproval: false }), params({ resource: "profiles", id: randomUUID() })) },
      { name: "POST scripts endpoint", run: async () => (await import(HANDLERS.runScript)).POST(req("POST", {}), params({ slug: "nope" })) },
    ];
    for (const cell of cells) {
      // Scoped like a production request: an unscoped run would fail closed
      // on the lookup and every refusal below would prove nothing.
      const res = await withOrgContext(org.orgId, () => cell.run());
      assert.ok(
        res.status === 401 || res.status === 403 || res.status === 404,
        `${cell.name}: viewer must be refused, got ${res.status}`,
      );
    }
  } finally {
    setUser(null);
    await dropScratchOrg(org.orgId);
  }
});

test("a single-permission custom role can read but never write outside its grant", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const reader = await seedOnePerm(org.orgId);
    const draftId = await withBypassContext(() => seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId }));
    setUser(reader);
    const { GET } = (await import(HANDLERS.editDoc)) as typeof import("./documents/[id]/route.ts");
    const seen = await withOrgContext(org.orgId, () => GET(new Request("http://audit.local/x"), params({ id: draftId })));
    assert.equal(seen.status, 200, "ap.read holder reads the bill");
    const { POST } = (await import(HANDLERS.docActions)) as typeof import("./documents/actions/route.ts");
    const refused = await withOrgContext(org.orgId, () => POST(req("POST", { action: "submit", documentId: draftId })));
    assert.ok(refused.status === 401 || refused.status === 403 || refused.status === 404, `submit must be refused, got ${refused.status}`);
  } finally {
    setUser(null);
    await dropScratchOrg(org.orgId);
  }
});
