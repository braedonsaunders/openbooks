import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";

const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __assetTaxPoolFenceState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier.endsWith("/lib/feature-gates")) return virtual(`
      const state = globalThis.__assetTaxPoolFenceState;
      export async function guardFeaturePermission() {
        return { user: { orgId: state.orgId, id: state.actorId }, allowedSubsidiaryIds: null };
      }
    `);
    if (specifier.endsWith("/lib/authz")) return virtual("export function guardUnrestrictedScope() { return null }");
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { installTaxDepreciationPack } = await import("@openbooks/engine/src/tax-returns/depreciation-packs.ts");
const { lockAssetTaxLifecycle } = await import("@openbooks/engine/src/organization/asset-tax-fence.ts");
const routeUrl = "./route.ts?asset-tax-pool-fence-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function blockedBy(holderPid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await withBypassContext(() => db.execute<{ blocked: boolean }>(sql`
      select exists (
        select 1 from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))
      ) as blocked`));
    if (result.rows[0]!.blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test("category class PATCH waits on every affected subsidiary's tax-pool lifecycle fence", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    state.orgId = org.orgId;
    state.actorId = actorId;
    await withBypassContext(async () => {
      await installTaxDepreciationPack(org.orgId, "ca_cca", actorId);
    });
    const subsidiaryIds = [org.subsidiaryId, randomUUID()];
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                  is_elimination, is_active, custom)
        values (${subsidiaryIds[1]}, ${org.orgId}, ${org.subsidiaryId}, 'Pool Fence Entity',
                'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
    });
    const categoryId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into asset_categories
          (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
           depreciation_expense_account_id, tax_attributes, is_active)
        values (${categoryId}, ${org.orgId}, 'Pool Fence Category', ${org.accounts.invAsset},
                ${org.accounts.clearing}, ${org.accounts.adjustment},
                '{"ca_cca_class":"8"}'::jsonb, true)`);
      for (const [index, subsidiaryId] of subsidiaryIds.entries()) {
        await db.execute(sql`
          insert into fixed_assets
            (id, org_id, subsidiary_id, category_id, asset_number, name, status,
             acquired_on, in_service_on, acquisition_cost, salvage_value, custom)
          values (${randomUUID()}, ${org.orgId}, ${subsidiaryId}, ${categoryId},
                  ${`POOL-FENCE-${index}`}, ${`Pool fence asset ${index}`}, 'in_service',
                  ${org.date}, ${org.date}, '1000.0000', '0.0000', '{}'::jsonb)`);
      }
    });

    // Each target is held in its own connection, matching runTaxPool's use of
    // lockAssetTaxLifecycle. If PATCH leaves any subsidiary out, that change
    // commits while its affected tax-pool run is still holding the old class.
    for (const [index, subsidiaryId] of subsidiaryIds.entries()) {
      let release!: () => void;
      let ready!: (pid: number) => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const lockReady = new Promise<number>((resolve) => { ready = resolve; });
      const holder = withOrgContext(org.orgId, () => db.transaction(async (tx) => {
        await lockAssetTaxLifecycle(tx, org.orgId, [subsidiaryId]);
        const row = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0];
        assert.ok(row);
        ready(Number(row.pid));
        await hold;
      }));
      const holderPid = await lockReady;
      try {
        const patch = withOrgContext(org.orgId, () => PATCH(new Request(
          "http://assets.test/api/assets/tax-category-assignments",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ categoryId, regime: "ca_cca", ...(index === 0 ? {} : { classCode: "8" }) }),
          },
        )));
        assert.equal(await blockedBy(holderPid), true, `PATCH did not wait for subsidiary ${subsidiaryId}`);
        release();
        const response = await patch;
        assert.equal(response.status, 200, await response.text());
      } finally {
        release();
        await holder;
      }
    }
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
