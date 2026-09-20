import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// F-t04-005: New ticket persists an empty server-side draft on click, Cancel
// orphans it, DELETE answers 405, and nothing can remove it. An empty draft
// must be discardable: DELETE removes the untouched shell (and only the
// untouched shell), anything with content or status refuses with a reason.
// Only the session gate is stubbed; handler and storage are real.

const stateKey = Symbol.for("openbooks.fieldticket-discard-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: string[] | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.fieldticket-discard-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function guardSubsidiaryScope() {
    return null
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const deleteRouteUrl = "./route.ts?fieldticket-discard-test";
const routeModule = (await import(deleteRouteUrl)) as typeof import("./route.ts") & Record<string, unknown>;
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { createFieldTicket, loadFieldTicket } = await import("../../../../lib/field-tickets.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function deleteRequest(orgId: string, id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const handler = routeModule["DELETE"];
  // Next answers 405 when the route exports no DELETE — the reported symptom.
  if (typeof handler !== "function") return { status: 405, json: null };
  const response = await withOrgContext(orgId, () =>
    (handler as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>)(
      new Request(`http://localhost/api/field-tickets/${id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function orgRows(orgId: string, id: string) {
  const documents = (await db.execute<{ n: string }>(sql`select count(*)::text as n from documents where id = ${id} and org_id = ${orgId}`)).rows[0]!.n;
  const tickets = (await db.execute<{ n: string }>(sql`select count(*)::text as n from field_tickets where document_id = ${id} and org_id = ${orgId}`)).rows[0]!.n;
  return { documents, tickets };
}

test("DELETE discards an untouched ticket draft", { skip: !DB }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`);
      const { adminId } = await seedFlowActors(org.orgId);
      routeState.authz = {
        user: { orgId: org.orgId, id: adminId },
        permissions: new Set(["time.manage"]),
        allowedSubsidiaryIds: null,
      };
      const created = await createFieldTicket(org.orgId, adminId);
      const loaded = await loadFieldTicket(org.orgId, created.id);
      const removed = await deleteRequest(org.orgId, created.id, { expectedRevision: loaded.revision });
      assert.equal(removed.status, 200, `discarding the empty draft must succeed, got ${removed.status}: ${JSON.stringify(removed.json)}`);
      assert.deepEqual(await orgRows(org.orgId, created.id), { documents: "0", tickets: "0" });
      const audit = (await db.execute<{ action: string }>(sql`select action from audit_log where org_id = ${org.orgId} and row_id = ${created.id} order by at desc limit 1`)).rows[0];
      assert.equal(audit?.action, "delete");
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  });
});

test("DELETE refuses a draft that already carries content", { skip: !DB }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`);
      const { adminId } = await seedFlowActors(org.orgId);
      routeState.authz = {
        user: { orgId: org.orgId, id: adminId },
        permissions: new Set(["time.manage"]),
        allowedSubsidiaryIds: null,
      };
      const created = await createFieldTicket(org.orgId, adminId);
      await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount)
        values (${org.orgId}, ${created.id}, 1, ${org.accounts.revenue}, 1, 10, 10)`);
      const loaded = await loadFieldTicket(org.orgId, created.id);
      const refused = await deleteRequest(org.orgId, created.id, { expectedRevision: loaded.revision });
      assert.equal(refused.status, 422);
      assert.match(String((refused.json as { error: string }).error), /lines|content|empty/i);
      assert.deepEqual(await orgRows(org.orgId, created.id), { documents: "1", tickets: "1" });
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  });
});

test("DELETE answers 404 for unknown or malformed ticket ids", { skip: !DB }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`);
      const { adminId } = await seedFlowActors(org.orgId);
      routeState.authz = {
        user: { orgId: org.orgId, id: adminId },
        permissions: new Set(["time.manage"]),
        allowedSubsidiaryIds: null,
      };
      const missing = await deleteRequest(org.orgId, randomUUID(), { expectedRevision: "2026-09-01T00:00:00.000001Z" });
      assert.equal(missing.status, 404);
      const malformed = await deleteRequest(org.orgId, "not-a-uuid", { expectedRevision: "2026-09-01T00:00:00.000001Z" });
      assert.equal(malformed.status, 404);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  });
});
