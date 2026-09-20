import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Asset PATCH passes acquiredOn/inServiceOn to the date columns with only
 * trim checks and fences acquisitionCost/salvageValue only to 4dp shape —
 * so a September 31 or a pasted 20-digit cost sails through every named
 * check and dies in Postgres, surfacing the raw driver failure as the 422
 * body instead of failing closed with a named error and nothing written.
 * acquired_on/in_service_on are date; acquisition_cost/salvage_value are
 * numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __assetPatchBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/feature-gates"))
      return virtual(`
        export async function guardFeaturePermission() {
          const s = globalThis.__assetPatchBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { PATCH } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture(): Promise<{ orgId: string; assetId: string; token: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fixedAssets}', 'true'::jsonb, true) where id = ${org.orgId}`),
  );
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, default_method, default_life_months, default_convention,
       tax_attributes, is_active)
    values (${categoryId}, ${org.orgId}, 'Equipment', ${org.accounts.invAsset}, ${org.accounts.clearing},
            ${org.accounts.adjustment}, 'manual', null, 'full_month', '{}'::jsonb, true)`));
  await withBypassContext(() => db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, acquisition_cost, salvage_value, depreciation_method, custom)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'A-1',
            'Press', 'draft', ${org.date}, '12000.0000', '2000.0000', 'manual', '{}'::jsonb)`));
  const token = (await withBypassContext(() => db.execute<{ updated_at: string }>(sql`
    select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
      from fixed_assets where id = ${assetId} and org_id = ${org.orgId}`))).rows[0]!.updated_at;
  return { orgId: org.orgId, assetId, token };
}

const patch = (assetId: string, body: unknown) =>
  withOrgContext(state.orgId, () =>
    PATCH(
      new Request(`http://asset.test/api/assets/${assetId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: assetId }) },
    ),
  );

async function assetOf(orgId: string, assetId: string) {
  const rows = (await withBypassContext(() =>
    db.execute<{ acquired_on: string; acquisition_cost: string }>(
      sql`select acquired_on::text as acquired_on, acquisition_cost::text as acquisition_cost from fixed_assets where org_id = ${orgId} and id = ${assetId}`,
    ))).rows;
  return rows[0]!;
}

test("asset update refuses a non-calendar acquired date without writing", { skip: !DB }, async () => {
  const { orgId, assetId, token } = await fixture();
  const before = await assetOf(orgId, assetId);
  const response = await patch(assetId, { expectedUpdatedAt: token, acquiredOn: "2026-09-31" });
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
  assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
  assert.deepEqual(await assetOf(orgId, assetId), before);
  await dropScratchOrg(orgId);
});

test("asset update refuses a cost wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const { orgId, assetId, token } = await fixture();
  const before = await assetOf(orgId, assetId);
  const response = await patch(assetId, { expectedUpdatedAt: token, acquisitionCost: "99999999999999999999.99" });
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
  assert.doesNotMatch(json?.error ?? "", /numeric field overflow|Failed query/i);
  assert.deepEqual(await assetOf(orgId, assetId), before);
  await dropScratchOrg(orgId);
});

test("asset update still saves an ordinary edit", { skip: !DB }, async () => {
  const { orgId, assetId, token } = await fixture();
  try {
    const response = await patch(assetId, { expectedUpdatedAt: token, acquisitionCost: "13000.00" });
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(Number((await assetOf(orgId, assetId)).acquisition_cost), 13000);
  } finally {
    await dropScratchOrg(orgId);
  }
});
