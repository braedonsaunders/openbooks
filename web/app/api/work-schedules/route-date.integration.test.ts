import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Work-schedule saves shape-check effectiveFrom/effectiveTo/cycleAnchor with
 * a YYYY-MM-DD regex that admits non-calendar days, so a September 31 sails
 * through every named check and dies in the date column — surfacing the raw
 * driver failure through the conflict path instead of failing closed with a
 * named 422 and nothing written.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __workScheduleDateState: state });
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
                user: globalThis.__workScheduleDateState.user,
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
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

const save = (body: Record<string, unknown>) =>
  new Request("http://audit.local/api/work-schedules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save", ...body }),
  });

const day = (dayIndex: unknown, hours = "8") => ({ dayIndex, hours });
const week = (days: unknown[], effectiveFrom = "2026-01-05") => ({
  pattern: "cycle",
  cycleDays: 7,
  cycleAnchor: "2026-01-05",
  effectiveFrom,
  days,
});

async function scheduleCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from work_schedules where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("a schedule with a non-calendar start date is refused without writing", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    const response = await POST(save(week([0, 1, 2, 3, 4].map((dayIndex) => day(dayIndex)), "2026-09-31")));
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
    assert.equal(await scheduleCount(org.orgId), 0);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
