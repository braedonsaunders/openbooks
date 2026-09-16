import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Depreciation evidence shape-checks its effective date (YYYY-MM-DD) but
 * never checks calendar reality — so a September 31 sails into the period
 * lookup, dies in Postgres, and surfaces the raw driver failure as the 422
 * body instead of failing closed with a named error and nothing written.
 * Oversized values are already refused with a named error by the engine's
 * depreciable-basis / lifetime-units caps (both derive from numeric(19,4)
 * columns, so nothing wider can pass them); the width test below guards
 * that closed path.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __deprInputBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/feature-gates"))
      return virtual(`
        export async function guardFeaturePermission() {
          const s = globalThis.__deprInputBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { buildSchedule } = await import("@openbooks/engine/src/depreciation.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fx {
  orgId: string;
  assetId: string;
  evidenceFileId: string;
  date: string;
}

async function fixture(): Promise<Fx> {
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
       acquired_on, in_service_on, acquisition_cost, salvage_value,
       depreciation_method, depreciation_units_total, custom)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'ASSET-manual',
            'manual', 'in_service', ${org.date}, ${org.date}, '12000.0000', '2000.0000',
            'manual', null, '{}'::jsonb)`));
  await withBypassContext(() => buildSchedule(assetId, org.orgId, actorId, org.bookId));
  const folderId = randomUUID();
  const evidenceFileId = await withBypassContext(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into folders (id, org_id, name, record_table, record_id, created_by, updated_by)
        values (${folderId}, ${org.orgId}, 'Asset evidence', 'fixed_assets', ${assetId}, ${actorId}, ${actorId})`);
      const fileId = (await tx.execute<{ id: string }>(sql`
        insert into files (org_id, folder_id, name, file_type, content_type, size_bytes, created_by, updated_by)
        values (${org.orgId}, ${folderId}, 'meter-evidence.pdf', 'pdf', 'application/pdf', 1, ${actorId}, ${actorId}) returning id`)).rows[0]!.id;
      await tx.execute(sql`
        insert into file_attachments (org_id, file_id, target_table, target_id, created_by)
        values (${org.orgId}, ${fileId}, 'fixed_assets', ${assetId}, ${actorId})`);
      return fileId;
    }),
  );
  return { orgId: org.orgId, assetId, evidenceFileId, date: org.date };
}

const post = (fx: Fx, effectiveDate: string, value: string) =>
  withOrgContext(state.orgId, () =>
    POST(
      new Request(`http://depr.test/api/assets/${fx.assetId}/depreciation-inputs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "manual",
          effectiveDate,
          value,
          memo: "bounds probe",
          evidenceFileId: fx.evidenceFileId,
        }),
      }),
      { params: Promise.resolve({ id: fx.assetId }) },
    ),
  );

async function inputCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from depreciation_inputs where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("depreciation evidence refuses a non-calendar effective date without writing", { skip: !DB }, async () => {
  const fx = await fixture();
  try {
    const response = await post(fx, "2026-09-31", "100.00");
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
    assert.equal(await inputCount(fx.orgId), 0);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("depreciation evidence refuses a value wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const fx = await fixture();
  try {
    const response = await post(fx, fx.date, "99999999999999999999.99");
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /numeric field overflow|Failed query/i);
    assert.equal(await inputCount(fx.orgId), 0);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("depreciation evidence still records an ordinary amount", { skip: !DB }, async () => {
  const fx = await fixture();
  try {
    const response = await post(fx, fx.date, "100.00");
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await inputCount(fx.orgId), 1);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
