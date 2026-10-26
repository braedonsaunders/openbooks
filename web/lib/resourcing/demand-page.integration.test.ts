import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { loadDemandPage as LoadDemandPage } from "../../app/(app)/resourcing/demand/view";
import { resolveAppModule } from "../test-module-hooks";

const repo = process.cwd();
const root = pathToFileURL(repo + "/").href;
const state: { authz: unknown } = { authz: null };
Object.assign(globalThis, { __demandPageAuthz: state });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export{}" };
    if (specifier === "next-intl/server")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function getTranslations(){const t=(key)=>key;t.has=()=>false;return t}",
      };
    if (specifier === "@/lib/authz")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function requirePermission(){return globalThis.__demandPageAuthz.authz}export function can(authz,permission){return authz.permissions.has(permission)}",
      };
    if (specifier === "@/lib/feature-gates")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function requireFeatureEnabled(){}",
      };
    return resolveAppModule(specifier, context, next, root) ?? next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { loadDemandPage } = (await import(root + "web/app/(app)/resourcing/demand/view.ts")) as {
  loadDemandPage: typeof LoadDemandPage;
};

test(
  "demand drawer options use opportunity titles",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const authz = {
        user: { id: randomUUID(), orgId: org.orgId },
        permissions: new Set(["resourcing.read", "resourcing.manage"]),
        allowedSubsidiaryIds: null,
      };
      const statusId = randomUUID();
      const opportunityId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"resourcing":true}'::jsonb,true) where id=${org.orgId}`,
        );
        await db.execute(sql`insert into crm_opportunity_statuses (id, org_id, key, name, sequence, probability, is_closed, is_won, is_active)
        values (${statusId}, ${org.orgId}, 'demand-open', 'Open', 1, 40, false, false, true)`);
        await db.execute(sql`insert into crm_opportunities (id, org_id, opportunity_number, title, status_id, forecast_category, probability, currency, is_active)
        values (${opportunityId}, ${org.orgId}, 'DEMAND-1', 'Warehouse expansion', ${statusId}, 'pipeline', 40, 'CAD', true)`);
      });
      state.authz = authz;
      const page = await withOrgContext(org.orgId, () => loadDemandPage({ demand: "new" }));
      assert.deepEqual(page.drawer?.opportunities, [
        { value: opportunityId, label: "Warehouse expansion" },
      ]);
    } finally {
      state.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);
