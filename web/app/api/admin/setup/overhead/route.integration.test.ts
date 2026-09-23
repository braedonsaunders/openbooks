import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for the overhead setup boundary. set-application
// used to persist any UUID as the net-zero pair's ledger posting account, so
// a typo stored a dangling account id whose failure only surfaced later at
// time-approval posting; set-lifecycle and set-application also wrote
// settings and audit_log as two autocommit statements, so a failure past the
// settings write committed an unevidenced policy change. These tests prove
// strict account validation and all-or-nothing evidenced writes against real
// PostgreSQL. Only the authorization seam is a test double.
const stateKey = Symbol.for("openbooks.overhead-route-test");
const routeState = { gate: null as null | { user: { orgId: string; id: string }; allowedSubsidiaryIds?: Set<string> | null } };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.overhead-route-test')]
  export async function guardPermission() { return state.gate && { ...state.gate, allowedSubsidiaryIds: state.gate.allowedSubsidiaryIds ?? null } }
  export function can() { return true }
  export function guardUnrestrictedScope(authz) {
    if (authz?.allowedSubsidiaryIds == null) return null
    return Response.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 })
  }
  export function subsidiariesInScope(authz, ids) {
    const scope = authz?.allowedSubsidiaryIds ?? null
    if (scope === null) return true
    return ids.every((id) => id !== null && id !== undefined && id !== '' && scope.has(id))
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../../lib/authz" && context.parentURL?.includes("setup/overhead/route")) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(mockAuthz)}` };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:overhead-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { BUILTIN_PROJECT_TYPES } = await import("@openbooks/schema");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

async function storedApplication(orgId: string): Promise<unknown> {
  const r = await withBypassContext(() => db.execute(sql`
    select settings->'overheadApplication' as c from orgs where id = ${orgId}`));
  return r.rows[0]?.c ?? null;
}

async function applicationAudits(orgId: string): Promise<number> {
  const r = await withBypassContext(() => db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'orgs'
       and changes ? 'overheadApplication'`));
  return r.rows[0]!.n;
}

async function storedLifecycle(orgId: string): Promise<unknown> {
  const r = await withBypassContext(() => db.execute(sql`
    select settings->'overheadRateLifecycle' as c from orgs where id = ${orgId}`));
  return r.rows[0]?.c ?? null;
}

async function lifecycleAudits(orgId: string): Promise<number> {
  const r = await withBypassContext(() => db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'orgs'
       and changes ? 'overheadRateLifecycle'`));
  return r.rows[0]!.n;
}

async function projectProfileActivity(orgId: string, projectTypeId: string) {
  const [versions, audits] = await Promise.all([
    withBypassContext(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from project_financial_profile_versions
       where org_id = ${orgId} and project_type_id = ${projectTypeId}`)),
    withBypassContext(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${orgId} and table_name = 'project_financial_profile_versions'
         and row_id in (select id from project_financial_profile_versions
                         where org_id = ${orgId} and project_type_id = ${projectTypeId})`)),
  ]);
  return { versions: versions.rows[0]!.n, audits: audits.rows[0]!.n };
}

async function addProfileType(orgId: string): Promise<{ id: string; profile: Record<string, unknown> }> {
  const template = BUILTIN_PROJECT_TYPES.find((type) => type.key === "schedule_of_values")!;
  const id = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into project_types (id, org_id, key, name, billing_method, invoicing_profile, backup_profile)
    values (${id}, ${orgId}, 'scope-overhead-test', 'Scope overhead test', 'fixed_price',
            ${JSON.stringify(template.invoicingProfile)}::jsonb, ${JSON.stringify(template.backupProfile)}::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into project_financial_profile_versions (org_id, project_type_id, effective_from, financial_profile, reason)
    values (${orgId}, ${id}, '2000-01-01', ${JSON.stringify(template.financialProfile)}::jsonb, 'scope test baseline')`));
  return { id, profile: template.financialProfile as unknown as Record<string, unknown> };
}

function post(body: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/admin/setup/overhead", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

test("restricted actors cannot change org-wide overhead application settings", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Restricted Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: new Set([org.subsidiaryId]) };
    const response = await post({ action: "set-application", mode: "net_zero_pair", accountId: org.accounts.adjustment });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    assert.equal(await storedApplication(org.orgId), null);
    assert.equal(await applicationAudits(org.orgId), 0);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("restricted actors cannot change org-wide overhead lifecycle settings", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Restricted Lifecycle Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: new Set([org.subsidiaryId]) };
    const response = await post({ action: "set-lifecycle", mode: "scheduled", cadence: "quarterly" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    assert.equal(await storedLifecycle(org.orgId), null);
    assert.equal(await lifecycleAudits(org.orgId), 0);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("restricted actors cannot publish org-wide overhead rates", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Restricted Publisher", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: new Set([org.subsidiaryId]) };
    const before = (await withBypassContext(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from overhead_rates where org_id = ${org.orgId}`))).rows[0]!.n;
    const response = await post({ action: "publish", effectiveFrom: "2026-10-01", rates: [] });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    const after = (await withBypassContext(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from overhead_rates where org_id = ${org.orgId}`))).rows[0]!.n;
    assert.equal(after, before);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("restricted actors cannot publish org-wide project type overhead profiles", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Restricted Profile Admin", "admin"));
    const projectType = await addProfileType(org.orgId);
    const before = await projectProfileActivity(org.orgId, projectType.id);
    routeState.gate = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: new Set([org.subsidiaryId]) };
    const response = await post({
      action: "apply",
      projectTypeIds: [projectType.id],
      overhead: { method: "none" },
      effectiveFrom: "2099-01-01",
      reason: "Scope restriction regression",
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    assert.deepEqual(await projectProfileActivity(org.orgId, projectType.id), before);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("restricted actors cannot backfill org-wide overhead journals", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Restricted Backfill Admin", "admin"));
    const departmentId = randomUUID();
    const projectId = randomUUID();
    const timeEntryId = randomUUID();
    const employeeId = randomUUID();
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
        features: { projects: true, timeTracking: true },
        overheadApplication: { mode: "net_zero_pair", accountId: org.accounts.adjustment },
      })}::jsonb where id = ${org.orgId}`));
    await withBypassContext(() => db.execute(sql`
      insert into departments (id, org_id, name) values (${departmentId}, ${org.orgId}, 'Backfill Department')`));
    await withBypassContext(() => db.execute(sql`
      insert into overhead_rates (id, org_id, method, rate_kind, rate_percent, effective_from)
      values (${randomUUID()}, ${org.orgId}, 'standard', 'per_hour', 10, '2026-01-01')`));
    await withBypassContext(() => db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Backfill worker', ${org.subsidiaryId}, true, '{}'::jsonb)`));
    await withBypassContext(() => db.execute(sql`
      insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'BACKFILL-1', 'Backfill job', ${org.customerId}, 'active', true, '{}'::jsonb)`));
    await withBypassContext(() => db.execute(sql`
      insert into time_entries
        (id, org_id, employee_party_id, worked_on, hours, project_id, department_id, status,
         cost_rate, cost_rate_currency, cost_rate_subsidiary_id, costing_basis, is_billable,
         custom, created_by, updated_by)
      values (${timeEntryId}, ${org.orgId}, ${employeeId}, '2026-07-01', 2, ${projectId}, ${departmentId}, 'approved',
              25, 'CAD', ${org.subsidiaryId}, 'actual', false, '{}'::jsonb, ${actorId}, ${actorId})`));
    routeState.gate = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: new Set([org.subsidiaryId]) };
    const before = (await withBypassContext(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${org.orgId}`))).rows[0]!.n;
    const response = await post({ action: "backfill-overhead" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    const after = (await withBypassContext(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${org.orgId}`))).rows[0]!.n;
    assert.equal(after, before);
    const marker = (await withBypassContext(() => db.execute<{ overheadJournalEntryId: string | null; custom: Record<string, unknown> }>(sql`
      select overhead_journal_entry_id as "overheadJournalEntryId", custom
        from time_entries where org_id = ${org.orgId} and id = ${timeEntryId}`))).rows[0]!;
    assert.equal(marker.overheadJournalEntryId, null);
    assert.deepEqual(marker.custom, {});
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-application refuses a nonexistent posting account", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const response = await post({ action: "set-application", mode: "net_zero_pair", accountId: randomUUID() });
    assert.equal(response.status, 422);
    assert.equal(await storedApplication(org.orgId), null);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-application refuses an inactive account", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    await withBypassContext(() => db.execute(sql`
      update accounts set is_active = false where id = ${org.accounts.adjustment}`));
    const response = await post({ action: "set-application", mode: "net_zero_pair", accountId: org.accounts.adjustment });
    assert.equal(response.status, 422);
    assert.equal(await storedApplication(org.orgId), null);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-application stores a real account with audit evidence", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const response = await post({ action: "set-application", mode: "net_zero_pair", accountId: org.accounts.adjustment });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.deepEqual(await storedApplication(org.orgId), { mode: "net_zero_pair", accountId: org.accounts.adjustment });
    assert.equal(await applicationAudits(org.orgId), 1);
    const evidence = await withBypassContext(() => db.execute(sql`
      select changes, actor_id as "actorId" from audit_log
       where org_id = ${org.orgId} and table_name = 'orgs' and changes ? 'overheadApplication'
       order by id desc limit 1`));
    assert.deepEqual(evidence.rows[0]?.changes, {
      overheadApplication: {
        before: null,
        after: { mode: "net_zero_pair", accountId: org.accounts.adjustment },
      },
    });
    assert.equal(evidence.rows[0]?.actorId, actorId);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-lifecycle refuses a supplied mode outside the enum without writing", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const response = await post({ action: "set-lifecycle", mode: "hourly", cadence: "monthly" });
    assert.equal(response.status, 422);
    assert.equal(await storedLifecycle(org.orgId), null);
    assert.equal(await lifecycleAudits(org.orgId), 0);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-lifecycle refuses a supplied cadence outside the enum without writing", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const response = await post({ action: "set-lifecycle", mode: "scheduled", cadence: "weekly" });
    assert.equal(response.status, 422);
    assert.equal(await storedLifecycle(org.orgId), null);
    assert.equal(await lifecycleAudits(org.orgId), 0);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-application refuses a supplied mode outside the enum without writing", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const response = await post({ action: "set-application", mode: "amortize" });
    assert.equal(response.status, 422);
    assert.equal(await storedApplication(org.orgId), null);
    assert.equal(await applicationAudits(org.orgId), 0);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("omitted mode/cadence keep the documented defaults", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const lifecycle = await post({ action: "set-lifecycle" });
    assert.equal(lifecycle.status, 200, JSON.stringify(await lifecycle.clone().json()));
    assert.deepEqual(await storedLifecycle(org.orgId), { mode: "manual", cadence: "monthly" });
    const application = await post({ action: "set-application" });
    assert.equal(application.status, 200, JSON.stringify(await application.clone().json()));
    assert.deepEqual(await storedApplication(org.orgId), { mode: "report_only", accountId: null });
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-lifecycle audit failure rolls the policy back", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `overhead_audit_failure_${suffix}`;
  const triggerName = `overhead_audit_failure_trigger_${suffix}`;
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    await withBypassContext(() => db.execute(sql.raw(`
      create function public."${functionName}"() returns trigger
      language plpgsql as $$
      begin
        if new.table_name = 'orgs' then
          raise exception 'forced overhead audit failure';
        end if;
        return new;
      end $$;
      create trigger "${triggerName}"
        before insert on audit_log
        for each row execute function public."${functionName}"();
    `)));
    await assert.rejects(
      () => post({ action: "set-lifecycle", mode: "scheduled", cadence: "quarterly" }),
      (error: unknown) => {
        let current: unknown = error;
        while (current && typeof current === "object") {
          const message = (current as { message?: unknown }).message;
          if (typeof message === "string" && message.includes("forced overhead audit failure")) return true;
          current = (current as { cause?: unknown }).cause;
        }
        return false;
      },
    );
    const r = await withBypassContext(() => db.execute(sql`
      select settings->'overheadRateLifecycle' as c from orgs where id = ${org.orgId}`));
    assert.equal(r.rows[0]?.c ?? null, null);
  } finally {
    await withBypassContext(() => db.execute(sql.raw(`
      drop trigger if exists "${triggerName}" on audit_log;
      drop function if exists public."${functionName}"();
    `)));
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});
