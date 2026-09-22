import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { canonicalJson } from "@openbooks/engine/src/platform/canonical-json.ts";
import { cmp, normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { guardFeaturePermission } from "../../../lib/feature-gates";
import { isFeatureEnabled } from "../../../lib/features";
import { isUuid } from "../../../lib/list-params";
import { canonicalDecimal } from "../../../lib/exact-decimal";

export const runtime = "nodejs";

// Typed collection body (never jsonObject: the financial-boundary ceiling
// only shrinks). Shape-only here — every domain refusal below keeps its
// stable snake code so the drawer can name the remedy.
const createEquipmentSchema = z.looseObject({
  name: z.string().optional(),
  unitNumber: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  subsidiaryId: z.string().optional().nullable(),
  chargeItemId: z.string().optional().nullable(),
  fixedAssetId: z.string().optional().nullable(),
  rateBookId: z.string().optional().nullable(),
  purchasePrice: z.union([z.string(), z.number()]).optional().nullable(),
  acquiredOn: z.string().optional().nullable(),
  inServiceOn: z.string().optional().nullable(),
  serialNumber: z.string().optional().nullable(),
  capacityQuantity: z.union([z.string(), z.number()]).optional().nullable(),
  capacityUnit: z.string().optional().nullable(),
  status: z.string().optional(),
});

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json(
    { error, code: error, ...(field ? { field } : {}) },
    { status },
  );
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Whole-digit width of a canonical decimal: numeric(19,4) holds 15. */
function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length;
}

/**
 * Create one tenant-owned equipment unit as draft.
 *
 * The unsaved-create contract (exemplar: POST /api/accounts): opening New
 * allocates nothing — no record, no EQ-#### number, no audit row. Save
 * performs exactly one idempotent insert here. The caller supplies a UUID
 * idempotency key, which becomes the unit ID: retrying the same request
 * returns the same id without a duplicate insert or audit event, while
 * reusing the key for a changed request is a 409 conflict.
 *
 * Creation always yields draft and never requires a charge item: activation
 * still demands a name plus a charge item through PATCH
 * /api/equipment/[id], so lifecycle semantics after creation are unchanged.
 */
export async function POST(request: Request) {
  const gate = await guardFeaturePermission("assets.manage", "equipment");
  if (gate instanceof NextResponse) return gate;
  const user = gate.user;

  const requestId = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!isUuid(requestId)) return bad("invalid_idempotency_key", undefined, 400);

  const parsedBody = await parseJsonBody(request, createEquipmentSchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;

  if (body.status !== undefined && body.status !== "draft") {
    return bad("unsupported_status_transition", "status");
  }

  const name = body.name?.trim() ?? "";
  if (!name) return bad("name_required", "name");

  const suppliedSubsidiaryId = textOrNull(body.subsidiaryId)?.toLowerCase() ?? null;
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
    return NextResponse.json(
      { error: "no_available_subsidiary", code: "no_available_subsidiary" },
      { status: 409 },
    );
  }

  const chargeItemId = textOrNull(body.chargeItemId)?.toLowerCase() ?? null;
  if (chargeItemId) {
    if (!isUuid(chargeItemId)) return bad("charge_item_not_found", "chargeItemId");
    const item = await db.execute(sql`
      select 1 from items
       where id = ${chargeItemId} and org_id = ${user.orgId}
         and kind = 'equipment_charge' and is_active
    `);
    if (!item.rows[0]) return bad("charge_item_not_found", "chargeItemId");
  }

  const fixedAssetId = textOrNull(body.fixedAssetId)?.toLowerCase() ?? null;
  if (fixedAssetId) {
    if (!(await isFeatureEnabled(user.orgId, "fixedAssets"))) {
      return NextResponse.json({ error: "not_found", code: "not_found" }, { status: 404 });
    }
    if (!isUuid(fixedAssetId)) return bad("invalid_fixed_asset", "fixedAssetId");
    const found = await db.execute<{ subsidiary_id: string }>(sql`
      select subsidiary_id from fixed_assets
       where id = ${fixedAssetId} and org_id = ${user.orgId}
    `);
    if (!found.rows[0]) return bad("fixed_asset_not_found", "fixedAssetId");
    if (String(found.rows[0].subsidiary_id) !== String(subsidiaryId)) {
      return bad("subsidiary_mismatch", "fixedAssetId");
    }
  }

  const rateBookId = textOrNull(body.rateBookId)?.toLowerCase() ?? null;
  if (rateBookId) {
    if (!(await isFeatureEnabled(user.orgId, "projects"))) {
      return NextResponse.json({ error: "not_found", code: "not_found" }, { status: 404 });
    }
    if (!isUuid(rateBookId)) return bad("invalid_rate_book", "rateBookId");
    const found = await db.execute(sql`
      select 1 from item_rate_books
       where id = ${rateBookId} and org_id = ${user.orgId} and is_active
    `);
    if (!found.rows[0]) return bad("rate_book_not_found", "rateBookId");
  }

  const priceRaw = body.purchasePrice ?? "0";
  const priceExact =
    priceRaw === null || priceRaw === "" ? "0.0000" : canonicalDecimal(priceRaw, 4);
  if (priceExact === null || wholeDigits(priceExact) > 15) {
    return bad("purchase_price_invalid", "purchasePrice");
  }
  let purchasePrice = priceExact;
  try {
    purchasePrice = normalizeMoney(priceExact);
  } catch {
    return bad("purchase_price_invalid", "purchasePrice");
  }
  if (cmp(purchasePrice, "0") < 0) return bad("purchase_price_negative", "purchasePrice");

  const acquiredOn = textOrNull(body.acquiredOn);
  if (acquiredOn !== null && !isIsoCalendarDate(acquiredOn)) {
    return bad("acquired_on_invalid", "acquiredOn");
  }
  const inServiceOn = textOrNull(body.inServiceOn);
  if (inServiceOn !== null && !isIsoCalendarDate(inServiceOn)) {
    return bad("in_service_on_invalid", "inServiceOn");
  }
  if (acquiredOn && inServiceOn && inServiceOn < acquiredOn) {
    return bad("in_service_before_acquisition", "inServiceOn");
  }

  const capacityInput = textOrNull(body.capacityQuantity);
  let capacityQuantity: string | null = null;
  if (capacityInput !== null) {
    const capacityRaw = canonicalDecimal(capacityInput, 4);
    if (capacityRaw === null || wholeDigits(capacityRaw) > 15) {
      return bad("capacity_invalid", "capacityQuantity");
    }
    try {
      capacityQuantity = normalizeMoney(capacityRaw);
    } catch {
      return bad("capacity_invalid", "capacityQuantity");
    }
    if (cmp(capacityQuantity, "0") <= 0) return bad("capacity_not_positive", "capacityQuantity");
  }

  const description = textOrNull(body.description);
  const serialNumber = textOrNull(body.serialNumber);
  const capacityUnit = textOrNull(body.capacityUnit);
  const suppliedNumber = textOrNull(body.unitNumber);

  // The idempotency snapshot pins the request, not the allocator: an
  // auto-assigned EQ-#### is recomputed per attempt, so a legitimate retry
  // after an allocator race still matches. A supplied number IS the request.
  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    subsidiary_id: subsidiaryId,
    unit_number: suppliedNumber,
    name,
    description,
    charge_item_id: chargeItemId,
    fixed_asset_id: fixedAssetId,
    rate_book_id: rateBookId,
    purchase_price: purchasePrice,
    acquired_on: acquiredOn,
    in_service_on: inServiceOn,
    serial_number: serialNumber,
    capacity_quantity: capacityQuantity,
    capacity_unit: capacityUnit,
    status: "draft",
  };

  let createdId: string | null = null;
  let replayed = false;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const outcome = await db.transaction(async (tx) => {
          // Same org fence as the legacy equipment draft factory so
          // max()+1 stays serialized across every allocator; the unique
          // index is the final authority for writers that take no fence.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${user.orgId}::text))`);
          let unitNumber = suppliedNumber;
          if (!unitNumber) {
            const nextRes = await tx.execute<{ n: number }>(sql`
              select coalesce(max((regexp_replace(unit_number, '\\D', '', 'g'))::int), 0) + 1 as n
                from equipment_units
               where org_id = ${user.orgId} and unit_number ~ '^EQ-\\d+$'`);
            unitNumber = `EQ-${String(Number(nextRes.rows[0]?.n ?? 1)).padStart(4, "0")}`;
          }
          const inserted = await tx.execute<{ id: string }>(sql`
            insert into equipment_units
              (id, org_id, subsidiary_id, unit_number, name, description, status,
               charge_item_id, fixed_asset_id, rate_book_id, purchase_price,
               acquired_on, in_service_on, serial_number, capacity_quantity,
               capacity_unit, created_by, updated_by)
            values
              (${requestId}, ${user.orgId}, ${subsidiaryId}, ${unitNumber}, ${name},
               ${description}, 'draft', ${chargeItemId}, ${fixedAssetId}, ${rateBookId},
               ${purchasePrice}, ${acquiredOn}, ${inServiceOn}, ${serialNumber},
               ${capacityQuantity}, ${capacityUnit}, ${user.id}, ${user.id})
            on conflict (id) do nothing
            returning id`);
          if (!inserted.rows[0]) {
            const prior = await tx.execute<{ id: string }>(sql`
              select id from equipment_units
               where id = ${requestId} and org_id = ${user.orgId}
            `);
            if (!prior.rows[0]) throw new Error("idempotency_key_conflict");
            const original = (
              await tx.execute<{ after: unknown }>(sql`
                select changes->'after' as after
                  from audit_log
                 where org_id = ${user.orgId}
                   and table_name = 'equipment_units'
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
              (${user.orgId}, 'equipment_units', ${requestId}, 'insert',
               ${JSON.stringify({ before: null, after: snapshot })}::jsonb,
               ${user.id}, ${requestId})
          `);
          return { id: requestId, replayed: false };
        });
        createdId = outcome.id;
        replayed = outcome.replayed;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("idempotency_key_conflict")) throw error;
        const numberConflict = message.includes("equipment_units_org_number");
        if (!numberConflict) throw error;
        // A supplied number names its remedy; an auto number recomputes
        // once the winner is committed, then retries inside this same save.
        if (suppliedNumber) return bad("unit_number_in_use", "unitNumber");
        if (attempt >= 2) return bad("unit_number_in_use", "unitNumber");
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
