import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { canonicalJson } from "@openbooks/engine/src/platform/canonical-json.ts";
import { cmp } from "@openbooks/engine/src/money/money.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { guardFeaturePermission } from "../../../lib/feature-gates";
import { isUuid } from "../../../lib/list-params";
import {
  FieldRefusal,
  checkOpeningBasis,
  checkOpeningMonth,
  checkOpeningPair,
  moneyOrNull,
  parseAccountOverride,
  parseAssetConvention,
  parseAssetMethod,
  parseCustomBag,
  parseDepreciationMethodId,
  parseLifeMonths,
  parseOpeningAmount,
  parseOpeningAsOf,
  parseRatePercent,
  parseTaxDepreciation,
  parseUnitsTotal,
  strOrNull,
} from "./_fields";

export const runtime = "nodejs";

// Typed collection body (never jsonObject: the financial-boundary ceiling
// only shrinks). Shape-only here — every domain refusal below keeps its
// stable snake code so the drawer can name the remedy. The field set mirrors
// the drawer payload (same component, same layout, same custom fields in
// create and edit), so nothing the operator fills in is silently dropped.
const createAssetSchema = z.looseObject({
  name: z.string().optional(),
  assetNumber: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  categoryId: z.string().optional().nullable(),
  subsidiaryId: z.string().optional().nullable(),
  acquisitionCost: decimalString("acquisitionCost").optional().nullable(),
  salvageValue: decimalString("salvageValue").optional().nullable(),
  acquiredOn: z.string().optional().nullable(),
  inServiceOn: z.string().optional().nullable(),
  openingAccumulated: decimalString("openingAccumulated").optional().nullable(),
  openingAsOf: z.string().optional().nullable(),
  serialNumber: z.string().optional().nullable(),
  method: z.string().optional().nullable(),
  depreciationMethodId: z.string().optional().nullable(),
  lifeMonths: z.union([z.string(), z.number()]).optional().nullable(),
  ratePercent: decimalString("ratePercent").optional().nullable(),
  unitsTotal: decimalString("unitsTotal").optional().nullable(),
  convention: z.string().optional().nullable(),
  assetAccountId: z.string().optional().nullable(),
  accumulatedDepreciationAccountId: z.string().optional().nullable(),
  depreciationExpenseAccountId: z.string().optional().nullable(),
  custom: z.record(z.string(), z.unknown()).optional(),
  taxDepreciation: z.record(z.string(), z.unknown()).optional(),
  status: z.string().optional(),
});

function decimalString(field: string) {
  return z.string({ error: `${field} must be sent as a decimal string, not a JSON number` });
}

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status });
}

// FieldRefusal code → drawer field, so the refusal pins to its input.
const REFUSAL_FIELD: Record<string, string> = {
  invalid_method: "method",
  invalid_convention: "convention",
  invalid_life: "lifeMonths",
  invalid_rate: "ratePercent",
  invalid_units: "unitsTotal",
  opening_invalid: "openingAccumulated",
  opening_negative: "openingAccumulated",
  opening_as_of_invalid: "openingAsOf",
  opening_pair_required: "openingAccumulated",
  opening_exceeds_basis: "openingAccumulated",
  opening_before_in_service: "openingAsOf",
  invalid_asset_account: "assetAccountId",
  invalid_accumulated_account: "accumulatedDepreciationAccountId",
  invalid_expense_account: "depreciationExpenseAccountId",
  invalid_formula: "depreciationMethodId",
  unknown_formula: "depreciationMethodId",
  tax_elections_invalid: "taxDepreciation",
  tax_business_use_invalid: "taxDepreciation",
  tax_bonus_invalid: "taxDepreciation",
  tax_section179_invalid: "taxDepreciation",
  tax_class_invalid: "taxDepreciation",
  invalid_custom_fields: "custom",
  unknown_custom_reference: "custom",
};

/**
 * Create one tenant-owned fixed asset as draft.
 *
 * The unsaved-create contract (exemplar: POST /api/accounts): opening New
 * allocates nothing — no record, no FA-#### number, no category, no audit
 * row. Save performs exactly one idempotent insert here. The caller supplies
 * a UUID idempotency key, which becomes the asset ID: retrying the same
 * request returns the same id without a duplicate insert or audit event,
 * while reusing the key for a changed request is a 409 conflict.
 *
 * Creation always yields draft. Placing the asset in service (in-service
 * date plus useful life, schedule build) stays on PATCH /api/assets/[id],
 * so lifecycle semantics after creation are unchanged.
 */
export async function POST(request: Request) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const user = gate.user;

  const requestId = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!isUuid(requestId)) return bad("invalid_idempotency_key", undefined, 400);

  const parsedBody = await parseJsonBody(request, createAssetSchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;

  if (body.status !== undefined && body.status !== "draft") {
    return bad("unsupported_status_transition", "status");
  }

  const name = body.name?.trim() ?? "";
  if (!name) return bad("name_required", "name");

  const categoryId = strOrNull(body.categoryId)?.toLowerCase() ?? null;
  if (!categoryId) return bad("category_required", "categoryId");
  if (!isUuid(categoryId)) return bad("invalid_category", "categoryId");
  const category = await db.execute<{ id: string }>(sql`
    select id from asset_categories
     where org_id = ${user.orgId} and is_active and id = ${categoryId}
  `);
  if (!category.rows.some((row) => String(row.id).toLowerCase() === categoryId)) {
    return bad("invalid_category", "categoryId");
  }

  const suppliedSubsidiaryId = strOrNull(body.subsidiaryId)?.toLowerCase() ?? null;
  if (
    suppliedSubsidiaryId &&
    (!isUuid(suppliedSubsidiaryId) ||
      (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(suppliedSubsidiaryId)))
  ) {
    return bad("invalid_subsidiary", "subsidiaryId");
  }
  const subsidiaries = await db.execute<{ id: string }>(sql`
    select id from subsidiaries
     where org_id = ${user.orgId} and is_active and not is_elimination
       ${gate.allowedSubsidiaryIds ? sql`and id = any(${`{${[...gate.allowedSubsidiaryIds].join(",")}}`}::uuid[])` : sql``}
     order by (parent_id is null) desc, name
  `);
  const subsidiaryId = suppliedSubsidiaryId
    ? (subsidiaries.rows.some((row) => String(row.id).toLowerCase() === suppliedSubsidiaryId)
        ? suppliedSubsidiaryId
        : null)
    : (subsidiaries.rows[0] ? String(subsidiaries.rows[0].id) : null);
  if (suppliedSubsidiaryId && !subsidiaryId) {
    return bad("invalid_subsidiary", "subsidiaryId");
  }
  if (!subsidiaryId) {
    return NextResponse.json({ error: "no_available_subsidiary" }, { status: 409 });
  }

  const cost = moneyOrNull(body.acquisitionCost) ?? "0";
  if (cost === "unreadable" || cost === "too-wide") return bad("acquisition_cost_invalid", "acquisitionCost");
  if (cmp(cost, "0") < 0) return bad("acquisition_cost_negative", "acquisitionCost");
  const salvage = moneyOrNull(body.salvageValue) ?? "0";
  if (salvage === "unreadable" || salvage === "too-wide") return bad("salvage_value_invalid", "salvageValue");
  if (cmp(salvage, "0") < 0) return bad("salvage_value_negative", "salvageValue");
  if (cmp(salvage, cost) > 0) return bad("salvage_exceeds_cost", "salvageValue");

  const acquiredOn = strOrNull(body.acquiredOn);
  if (acquiredOn !== null && !isIsoCalendarDate(acquiredOn)) {
    return bad("acquired_on_invalid", "acquiredOn");
  }
  const inServiceOn = strOrNull(body.inServiceOn);
  if (inServiceOn !== null && !isIsoCalendarDate(inServiceOn)) {
    return bad("in_service_on_invalid", "inServiceOn");
  }

  const description = strOrNull(body.description);
  const serialNumber = strOrNull(body.serialNumber);
  const suppliedNumber = strOrNull(body.assetNumber);

  // Full drawer body, same rules as PATCH (shared ../_fields validators).
  // Nothing the operator fills in is silently dropped: every submitted
  // field is validated and stored, or its refusal names the remedy.
  let method: string | null = null;
  let depreciationMethodId: string | null = null;
  let lifeMonths: number | null = null;
  let ratePercent: string | null = null;
  let unitsTotal: string | null = null;
  let convention: string | null = null;
  let openingAccumulated: string | null = null;
  let openingAsOf: string | null = null;
  let assetAccountId: string | null = null;
  let accumAccountId: string | null = null;
  let expenseAccountId: string | null = null;
  let customBag: Record<string, unknown> = {};
  try {
    method = parseAssetMethod(body.method) ?? null;
    depreciationMethodId = (await parseDepreciationMethodId(db, user.orgId, body.depreciationMethodId)) ?? null;
    lifeMonths = parseLifeMonths(body.lifeMonths) ?? null;
    ratePercent = parseRatePercent(body.ratePercent) ?? null;
    unitsTotal = parseUnitsTotal(body.unitsTotal) ?? null;
    convention = parseAssetConvention(body.convention) ?? null;
    openingAccumulated = parseOpeningAmount(body.openingAccumulated) ?? null;
    openingAsOf = parseOpeningAsOf(body.openingAsOf) ?? null;
    checkOpeningPair(openingAccumulated, openingAsOf);
    checkOpeningBasis(openingAccumulated, cost, salvage);
    checkOpeningMonth(openingAccumulated, openingAsOf, inServiceOn);
    assetAccountId = (await parseAccountOverride(db, user.orgId, body.assetAccountId, "invalid_asset_account")) ?? null;
    accumAccountId =
      (await parseAccountOverride(db, user.orgId, body.accumulatedDepreciationAccountId, "invalid_accumulated_account")) ?? null;
    expenseAccountId =
      (await parseAccountOverride(db, user.orgId, body.depreciationExpenseAccountId, "invalid_expense_account")) ?? null;
    customBag = await parseCustomBag(user.orgId, body.custom);
    const taxClean = await parseTaxDepreciation(db, user.orgId, body.taxDepreciation);
    if (taxClean !== undefined) customBag.taxDepreciation = taxClean;
  } catch (error) {
    if (error instanceof FieldRefusal) {
      return bad(error.code, REFUSAL_FIELD[error.code]);
    }
    throw error;
  }

  // The idempotency snapshot pins the request, not the allocator: an
  // auto-assigned FA-#### is recomputed per attempt, so a legitimate retry
  // after an allocator race still matches. A supplied number IS the request.
  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    category_id: categoryId,
    subsidiary_id: subsidiaryId,
    asset_number: suppliedNumber,
    name,
    description,
    acquisition_cost: cost,
    salvage_value: salvage,
    acquired_on: acquiredOn,
    in_service_on: inServiceOn,
    opening_accumulated_depreciation: openingAccumulated,
    opening_accumulated_as_of: openingAsOf,
    serial_number: serialNumber,
    depreciation_method: method,
    depreciation_method_id: depreciationMethodId,
    useful_life_months: lifeMonths,
    depreciation_rate_percent: ratePercent,
    depreciation_units_total: unitsTotal,
    depreciation_convention: convention,
    asset_account_id: assetAccountId,
    accumulated_depreciation_account_id: accumAccountId,
    depreciation_expense_account_id: expenseAccountId,
    custom: customBag,
    status: "draft",
  };

  let createdId: string | null = null;
  let replayed = false;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const outcome = await db.transaction(async (tx) => {
          // Same org-wide fence as the legacy draft factory and the
          // equipment-capitalization path: max()+1 stays serialized across
          // every allocator, and the unique constraint is the final
          // authority for writers that take no fence.
          await tx.execute(sql`
            select pg_advisory_xact_lock(
              hashtextextended(${"equipment-capitalization:" + user.orgId}, 0)
            )`);
          let assetNumber = suppliedNumber;
          if (!assetNumber) {
            const nextRes = await tx.execute<{ n: number }>(sql`
              select coalesce(max((regexp_replace(asset_number, '\\D', '', 'g'))::int), 0) + 1 as n
                from fixed_assets
               where org_id = ${user.orgId} and asset_number ~ '^FA-\\d+$'`);
            assetNumber = `FA-${String(Number(nextRes.rows[0]?.n ?? 1)).padStart(4, "0")}`;
          }
          const inserted = await tx.execute<{ id: string }>(sql`
            insert into fixed_assets
              (id, org_id, category_id, subsidiary_id, asset_number, name, description,
               status, acquisition_cost, salvage_value, acquired_on, in_service_on,
               opening_accumulated_depreciation, opening_accumulated_as_of,
               serial_number, depreciation_method, depreciation_method_id,
               useful_life_months, depreciation_rate_percent, depreciation_units_total,
               depreciation_convention, asset_account_id,
               accumulated_depreciation_account_id, depreciation_expense_account_id,
               custom, created_by, updated_by)
            values
              (${requestId}, ${user.orgId}, ${categoryId}, ${subsidiaryId}, ${assetNumber},
               ${name}, ${description}, 'draft', ${cost}, ${salvage}, ${acquiredOn},
               ${inServiceOn}, ${openingAccumulated}, ${openingAsOf}, ${serialNumber},
               ${method}, ${depreciationMethodId}, ${lifeMonths}, ${ratePercent},
               ${unitsTotal}, ${convention}, ${assetAccountId}, ${accumAccountId},
               ${expenseAccountId}, ${JSON.stringify(customBag)}::jsonb,
               ${user.id}, ${user.id})
            on conflict (id) do nothing
            returning id`);
          if (!inserted.rows[0]) {
            const prior = await tx.execute<{ id: string }>(sql`
              select id from fixed_assets
               where id = ${requestId} and org_id = ${user.orgId}
            `);
            if (!prior.rows[0]) throw new Error("idempotency_key_conflict");
            const original = (
              await tx.execute<{ after: unknown }>(sql`
                select changes->'after' as after
                  from audit_log
                 where org_id = ${user.orgId}
                   and table_name = 'fixed_assets'
                   and row_id = ${requestId}
                   and action = 'insert'
                   and request_id = ${requestId}
                 order by at asc
                 limit 1
              `)
            ).rows[0]?.after;
            if (!original || canonicalJson(original) !== canonicalJson(snapshot)) {
              throw new Error("idempotency_key_conflict");
            }
            return { id: requestId, replayed: true };
          }
          await tx.execute(sql`
            insert into audit_log
              (org_id, table_name, row_id, action, changes, actor_id, request_id)
            values
              (${user.orgId}, 'fixed_assets', ${requestId}, 'insert',
               ${JSON.stringify({ before: null, after: snapshot })}::jsonb,
               ${user.id}, ${requestId})
          `);
          // A fresh row is always a draft, and drafts own no postable schedules
          // (only in-service assets do) — the schedule builds when the asset
          // is placed in service through PATCH.
          return { id: requestId, replayed: false };
        });
        createdId = outcome.id;
        replayed = outcome.replayed;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("idempotency_key_conflict")) throw error;
        const numberConflict = message.includes("fixed_assets_org_asset_number_unique");
        if (!numberConflict) throw error;
        // A supplied number names its remedy; an auto number recomputes
        // once the winner is committed, then retries inside this same save.
        if (suppliedNumber) return bad("asset_number_in_use", "assetNumber");
        if (attempt >= 2) return bad("asset_number_in_use", "assetNumber");
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("idempotency_key_conflict")) {
      return bad("invalid_idempotency_key", undefined, 409);
    }
    throw error;
  }

  if (!createdId) return bad("save_failed", undefined, 500);
  return NextResponse.json({ id: createdId }, { status: replayed ? 200 : 201 });
}
