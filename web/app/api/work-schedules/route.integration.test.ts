import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Work-schedule day validation: every supplied day entry is intentional data,
 * so one with a missing or out-of-range dayIndex must be refused (422) like a
 * malformed hours value is — never silently dropped from the stored pattern.
 * A dropped day understates the pattern that decides holiday pay.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __workScheduleRouteState: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (
      specifier.endsWith("/lib/feature-gates") &&
      context.parentURL?.includes("/api/work-schedules/")
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardFeaturePermission(){
              return {
                user: globalThis.__workScheduleRouteState.user,
                permissions: new Set(['admin.setup.manage']),
                allowedSubsidiaryIds: null,
              };
            }
          `),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
const { POST } = await import("./route.ts");

const save = (body: Record<string, unknown>) =>
  new Request("http://audit.local/api/work-schedules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save", ...body }),
  });

const week = (days: unknown[]) => ({
  pattern: "cycle",
  cycleDays: 7,
  cycleAnchor: "2026-01-05",
  effectiveFrom: "2026-01-05",
  days,
});
const day = (dayIndex: unknown, hours = "8") => ({ dayIndex, hours });

async function dayCount(orgId: string, scheduleId: string): Promise<number> {
  const r = await withBypassContext(
    () =>
      db.execute<{ n: number }>(
        sql`select count(*)::int as n from work_schedule_days where org_id = ${orgId} and schedule_id = ${scheduleId}`,
      ),
  );
  return r.rows[0]!.n;
}

test("a day entry outside the cycle is refused, never silently dropped", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    const days = [0, 1, 2, 3, 4, 5].map((dayIndex) => day(dayIndex));
    const response = await POST(save(week([...days, day(7)])));
    assert.equal(response.status, 422, "dayIndex 7 in a 7-day cycle");
    assert.match(((await response.json()) as { error: string }).error, /day/i);
    const count = await withBypassContext(
      () => db.execute<{ n: number }>(sql`select count(*)::int as n from work_schedules where org_id = ${org.orgId}`),
    );
    assert.equal(count.rows[0]!.n, 0, "a refused save must not store a partial pattern");

    const missing = await POST(save(week([...days, { hours: "8" }])));
    assert.equal(missing.status, 422, "a day entry without a dayIndex");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a well-formed week still saves every working day", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    const response = await POST(save(week([0, 1, 2, 3, 4].map((dayIndex) => day(dayIndex)))));
    assert.equal(response.status, 200);
    const { id } = (await response.json()) as { id: string };
    assert.equal(await dayCount(org.orgId, id), 5);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
