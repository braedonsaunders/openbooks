import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The close widget reads listCloseRuns — the same reader as the /close
// workspace and orgVitals — never a parallel query.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    if (specifier.startsWith("@openbooks/engine/")) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { ensureCloseDefaults } = await import("@openbooks/engine/src/close/close.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/src/testing/fixtures.ts").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string, permissions: string[]): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Close Watcher", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
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

test("dashboard close widget lists recent runs through the workspace reader", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actors = await withBypass(() => seedFlowActors(org.orgId));
    await withBypass(() => seedRun(org, actors.adminId));
    const actor = await withBypass(() => createScratchUser(org.orgId, "Close Reader", "admin"));
    const metrics = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(authzFor(org.orgId, actor as unknown as string, ["close.run"])),
    );
    assert.equal(metrics.closeRuns.length, 1);
    assert.equal(metrics.closeRuns[0]?.status, "in_progress");
    assert.equal(metrics.closeRuns[0]?.stage, "execute");
    // A caller without close.run reads no runs — and loadCloseReadiness
    // proves separately (no-DB unit test) that the reader is never called.
    const blind = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(authzFor(org.orgId, actor as unknown as string, ["gl.read"])),
    );
    assert.deepEqual(blind.closeRuns, []);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("dashboard close widget is honest on empty", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Close Reader", "admin"));
    const metrics = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(authzFor(org.orgId, actor as unknown as string, ["close.run"])),
    );
    assert.deepEqual(metrics.closeRuns, []);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
