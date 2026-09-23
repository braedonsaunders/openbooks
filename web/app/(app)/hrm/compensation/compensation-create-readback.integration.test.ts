import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveAppModule } from "../../../../lib/test-module-hooks";
import type { SessionUser } from "../../../../lib/auth";

// OM-15 readback: the PlanCreateForm and CycleCreateForm post the dialog's
// payloads to /api/hrm/headcount-plans and /api/hrm/comp-cycles, whose
// routes validate the bodies (route.test.ts) and call createPlan /
// createCycle. This test proves the second half against live Postgres with
// the EXACT payloads the islands send: the created cycle and plan persist
// and appear in the registers loadCompensationHome renders (the rows the
// ?plan=new / ?cycle=new dialogs close onto).
//
// Only the Next.js seams are stubbed (server-only, next-intl backed by the
// REAL en catalogs). Features, grants, engine services, and the loader all
// run for real: the scratch org carries the four switches on, the actor
// carries the read+manage grants the create path enforces, and the loader
// runs under the org context like the page does.
const root = pathToFileURL(process.cwd() + "/").href;

function catalogAt(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as Record<string, unknown>;
}

const catalogs = {
  hrm: catalogAt("../../../../messages/en/hrm.json"),
  routeState: (catalogAt("../../../../messages/en/shell.json").routeState ?? {}) as Record<string, unknown>,
  admin: catalogAt("../../../../messages/en/admin.json"),
  nav: catalogAt("../../../../messages/en/nav.json"),
};
(globalThis as Record<string, unknown>).__compReadbackCatalogs = catalogs;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function getTranslations(ns) {
              const catalogs = globalThis.__compReadbackCatalogs;
              const catalog = ns === 'shell.routeState' ? catalogs.routeState : ns === 'admin' ? catalogs.admin : ns === 'nav' ? catalogs.nav : catalogs.hrm;
              const lookup = (key) => {
                let node = catalog;
                for (const part of key.split('.')) {
                  if (node !== null && typeof node === 'object') node = node[part];
                  else return key;
                }
                return typeof node === 'string' ? node : key;
              };
              const t = (key, params) => {
                const template = lookup(key);
                if (!params) return template;
                return template.replace(/\\{(\\w+)\\}/g, (_, name) => (params[name] === undefined ? '{' + name + '}' : String(params[name])));
              };
              t.has = (key) => lookup(key) !== key;
              return t;
            }`,
          ),
      };
    }
    const app = resolveAppModule(specifier, context, next, root);
    if (app) return app;
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { createCycle, listCycles } = await import("@openbooks/engine/src/hrm/compensation/cycles.ts");
const { createPlan, listPlans } = await import("@openbooks/engine/src/hrm/compensation/headcount-plans.ts");
const { loadCompensationHome } = await import("../../../../lib/hrm/compensation");

test("the dialogs' create payloads persist and appear in the home registers", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    // hrmMeritCycles additionally requires payroll (feature-registry
    // requiresAll) — the enforced dependency, not test scaffolding.
    await withBypassContext(() =>
      db.execute(sql`
        update orgs
           set settings = coalesce(settings, '{}'::jsonb) || '{"features": {"hrm": true, "payroll": true, "hrmCompensation": true, "hrmMeritCycles": true, "hrmHeadcountPlans": true}}'::jsonb
         where id = ${org.orgId}`),
    );
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Compensation creator", "comp_creator"));
    for (const permission of ["hrm.compensation.read", "hrm.compensation.manage"]) {
      await withBypassContext(
        () => db.execute(sql`
          insert into user_permission_overrides (org_id, user_id, permission, effect)
          values (${org.orgId}, ${actor}, ${permission}, 'grant')
          on conflict (user_id, permission) do update set effect = 'grant'`),
      );
    }
    const user: SessionUser = {
      id: actor,
      orgId: org.orgId,
      name: "Compensation creator",
      email: "comp-creator@scratch.test",
      roles: [],
      isSuperAdmin: false,
      envKind: "production",
      productionOrgId: org.orgId,
      homeOrgId: org.orgId,
      homeUserId: actor,
    };
    const authz = { user, permissions: new Set(["*"]), allowedSubsidiaryIds: null };

    await withOrgContext(org.orgId, async () => {
      // The exact bodies the islands POST (islands.tsx CycleCreateForm /
      // PlanCreateForm) — no drift between the dialog and this proof.
      const cycle = await createCycle({
        orgId: org.orgId,
        actorId: actor,
        name: "Merit 2026",
        kind: "merit",
        effectiveOn: "2026-04-01",
        currency: "CAD",
        guidelineKind: "matrix",
        guideline: { rows: [], cols: ["q1", "q2", "q3", "q4"], cells: {}, unratedRow: null },
      });
      const plan = await createPlan({
        orgId: org.orgId,
        actorId: actor,
        name: "Headcount 2026",
        fiscalPeriodFrom: "2026-01-01",
        fiscalPeriodTo: "2026-12-31",
      });

      assert.deepEqual(
        (await listCycles({ orgId: org.orgId, actorId: actor })).map((c) => c.name),
        ["Merit 2026"],
        "the cycle persists and lists back",
      );
      assert.deepEqual(
        (await listPlans({ orgId: org.orgId, actorId: actor })).map((p) => p.name),
        ["Headcount 2026"],
        "the plan persists and lists back",
      );

      const home = await loadCompensationHome(authz, {});
      assert.ok(home, "the home loader resolves for the creator");
      const cycleRow = home.cycles.find((row) => row.name === "Merit 2026");
      assert.ok(cycleRow, "the created cycle appears in the cycles register");
      assert.equal(cycleRow.href, `/hrm/compensation/cycles/${cycle.id}`, "the register links the cycle detail");
      const planRow = home.plans.find((row) => row.name === "Headcount 2026");
      assert.ok(planRow, "the created plan appears in the plans register");
      assert.equal(planRow.href, `/hrm/compensation/plans/${plan.id}`, "the register links the plan detail");

      // And the dialogs the buttons open resolve with their forms against
      // the same real gates — never a refusal for this actor.
      const withDialogs = await loadCompensationHome(authz, { plan: "new", cycle: "new" });
      assert.equal(withDialogs?.cycleDialog?.open, true, "?cycle=new opens against the real gates");
      assert.equal(withDialogs?.cycleDialog?.refusal, null, "no refusal for a granted manager");
      assert.equal(withDialogs?.planDialog?.open, true, "?plan=new opens against the real gates");
      assert.equal(withDialogs?.planDialog?.refusal, null, "no refusal for a granted manager");
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
