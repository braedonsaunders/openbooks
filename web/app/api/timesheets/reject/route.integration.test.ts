import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Rejection resolves the employee's legal entity before reading the week,
// and flips the header, its entries, and the decision audit inside one
// tenant transaction: an empty rejection (no submitted entries) rolls the
// header stamp back instead of recording a reason over nothing. This drives
// the real route and the real week helpers against a scratch org: only the
// session/feature boundary is stubbed.

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const stateKey = Symbol.for("openbooks.timesheets-reject-route-test");
const state: {
  gate: {
    user: { id: string; orgId: string };
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
} = { gate: null };
(globalThis as Record<symbol, unknown>)[stateKey] = state;

const permissionsUrl = new URL("../../../../lib/permissions.ts", import.meta.url).href;
const subsidiaryScopeUrl = new URL(
  "../../../../../engine/src/organization/subsidiary-scope.ts",
  import.meta.url,
).href;
const jsonUrl = new URL("../../../../lib/api/json.ts", import.meta.url).href;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    if (specifier === "@/lib/authz" || /(^|\/)lib\/authz$/.test(specifier)) {
      return { shortCircuit: true, url: "mock:reject-authz" };
    }
    if (/(^|\/)lib\/features$/.test(specifier) ||
      /(^|\/)lib\/feature-gates$/.test(specifier)) {
      return { shortCircuit: true, url: "mock:reject-features" };
    }
    if (specifier === "@/lib/api/json") {
      return nextResolve(jsonUrl, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:reject-authz") {
      return {
        shortCircuit: true,
        format: "module",
        source: `import { permissionSetCovers } from '${permissionsUrl}'
          import { subsidiaryScopeAllows } from '${subsidiaryScopeUrl}'
          const state = globalThis[Symbol.for('openbooks.timesheets-reject-route-test')]
          export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }
          export { subsidiaryScopeAllows }
          export async function getAuthz() { return state.gate }
          export async function guardPermission() { throw new Error('unreached in this test') }`,
      };
    }
    if (url === "mock:reject-features") {
      return {
        shortCircuit: true,
        format: "module",
        source: `const state = globalThis[Symbol.for('openbooks.timesheets-reject-route-test')]
          export async function guardFeaturePermission() {
            if (!state.gate) return Response.json({ error: 'unauthorized' }, { status: 401 })
            return state.gate
          }
          export async function isFeatureEnabled() { return true }`,
      };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?timesheets-reject";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedActiveEmployment } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const WEEK = "2026-07-12";

function gate(orgId: string, allowedSubsidiaryIds: Set<string> | null) {
  state.gate = { user: { id: randomUUID(), orgId }, allowedSubsidiaryIds };
}

function postRequest(body: unknown): Request {
  return new Request("http://openbooks.test/api/timesheets/reject", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedEmployee(orgId: string, subsidiaryId: string, actorId: string): Promise<string> {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties
      (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values
      (${employeeId}, ${orgId}, 'employee', 'Reject Worker',
       ${subsidiaryId}, true, '{}'::jsonb)
  `);
  await seedActiveEmployment(orgId, employeeId);
  await db.execute(sql`
    insert into timesheet_weeks
      (id, org_id, employee_party_id, week_start, status, created_by, updated_by)
    values
      (${randomUUID()}, ${orgId}, ${employeeId}, ${WEEK},
       'submitted', ${actorId}, ${actorId})
  `);
  return employeeId;
}

async function seedSubmittedEntry(orgId: string, employeeId: string): Promise<void> {
  await db.execute(sql`
    insert into time_entries
      (org_id, employee_party_id, worked_on, hours, status)
    values (${orgId}, ${employeeId}, '2026-07-14', 8, 'submitted')`);
}

async function weekStatus(orgId: string, employeeId: string): Promise<string | null> {
  const rows = (
    await db.execute<{ status: string }>(
      sql`select status from timesheet_weeks where org_id = ${orgId} and employee_party_id = ${employeeId} and week_start = ${WEEK}::date`,
    )
  ).rows;
  return rows[0]?.status ?? null;
}

async function auditEvents(orgId: string): Promise<number> {
  const rows = (
    await db.execute<{ n: string }>(
      sql`select count(*)::text as n from audit_log where org_id = ${orgId} and table_name = 'timesheet_weeks'`,
    )
  ).rows;
  return Number(rows[0]?.n ?? 0);
}

test("an employee outside the caller scope is unreachable, with nothing read or written", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const hiddenId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${hiddenId}, ${org.orgId}, ${org.subsidiaryId}, 'West Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
    const actorId = randomUUID();
    const hiddenEmployee = await seedEmployee(org.orgId, hiddenId, actorId);
    gate(org.orgId, new Set([org.subsidiaryId]));

    const response = await POST(
      postRequest({ employee: hiddenEmployee, week: WEEK, reason: "not this week" }),
    );

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "Employee not found" });
    assert.equal(await weekStatus(org.orgId, hiddenEmployee), "submitted");
    assert.equal(await auditEvents(org.orgId), 0);
  } finally {
    state.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("a rejection flips the header, its entries, and the audit together", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    const employeeId = await seedEmployee(org.orgId, org.subsidiaryId, actorId);
    await seedSubmittedEntry(org.orgId, employeeId);
    gate(org.orgId, null);

    const response = await POST(
      postRequest({ employee: employeeId, week: WEEK, reason: "wrong project" }),
    );

    assert.equal(response.status, 200);
    assert.equal(await weekStatus(org.orgId, employeeId), "rejected");
    const entries = (
      await db.execute<{ status: string; rejection_reason: string | null }>(
        sql`select status, rejection_reason from time_entries where org_id = ${org.orgId} and employee_party_id = ${employeeId}`,
      )
    ).rows;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.status, "rejected");
    assert.equal(entries[0]?.rejection_reason, "wrong project");
    const audits = (
      await db.execute<{ event: string; reason: string }>(
        sql`select changes->>'event' as event, changes->>'reason' as reason from audit_log where org_id = ${org.orgId} and table_name = 'timesheet_weeks'`,
      )
    ).rows;
    assert.deepEqual(audits, [{ event: "rejected", reason: "wrong project" }]);
  } finally {
    state.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("an empty rejection rolls the header stamp back instead of recording a reason", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    const employeeId = await seedEmployee(org.orgId, org.subsidiaryId, actorId);
    gate(org.orgId, null);

    // The empty rejection refuses with its remedy and rolls the header stamp
    // back (still submitted, no audit).
    const response = await POST(
      postRequest({ employee: employeeId, week: WEEK, reason: "wrong project" }),
    );
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: "Nothing to reject — the week has no submitted entries",
    });
    assert.equal(await weekStatus(org.orgId, employeeId), "submitted");
    assert.equal(await auditEvents(org.orgId), 0);
  } finally {
    state.gate = null;
    await dropScratchOrg(org.orgId);
  }
});
