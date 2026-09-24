import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// E56: the form-layout audit logged only the name — a name alone cannot
// reconstruct the prior state. Insert/update/delete now record full row
// snapshots (layout blob plus flags) as {before, after}.

const stateKey = Symbol.for("openbooks.form-layout-audit-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.form-layout-audit-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
    return state.authz
  }
  export function can(authz, permission) {
    const permissions = authz?.permissions ?? new Set()
    if (permissions.has('*')) return true
    return permissions.has(permission)
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      // The collection and member routes sit at different depths; resolve
      // against the web root rather than a fixed number of ../ segments.
      const webRoot = context.parentURL.slice(0, context.parentURL.indexOf("/web/") + 5);
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context);
    }
    if (specifier.endsWith("lib/authz") && context.parentURL?.includes("customization/form-layouts")) {
      return { url: "mock:form-layout-audit-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:form-layout-audit-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const collectionUrl = "./route.ts?form-layout-audit-test";
const { POST } = (await import(collectionUrl)) as typeof import("./route.ts");
const memberUrl = "./[id]/route.ts?form-layout-audit-test";
const member = (await import(memberUrl)) as typeof import("./[id]/route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { defaultFormLayout } = await import("@openbooks/customization");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

async function seed(): Promise<{ orgId: string }> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Form Admin", "admin");
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId };
}

async function auditFor(orgId: string, rowId: string): Promise<{ action: string; changes: unknown }[]> {
  const r = await db.execute<{ action: string; changes: unknown }>(sql`
    select action, changes from audit_log
     where org_id = ${orgId} and table_name = 'form_layouts' and row_id = ${rowId}`);
  return r.rows;
}

test(
  "form-layout writes audit full before/after snapshots",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { orgId } = await seed();
    const created = await POST(
      new Request("http://localhost/api/customization/form-layouts", {
        method: "POST",
        body: JSON.stringify({
          recordType: "vendor_bill",
          name: "Audit Me",
          layout: defaultFormLayout("vendor_bill"),
          isDefault: true,
        }),
      }),
    );
    assert.equal(created.status, 200);
    const { id } = (await created.json()) as { id: string };

    const inserts = await auditFor(orgId, id);
    assert.equal(inserts.length, 1);
    const insertChanges = inserts[0]!.changes as { before: unknown; after: Record<string, unknown> };
    assert.equal(insertChanges.before, null);
    // Snapshots are raw to_jsonb row images, so flags keep their
    // snake_case column names (is_default, not isDefault).
    assert.equal(insertChanges.after.name, "Audit Me");
    assert.equal(insertChanges.after.is_default, true);
    assert.equal((insertChanges.after.layout as { schemaVersion: number }).schemaVersion, 1);

    const patched = await member.PATCH(
      new Request(`http://localhost/api/customization/form-layouts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Audited" }),
      }),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(patched.status, 200);

    const updates = (await auditFor(orgId, id)).filter((row) => row.action === "update");
    assert.equal(updates.length, 1);
    const updateChanges = updates[0]!.changes as { before: Record<string, unknown>; after: Record<string, unknown> };
    assert.equal(updateChanges.before.name, "Audit Me");
    assert.equal(updateChanges.after.name, "Audited");
    assert.ok(typeof updateChanges.before.layout === "object" && updateChanges.before.layout !== null);
    assert.ok(typeof updateChanges.after.layout === "object" && updateChanges.after.layout !== null);
    assert.equal(updateChanges.after.is_default, true, "untouched flags must survive in the after-image");

    const deleted = await member.DELETE(new Request(`http://localhost/api/customization/form-layouts/${id}`, {
      method: "DELETE",
    }), { params: Promise.resolve({ id }) });
    assert.equal(deleted.status, 200);

    const deletes = (await auditFor(orgId, id)).filter((row) => row.action === "delete");
    assert.equal(deletes.length, 1);
    const deleteChanges = deletes[0]!.changes as { before: Record<string, unknown>; after: unknown };
    assert.equal(deleteChanges.before.name, "Audited");
    assert.ok(typeof deleteChanges.before.layout === "object" && deleteChanges.before.layout !== null);
    assert.equal(deleteChanges.after, null);
  },
);
