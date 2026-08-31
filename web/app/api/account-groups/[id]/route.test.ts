import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Regression for fnd_mtht1lzv_7z32aq: account-group PATCH must keep the full
// before/after classification state and actor in the immutable audit log.
const stateKey = Symbol.for("openbooks.account-group-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.account-group-route-test')]
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

const routeUrl = "./route.ts?account-group-audit-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts",
);

const DB = !!process.env.OPENBOOKS_DB_URL;

function authenticate(orgId: string, actorId: string): void {
  routeState.authz = {
    user: { orgId, id: actorId },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
}

function patchRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/account-groups/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-request-id": "account-group-audit-test" },
    body: JSON.stringify(body),
  });
}

function call(id: string) {
  return { params: Promise.resolve({ id }) };
}

test("PATCH records immutable account-group before/after audit evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const groupId = randomUUID();
  authenticate(org.orgId, actorId);

  try {
    await db.execute(sql`
      insert into account_groups
        (id, org_id, dimension, key, name, color, sort_order, match, is_catch_all,
         is_active, custom, created_by, updated_by)
      values
        (${groupId}, ${org.orgId}, 'cost_pool', 'old-key', 'Old name', '#111111', 3,
         ${JSON.stringify({ numberPrefixes: ["5"] })}::jsonb, false, true, '{}'::jsonb,
         ${actorId}, ${actorId})
    `);

    const rejected = await PATCH(
      patchRequest(groupId, { match: { namePattern: "(a+)+$" } }),
      call(groupId),
    );
    assert.equal(rejected.status, 400);

    const response = await PATCH(
      patchRequest(groupId, {
        name: "New name",
        color: "#222222",
        match: { numberPrefixes: ["6"], namePattern: "new" },
      }),
      call(groupId),
    );
    assert.equal(response.status, 200);

    const stored = await db.execute<{ name: string; color: string; match: unknown; updated_by: string }>(sql`
      select name, color, match, updated_by::text from account_groups
       where id = ${groupId} and org_id = ${org.orgId}
    `);
    assert.deepEqual(stored.rows[0], {
      name: "New name",
      color: "#222222",
      match: { numberPrefixes: ["6"], namePattern: "new" },
      updated_by: actorId,
    });

    const audits = await db.execute<{
      action: string;
      actor_id: string;
      request_id: string | null;
      changes: { before?: Record<string, unknown>; after?: Record<string, unknown> };
    }>(sql`
      select action, actor_id::text, request_id, changes
        from audit_log
       where org_id = ${org.orgId} and table_name = 'account_groups' and row_id = ${groupId}
       order by at desc
    `);
    assert.equal(audits.rows.length, 1);
    const audit = audits.rows[0]!;
    assert.equal(audit.action, "update");
    assert.equal(audit.actor_id, actorId);
    assert.equal(audit.request_id, "account-group-audit-test");
    assert.equal(audit.changes.before?.name, "Old name");
    assert.equal(audit.changes.before?.color, "#111111");
    assert.deepEqual(audit.changes.before?.match, { numberPrefixes: ["5"] });
    assert.equal(audit.changes.after?.name, "New name");
    assert.equal(audit.changes.after?.color, "#222222");
    assert.deepEqual(audit.changes.after?.match, { numberPrefixes: ["6"], namePattern: "new" });
    assert.notDeepEqual(audit.changes.before, audit.changes.after);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});
