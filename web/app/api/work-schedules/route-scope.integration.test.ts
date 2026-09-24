import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Work schedules decide holiday pay, so their reads and writes stop at the
 * legal-entity boundary. A caller restricted to one subsidiary must not see
 * another subsidiary's workers or alter its patterns: employee and
 * subsidiary rows scope by their entity, org-wide patterns need an
 * unrestricted caller, and every denial answers like the row was never
 * there (404) — or names the org-wide remedy (403) where the row itself is
 * visible configuration.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = {
  orgId: "",
  actorId: "",
  allowedSubsidiaryIds: null as ReadonlySet<string> | null,
};
Object.assign(globalThis, { __workScheduleScopeState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation")
      return virtual("export function redirect() {}; export function notFound() {}");
    if (specifier === "next/headers")
      return virtual("export function cookies() { throw new Error('no cookies in route test') }");
    if (
      specifier.endsWith("/lib/feature-gates") &&
      context.parentURL?.includes("/api/work-schedules/")
    ) {
      return virtual(`
        export async function guardFeaturePermission() {
          const s = globalThis.__workScheduleScopeState;
          return {
            user: { orgId: s.orgId, id: s.actorId },
            permissions: new Set(['admin.setup.manage']),
            allowedSubsidiaryIds: s.allowedSubsidiaryIds,
          };
        }
      `);
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { GET, POST } = await import("./route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

const WEEK = {
  pattern: "cycle",
  cycleDays: 7,
  cycleAnchor: "2026-01-05",
  effectiveFrom: "2026-01-05",
  days: [0, 1, 2, 3, 4].map((dayIndex) => ({ dayIndex, hours: "8" })),
};

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  const branchId = randomUUID();
  const empA = randomUUID();
  const empB = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Division B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${empA}, ${org.orgId}, 'person', 'Worker A', ${org.subsidiaryId}, true, '{}'::jsonb),
           (${empB}, ${org.orgId}, 'person', 'Worker B', ${branchId}, true, '{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active)
    values (${org.orgId}, ${empA}, '2025-01-06', true),
           (${org.orgId}, ${empB}, '2025-01-06', true)`));
  const seed = async (id: string, employeePartyId: string | null, subsidiaryId: string | null) =>
    (
      await withBypassContext(() => db.execute<{ id: string }>(sql`
        insert into work_schedules
          (id, org_id, name, employee_party_id, subsidiary_id, pattern, cycle_days, cycle_anchor,
           effective_from, is_active, created_by, updated_by)
        values (${id}, ${org.orgId}, ${`seed ${id.slice(0, 4)}`}, ${employeePartyId}, ${subsidiaryId},
                'varies', null, null, '2026-01-05', true, ${actorId}, ${actorId})
        returning id`))
    ).rows[0]!.id;
  const scheduleA = await seed(randomUUID(), empA, null);
  const scheduleB = await seed(randomUUID(), empB, null);
  const scheduleSubB = await seed(randomUUID(), null, branchId);
  const scheduleOrg = await seed(randomUUID(), null, null);
  return { org, branchId, empA, empB, scheduleA, scheduleB, scheduleSubB, scheduleOrg };
}

const get = () => withOrgContext(state.orgId, () => GET());

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(
      new Request("http://schedules.test/api/work-schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );

async function scheduleCount(orgId: string): Promise<number> {
  const rows = (
    await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from work_schedules where org_id = ${orgId}`),
    )
  ).rows;
  return rows[0]!.n;
}

test("GET hides another subsidiary's workers, schedules and options", { skip: !DB }, async () => {
  const { org, empB, scheduleB, scheduleSubB } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await get();
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      schedules: { id: string }[];
      options: { employees: { id: string }[]; subsidiaries: { id: string }[] };
    };
    const ids = new Set(body.schedules.map((s) => s.id));
    assert.ok(!ids.has(scheduleB), "B's employee pattern is hidden");
    assert.ok(!ids.has(scheduleSubB), "B's subsidiary pattern is hidden");
    assert.equal(body.schedules.length, 2, "own employee pattern plus the org-wide one");
    assert.ok(!body.options.employees.some((e) => e.id === empB), "B's worker is hidden from the picker");
    assert.ok(body.options.subsidiaries.every((s) => s.id === org.subsidiaryId), "only visible subsidiaries are offered");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("save cannot create a pattern for another subsidiary's worker or entity", { skip: !DB }, async () => {
  const { org, branchId, empB } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const before = await scheduleCount(org.orgId);
    const forWorker = await post({ action: "save", ...WEEK, employeePartyId: empB });
    assert.equal(forWorker.status, 404);
    assert.deepEqual(await forWorker.json(), { error: "not found" });
    const forEntity = await post({ action: "save", ...WEEK, subsidiaryId: branchId });
    assert.equal(forEntity.status, 404);
    assert.deepEqual(await forEntity.json(), { error: "not found" });
    assert.equal(await scheduleCount(org.orgId), before, "refused saves write nothing");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("save of an org-wide pattern needs an unrestricted caller", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const before = await scheduleCount(org.orgId);
    const response = await post({ action: "save", ...WEEK, effectiveFrom: "2027-01-05" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    assert.equal(await scheduleCount(org.orgId), before);
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("save and delete cannot touch another subsidiary's pattern", { skip: !DB }, async () => {
  const { org, empA, scheduleB } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const edit = await post({ action: "save", id: scheduleB, ...WEEK, employeePartyId: empA });
    assert.equal(edit.status, 404);
    assert.deepEqual(await edit.json(), { error: "not found" });
    const remove = await post({ action: "delete", id: scheduleB });
    assert.equal(remove.status, 404);
    assert.deepEqual(await remove.json(), { error: "not found" });
    const rows = (
      await withBypassContext(() =>
        db.execute<{ n: number }>(
          sql`select count(*)::int as n from work_schedules where org_id = ${org.orgId} and id = ${scheduleB}`,
        ),
      )
    ).rows;
    assert.equal(rows[0]!.n, 1, "a refused delete removes nothing");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an unrestricted caller keeps the full surface", { skip: !DB }, async () => {
  const { org, empA, scheduleA } = await fixture();
  try {
    state.allowedSubsidiaryIds = null;
    const listed = (await (await get()).json()) as { schedules: unknown[] };
    assert.equal(listed.schedules.length, 4);
    const created = await post({ action: "save", ...WEEK, employeePartyId: empA, effectiveFrom: "2027-06-01" });
    assert.equal(created.status, 200, JSON.stringify(await created.json().catch(() => null)));
    const deleted = await post({ action: "delete", id: scheduleA });
    assert.equal(deleted.status, 200);
    const missing = await post({ action: "delete", id: randomUUID() });
    assert.equal(missing.status, 422, "a delete matching zero rows fails instead of reporting ok");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
