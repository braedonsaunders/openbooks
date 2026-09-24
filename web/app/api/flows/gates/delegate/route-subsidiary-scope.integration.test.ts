import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Delegating a gate resolves its legal entity before the engine runs: a
// caller restricted to another entity sees a missing gate, never the
// hand-off, and the delegation never reaches the engine. This drives the
// real route, real validation, real scope gate, and real storage against a
// scratch org: only the session/feature boundary is stubbed.

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const stateKey = Symbol.for("openbooks.flow-delegate-route-test");
const state: {
  authz: {
    user: { id: string; orgId: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
} = { authz: null };
(globalThis as Record<symbol, unknown>)[stateKey] = state;

const permissionsUrl = new URL("../../../../../lib/permissions.ts", import.meta.url).href;
const subsidiaryScopeUrl = new URL(
  "../../../../../../engine/src/organization/subsidiary-scope.ts",
  import.meta.url,
).href;
const jsonUrl = new URL("../../../../../lib/api/json.ts", import.meta.url).href;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    if (specifier === "@/lib/authz" || /(^|\/)lib\/authz$/.test(specifier)) {
      return { shortCircuit: true, url: "mock:delegate-authz" };
    }
    if (/(^|\/)lib\/features$/.test(specifier)) {
      return { shortCircuit: true, url: "mock:delegate-features" };
    }
    if (specifier === "@/lib/api/json") {
      return nextResolve(jsonUrl, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:delegate-authz") {
      return {
        shortCircuit: true,
        format: "module",
        source: `import { permissionSetCovers } from '${permissionsUrl}'
          import { subsidiaryScopeAllows } from '${subsidiaryScopeUrl}'
          const state = globalThis[Symbol.for('openbooks.flow-delegate-route-test')]
          export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }
          export { subsidiaryScopeAllows }
          export async function getAuthz() { return state.authz }
          export function guardSubsidiaryScope(authz, subsidiaryId, opts) {
            if (subsidiaryScopeAllows(authz.allowedSubsidiaryIds, subsidiaryId, opts)) return null
            return Response.json({ error: 'not found' }, { status: 404 })
          }
          export async function guardPermission() { throw new Error('unreached in this test') }`,
      };
    }
    if (url === "mock:delegate-features") {
      return {
        shortCircuit: true,
        format: "module",
        source: `export async function isFeatureEnabled() { return true }`,
      };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?flow-delegate-scope";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

function gate(orgId: string, userId: string, allowedSubsidiaryIds: Set<string> | null) {
  state.authz = {
    user: { id: userId, orgId },
    permissions: new Set(["flows.manage"]),
    allowedSubsidiaryIds,
  };
}

function postRequest(body: unknown): Request {
  return new Request("http://openbooks.test/api/flows/gates/delegate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A pending gate on a timesheet week whose employee sits in a hidden legal
// entity, mirroring engine/src/flows/worklist-scope.integration.test.ts.
async function seedHiddenGate(
  orgId: string,
  assigneeId: string,
  subsidiaryId: string,
): Promise<string> {
  const employeeId = randomUUID();
  const headerId = randomUUID();
  await db.execute(sql`
    insert into parties
      (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values
      (${employeeId}, ${orgId}, 'employee', 'Hidden Worker',
       ${subsidiaryId}, true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into timesheet_weeks
      (id, org_id, employee_party_id, week_start, status, created_by, updated_by)
    values
      (${headerId}, ${orgId}, ${employeeId}, '2026-07-12',
       'submitted', ${assigneeId}, ${assigneeId})
  `);
  const flowId = randomUUID();
  const runId = randomUUID();
  const gateId = randomUUID();
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph)
    values (${flowId}, ${orgId}, 'Timesheet approvals', 'timesheet_week', true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into flow_runs
      (id, org_id, flow_id, subject_kind, subject_id, trigger, status)
    values (${runId}, ${orgId}, ${flowId}, 'timesheet_week', ${headerId}, 'on_submit', 'waiting')
  `);
  await db.execute(sql`
    insert into flow_gates
      (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id,
       title, assignee_user_id, group_key, quorum, status)
    values (${gateId}, ${orgId}, ${flowId}, ${runId}, 'gate-1',
            'timesheet_week', ${headerId}, 'Manager approval',
            ${assigneeId}, 'gate-1', 'any', 'pending')
  `);
  return gateId;
}

async function gateRow(
  orgId: string,
  gateId: string,
): Promise<{ status: string; assignee: string | null } | null> {
  const rows = (
    await db.execute<{ status: string; assignee_user_id: string | null }>(
      sql`select status, assignee_user_id from flow_gates where id = ${gateId} and org_id = ${orgId}`,
    )
  ).rows;
  if (rows.length === 0) return null;
  return { status: rows[0]!.status, assignee: rows[0]!.assignee_user_id };
}

test(
  "a gate outside the caller entity reads as missing and is never delegated",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const hiddenId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${hiddenId}, ${org.orgId}, ${org.subsidiaryId}, 'West Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      // flow_gates.assignee_user_id is a real foreign key: the assignee must
      // be a provisioned user, not a random id.
      const assigneeId = await createScratchUser(org.orgId, "Hidden Approver", "approver");
      const gateId = await seedHiddenGate(org.orgId, assigneeId, hiddenId);
      gate(org.orgId, randomUUID(), new Set([org.subsidiaryId]));

      const response = await POST(
        postRequest({ gateId, toUserId: randomUUID() }),
      );

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not found" });
      assert.deepEqual(await gateRow(org.orgId, gateId), {
        status: "pending",
        assignee: assigneeId,
      });
    } finally {
      state.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);

test("a malformed delegation is a 400 naming both ids", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    gate(org.orgId, randomUUID(), null);

    const response = await POST(postRequest({ gateId: "nope" }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "gateId and toUserId required" });
  } finally {
    state.authz = null;
    await dropScratchOrg(org.orgId);
  }
});
