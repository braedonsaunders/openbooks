import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { buildAllSchedulesWithRunner } from "./depreciation-schedule-build.ts";
import { refuse } from "./asset-refusal.ts";

/**
 * Draft assets created by the capitalization paths (accepted proposals,
 * construction-in-progress capitalization, new components). They follow the
 * register's own create contract: same FA-#### allocator under the same
 * organization-wide fence, category defaults copied onto the asset the way
 * the asset drawer applies them, and an audit row with the full after-image.
 */

export interface DraftAssetInput {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  categoryId: string;
  name: string;
  description?: string | null;
  acquisitionCost: string;
  acquiredOn?: string | null;
  inServiceOn?: string | null;
  serialNumber?: string | null;
  parentAssetId?: string | null;
  sourceDocumentLineId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  /** Why the asset exists (proposal acceptance, capitalization, …), kept in the audit row. */
  provenance: Record<string, unknown>;
}

export interface CategoryAccounts {
  id: string;
  name: string;
  assetAccountId: string;
  defaultMethod: string;
  defaultDepreciationMethodId: string | null;
  defaultLifeMonths: number | null;
  defaultConvention: string;
}

/** An active category with a configured asset cost account, locked for the write. */
export async function lockCategoryForCapitalization(
  tx: SqlExecutor,
  orgId: string,
  categoryId: string,
): Promise<CategoryAccounts> {
  const row = (
    await tx.execute<{
      id: string;
      name: string;
      asset_account_id: string | null;
      default_method: string;
      default_depreciation_method_id: string | null;
      default_life_months: number | null;
      default_convention: string;
    }>(
      sql`
    select id, name, asset_account_id, default_method, default_depreciation_method_id,
           default_life_months, default_convention
      from asset_categories
     where org_id = ${orgId} and id = ${categoryId} and is_active
     for share`,
      "objects",
    )
  )[0];
  if (!row) refuse("category_invalid", "choose an active asset category");
  if (!row.asset_account_id) {
    refuse("category_unconfigured", `asset category ${row.name} has no asset cost account`, {
      remedy: "Set the category's accounts in Setup → Assets → Asset categories.",
    });
  }
  return {
    id: row.id,
    name: row.name,
    assetAccountId: row.asset_account_id,
    defaultMethod: row.default_method,
    defaultDepreciationMethodId: row.default_depreciation_method_id,
    defaultLifeMonths: row.default_life_months,
    defaultConvention: row.default_convention,
  };
}

/** Create one draft asset inside the caller's transaction. */
export async function createDraftAsset(
  tx: SqlExecutor,
  input: DraftAssetInput,
): Promise<{ id: string; assetNumber: string; assetAccountId: string }> {
  const name = input.name.trim();
  if (!name) refuse("name_required", "every new asset needs a name");
  if (name.length > 200) refuse("name_too_long", "asset names are limited to 200 characters");
  if (cmp(input.acquisitionCost, "0") < 0)
    refuse("amount_not_positive", "asset cost must not be negative");
  for (const [label, value] of [
    ["acquired on", input.acquiredOn],
    ["in service on", input.inServiceOn],
  ] as const) {
    if (value != null && !isIsoCalendarDate(value))
      refuse("date_invalid", `${label} must be a calendar date (YYYY-MM-DD)`);
  }
  const category = await lockCategoryForCapitalization(tx, input.orgId, input.categoryId);
  // The register's allocator fence: every FA-#### writer serializes here.
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${"equipment-capitalization:" + input.orgId}, 0))`);
  const next = (
    await tx.execute<{ n: number }>(
      sql`
    select coalesce(max((regexp_replace(asset_number, '\\D', '', 'g'))::int), 0) + 1 as n
      from fixed_assets
     where org_id = ${input.orgId} and asset_number ~ '^FA-\\d+$'`,
      "objects",
    )
  )[0];
  const assetNumber = `FA-${String(Number(next?.n ?? 1)).padStart(4, "0")}`;
  const id = randomUUID();
  const after = {
    id,
    org_id: input.orgId,
    subsidiary_id: input.subsidiaryId,
    category_id: category.id,
    asset_number: assetNumber,
    name,
    description: input.description ?? null,
    status: "draft",
    acquisition_cost: input.acquisitionCost,
    acquired_on: input.acquiredOn ?? null,
    in_service_on: input.inServiceOn ?? null,
    serial_number: input.serialNumber ?? null,
    parent_asset_id: input.parentAssetId ?? null,
    source_document_line_id: input.sourceDocumentLineId ?? null,
    department_id: input.departmentId ?? null,
    project_id: input.projectId ?? null,
    location_id: input.locationId ?? null,
    depreciation_method: category.defaultMethod,
    depreciation_method_id: category.defaultDepreciationMethodId,
    useful_life_months: category.defaultLifeMonths,
    depreciation_convention: category.defaultConvention,
  };
  const inserted = (
    await tx.execute<{ id: string }>(
      sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, description, status,
       acquisition_cost, salvage_value, acquired_on, in_service_on, serial_number,
       parent_asset_id, source_document_line_id, department_id, project_id, location_id,
       depreciation_method, depreciation_method_id, useful_life_months, depreciation_convention,
       custom, created_by, updated_by)
    values
      (${id}, ${input.orgId}, ${input.subsidiaryId}, ${category.id}, ${assetNumber}, ${name},
       ${after.description}, 'draft', ${input.acquisitionCost}, 0, ${after.acquired_on}, ${after.in_service_on},
       ${after.serial_number}, ${after.parent_asset_id}, ${after.source_document_line_id},
       ${after.department_id}, ${after.project_id}, ${after.location_id},
       ${category.defaultMethod}, ${category.defaultDepreciationMethodId}, ${category.defaultLifeMonths},
       ${category.defaultConvention}, '{}'::jsonb, ${input.actorId}, ${input.actorId})
    returning id`,
      "objects",
    )
  )[0];
  if (!inserted) throw new Error("the asset insert returned no row");
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'fixed_assets', ${id}, 'insert',
            ${JSON.stringify({ before: null, after, provenance: input.provenance })}::jsonb, ${input.actorId})`);
  return { id, assetNumber, assetAccountId: category.assetAccountId };
}

/**
 * Place a draft asset in service and build its schedules in every active
 * book, with the same requirements as placing it in service from the asset
 * drawer: an in-service date, and a useful life unless the method is manual
 * or units of production (which needs lifetime units instead).
 */
export async function placeDraftInService(
  tx: SqlExecutor,
  args: { orgId: string; assetId: string; actorId: string },
): Promise<void> {
  const asset = (
    await tx.execute<{
      asset_number: string;
      status: string;
      in_service_on: string | null;
      depreciation_method: string | null;
      depreciation_method_id: string | null;
      useful_life_months: number | null;
      depreciation_units_total: string | null;
    }>(
      sql`
    select asset_number, status, in_service_on::text as in_service_on, depreciation_method,
           depreciation_method_id, useful_life_months, depreciation_units_total::text as depreciation_units_total
      from fixed_assets where org_id = ${args.orgId} and id = ${args.assetId} for update`,
      "objects",
    )
  )[0];
  if (!asset) refuse("asset_not_found", "asset not found", { status: 404 });
  if (asset.status !== "draft")
    refuse("asset_not_draft", `asset ${asset.asset_number} is already ${asset.status}`);
  if (!asset.in_service_on)
    refuse(
      "in_service_date_required",
      `set an in-service date for ${asset.asset_number} before placing it in service`,
    );
  const formula = asset.depreciation_method_id;
  const method = asset.depreciation_method;
  if (
    (formula || (method !== "manual" && method !== "units_of_production")) &&
    !(asset.useful_life_months && asset.useful_life_months > 0)
  ) {
    refuse(
      "useful_life_required",
      `set a useful life on ${asset.asset_number} (or its category) before placing it in service`,
    );
  }
  if (
    !formula &&
    method === "units_of_production" &&
    !(asset.depreciation_units_total && cmp(asset.depreciation_units_total, "0") > 0)
  ) {
    refuse(
      "units_total_required",
      `set expected lifetime units on ${asset.asset_number} before placing it in service`,
    );
  }
  const placed = (
    await tx.execute<{ id: string }>(
      sql`
    update fixed_assets set status = 'in_service', updated_at = clock_timestamp(), updated_by = ${args.actorId}
     where org_id = ${args.orgId} and id = ${args.assetId} and status = 'draft'
     returning id`,
      "objects",
    )
  )[0];
  if (!placed)
    throw new Error(`asset ${asset.asset_number} was not placed in service; no row changed`);
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, 'fixed_assets', ${args.assetId}, 'update',
            ${JSON.stringify({ before: { status: "draft" }, after: { status: "in_service" } })}::jsonb, ${args.actorId})`);
  await buildAllSchedulesWithRunner(tx, args.assetId, args.orgId, args.actorId);
}
