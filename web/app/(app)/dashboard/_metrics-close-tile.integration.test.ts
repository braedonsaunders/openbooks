import { resolveEngineSpecifier } from "../../../testing/engine-resolve-hooks.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The close widget uses listCloseRuns, matching /close and orgVitals.
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  intl: "export async function getTranslations(){return (key)=>key};export async function getLocale(){return 'en-CA'}",
});
registerHooks({
  resolve(specifier, context, nextResolve) {
    const engineUrl = resolveEngineSpecifier(specifier);
    if (engineUrl) return nextResolve(engineUrl, context);
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { ensureCloseDefaults } = await import("@openbooks/engine/testing/close/defaults");
const { loadDashboardMetrics } = await import("./_metrics.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/testing/fixtures").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;

// The close tile alone. The default read covers every built-in widget, which
// now includes the Sentinel risk tiles these fixtures are not granted.
const CLOSE_WIDGETS = ["list-close-readiness"];

function authzFor(orgId: string, userId: string, permissions: string[]): Authz {
  return {
    user: {
      id: userId,
      email: `${userId}@test`,
      name: "Close Watcher",
      orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox",
      productionOrgId: orgId,
      isSuperAdmin: false,
      homeUserId: userId,
      homeOrgId: orgId,
    },
    permissions: new Set(["dashboard.read", ...permissions]),
    allowedSubsidiaryIds: null,
  };
}

async function seedRun(org: ScratchOrg, adminId: string): Promise<void> {
  const defaults = await ensureCloseDefaults(org.orgId, adminId);
  await db.execute(sql`
    insert into close_runs
      (id, org_id, period_id, book_id, blueprint_id, reporting_package_id, status,
       current_stage, target_close_date, scope, started_at, started_by, created_by, updated_by)
    values (${randomUUID()}, ${org.orgId}, ${org.periodId}, ${org.bookId}, ${defaults.blueprintId},
            ${defaults.reportingPackageId}, 'in_progress', 'execute', current_date + 30,
            '{}'::jsonb, now(), ${adminId}, ${adminId}, ${adminId})
  `);
}

test(
  "dashboard close widget lists recent runs through the workspace reader",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actors = await withBypass(() => seedFlowActors(org.orgId));
      await withBypass(() => seedRun(org, actors.adminId));
      const actor = await withBypass(() => createScratchUser(org.orgId, "Close Reader", "admin"));
      const metrics = await withOrgContext(org.orgId, () =>
        loadDashboardMetrics(
          authzFor(org.orgId, actor as unknown as string, ["close.run"]),
          CLOSE_WIDGETS,
        ),
      );
      assert.equal(metrics.closeRuns.length, 1);
      assert.equal(metrics.closeRuns[0]?.status, "in_progress");
      assert.equal(metrics.closeRuns[0]?.stage, "execute");
      // The tile names the period like the /close list, never by its stored "2026-07".
      assert.equal(metrics.closeRuns[0]?.period, "P07 FY2026");
      const localized = await withOrgContext(org.orgId, () =>
        loadDashboardMetrics(
          authzFor(org.orgId, actor as unknown as string, ["close.run"]),
          CLOSE_WIDGETS,
          undefined,
          "en",
        ),
      );
      assert.equal(localized.closeRuns[0]?.period, "P07 FY2026 · Jul 2026");
      // A caller without close.run reads no runs — and loadCloseReadiness
      // proves separately (no-DB unit test) that the reader is never called.
      const blind = await withOrgContext(org.orgId, () =>
        loadDashboardMetrics(
          authzFor(org.orgId, actor as unknown as string, ["gl.read"]),
          CLOSE_WIDGETS,
        ),
      );
      assert.deepEqual(blind.closeRuns, []);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test("dashboard close widget is honest on empty", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Close Reader", "admin"));
    const metrics = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(
        authzFor(org.orgId, actor as unknown as string, ["close.run"]),
        CLOSE_WIDGETS,
      ),
    );
    assert.deepEqual(metrics.closeRuns, []);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
