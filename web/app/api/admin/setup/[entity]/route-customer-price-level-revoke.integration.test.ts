import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// PRC15c operator path: revoking a price-level assignment that starts today
// via the generic setup PATCH must succeed. The end-date trigger removes the
// never-effective row instead of end-dating it, so the update matches zero
// rows — the write layer records the delete the trigger performed (with
// audit evidence) instead of answering 404 for work that succeeded.
const stateKey = Symbol.for("openbooks.assignments-revoke-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.assignments-revoke-route-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    const entityRoute = context.parentURL?.includes("%5Bentity%5D")
      ?? context.parentURL?.includes("[entity]");
    if (specifier === "../../../../../lib/authz" && entityRoute) {
      return { url: "mock:authz", shortCircuit: true };
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

const routeUrl = "./route.ts?assignments-revoke-route-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

function authenticate(f: { orgId: string; actorId: string }) {
  routeState.authz = {
    user: { orgId: f.orgId, id: f.actorId },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
}

function patchRequest(entity: string, body: unknown): Request {
  return new Request(`http://localhost/api/admin/setup/${entity}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const call = (entity: string) => ({ params: Promise.resolve({ entity }) });

test("revoking a same-day assignment through setup PATCH keeps the row with its revoke instant", { skip: !DB }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Pricing Setup Admin", "admin");
    try {
      authenticate({ orgId: org.orgId, actorId });
      const customerId = randomUUID();
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`);
      await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
        values (${org.orgId}, ${customerId}, true)`);
      const goldId = randomUUID();
      await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
        values (${goldId}, ${org.orgId}, 'GOLD7', 'Gold price', 'explicit', false, true)`);
      const today = new Date().toISOString().slice(0, 10);
      const assignmentId = randomUUID();
      await db.execute(sql`insert into customer_price_level_assignments (id, org_id, customer_id, price_level_id, effective_from, is_active)
        values (${assignmentId}, ${org.orgId}, ${customerId}, ${goldId}, ${today}, true)`);

      const res = await PATCH(
        patchRequest("customer-price-level-assignments", {
          id: assignmentId,
          customerId,
          priceLevelId: goldId,
          effectiveFrom: today,
          effectiveTo: null,
          isActive: false,
        }),
        call("customer-price-level-assignments"),
      );
      assert.equal(res.status, 200);
      const { id } = (await res.json()) as { id: string };
      assert.equal(id, assignmentId);

      // The row stays: priced lineage must survive the revoke.
      const membership = (await db.execute<{ is_active: boolean; revoked: boolean }>(sql`
        select is_active, (revoked_at is not null) as revoked from customer_price_level_assignments
         where org_id = ${org.orgId} and id = ${assignmentId}`)).rows[0]!;
      assert.equal(membership.is_active, false);
      assert.equal(membership.revoked, true);

      const audits = (await db.execute<{ action: string; actor: string }>(sql`
        select action, actor_id::text as actor from audit_log
         where org_id = ${org.orgId} and table_name = 'customer_price_level_assignments' and row_id = ${assignmentId}
         order by id desc limit 1`)).rows[0];
      assert.equal(audits?.action, "update");
      assert.equal(audits?.actor, actorId);
    } finally {
      routeState.authz = null;
      await dropScratchOrgReporting(org.orgId);
    }
  });
});

test("revoking a future-effective assignment through setup PATCH succeeds and is audited as a delete", { skip: !DB }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Pricing Setup Admin", "admin");
    try {
      authenticate({ orgId: org.orgId, actorId });
      const customerId = randomUUID();
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`);
      await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
        values (${org.orgId}, ${customerId}, true)`);
      const goldId = randomUUID();
      await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
        values (${goldId}, ${org.orgId}, 'GOLD9', 'Gold price', 'explicit', false, true)`);
      const today = new Date().toISOString().slice(0, 10);
      const starts = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
      const assignmentId = randomUUID();
      await db.execute(sql`insert into customer_price_level_assignments (id, org_id, customer_id, price_level_id, effective_from, is_active)
        values (${assignmentId}, ${org.orgId}, ${customerId}, ${goldId}, ${starts}, true)`);

      const res = await PATCH(
        patchRequest("customer-price-level-assignments", {
          id: assignmentId,
          customerId,
          priceLevelId: goldId,
          effectiveFrom: starts,
          effectiveTo: null,
          isActive: false,
        }),
        call("customer-price-level-assignments"),
      );
      assert.equal(res.status, 200);
      const { id } = (await res.json()) as { id: string };
      assert.equal(id, assignmentId);

      const remaining = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from customer_price_level_assignments
         where org_id = ${org.orgId} and id = ${assignmentId}`)).rows[0]!.n;
      assert.equal(remaining, 0);

      const audits = (await db.execute<{ action: string; actor: string }>(sql`
        select action, actor_id::text as actor from audit_log
         where org_id = ${org.orgId} and table_name = 'customer_price_level_assignments' and row_id = ${assignmentId}
         order by id desc limit 1`)).rows[0];
      assert.equal(audits?.action, "delete");
      assert.equal(audits?.actor, actorId);
    } finally {
      routeState.authz = null;
      await dropScratchOrgReporting(org.orgId);
    }
  });
});
