import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { InventoryError, type Runner } from "./contracts.ts";

export type ScanField = "item" | "bin" | "lot" | "serial";

export type ScanCandidate = {
  id: string;
  itemId: string | null;
  label: string;
  kind: string;
  unit: string | null;
}

export type ScanResolution = ScanCandidate & {
  field: ScanField;
}

export type ScanLookupResult =
  | { result: "matched"; match: ScanResolution }
  | { result: "ambiguous"; candidates: readonly ScanCandidate[] }
  | { result: "none" };

export class ScanRefusal extends InventoryError {
  constructor(
    message: string,
    readonly code: string,
    readonly remedy: string,
    readonly status: 409 | 422,
    readonly candidates: readonly ScanCandidate[] = [],
  ) {
    super(message);
    this.name = "ScanRefusal";
  }
}

const FEATURES_REMEDY = "turn on Barcode scanning in Company Settings → Features";
const SCAN_REMEDY = "enter an exact value or choose a record from the picker";

export interface ResolveScanInput {
  field: ScanField;
  value: string;
  customerId?: string;
  itemId?: string;
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
}

async function assertBarcodeScanning(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, "barcodeScanning", runner))) {
    throw new ScanRefusal(
      `barcode scanning is turned off for this organization; ${FEATURES_REMEDY}`,
      "barcode_scanning_disabled",
      FEATURES_REMEDY,
      422,
    );
  }
}

function refuseUnknown(field: ScanField, value: string): never {
  throw new ScanRefusal(
    `no ${field} matches the exact scan value “${value}”; ${SCAN_REMEDY}`,
    "scan_not_found",
    SCAN_REMEDY,
    422,
  );
}

function refuseAmbiguous(field: ScanField, value: string, candidates: ScanCandidate[]): never {
  const names = candidates.map((candidate) => candidate.label).join("; ");
  const remedy = "scan a more specific identifier or choose the intended candidate from the picker";
  throw new ScanRefusal(
    `scan value “${value}” matches multiple ${field} records: ${names}; ${remedy}`,
    "ambiguous_scan",
    remedy,
    409,
    candidates,
  );
}

function exactValue(value: string, field: ScanField): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new ScanRefusal(`${field} scan value must contain 1 to 200 characters`, "invalid_scan", SCAN_REMEDY, 422);
  }
  return normalized;
}

/** Resolve exact scanner values inside one tenant. Ambiguity is refused across
 * identifier, item-code and customer-SKU namespaces so an overlap can never
 * silently direct a scan to a different product. */
export async function resolveScan(
  runner: Runner,
  orgId: string,
  input: ResolveScanInput,
): Promise<ScanResolution> {
  await assertBarcodeScanning(runner, orgId);
  const value = exactValue(input.value, input.field);

  if (input.field === "item") {
    const customerRefsEnabled = Boolean(input.customerId)
      && await orgFeatureEnabled(orgId, "customerPartNumbers", runner as SqlExecutor);
    const subsidiaries = input.allowedSubsidiaryIds == null ? null : [...input.allowedSubsidiaryIds];
    const customerScope = subsidiaries === null
      ? sql`true`
      : subsidiaries.length > 0
        ? sql`(p.subsidiary_id is null or p.subsidiary_id = any(${sql.param(subsidiaries)}::uuid[]))`
        : sql`p.subsidiary_id is null`;
    const matches = (await runner.execute<ScanCandidate & { priority: number }>(sql`
      select i.id, i.id as "itemId",
             coalesce(i.code || ' · ', '') || i.name as label,
             'code'::text as kind, null::text as unit, 2 as priority
        from items i
       where i.org_id = ${orgId} and i.code = ${value}
      union all
      select i.id, i.id as "itemId",
             coalesce(i.code || ' · ', '') || i.name as label,
             ii.kind, ii.unit, 1 as priority
        from item_identifiers ii
        join items i on i.id = ii.item_id and i.org_id = ii.org_id
       where ii.org_id = ${orgId} and ii.value = ${value}
      union all
      select i.id, i.id as "itemId",
             coalesce(i.code || ' · ', '') || i.name || ' · ' || cir.customer_sku as label,
             'customer_sku'::text as kind, null::text as unit, 3 as priority
        from customer_item_refs cir
        join items i on i.id = cir.item_id and i.org_id = cir.org_id
        join parties p on p.id = cir.customer_id and p.org_id = cir.org_id
        join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id and cr.is_active
       where cir.org_id = ${orgId} and cir.customer_sku = ${value}
         and ${input.customerId ?? null}::uuid is not null
         and cir.customer_id = ${input.customerId ?? null}
         and ${customerRefsEnabled}
         and ${customerScope}
       order by priority, label, id`)).rows;
    const bestByItem = new Map<string, ScanCandidate>();
    for (const candidate of matches) {
      if (!bestByItem.has(candidate.id)) {
        const { priority: _priority, ...resolved } = candidate;
        bestByItem.set(candidate.id, resolved);
      }
    }
    const distinctItems = [...bestByItem.values()];
    if (distinctItems.length === 0) return refuseUnknown(input.field, value);
    if (distinctItems.length > 1) return refuseAmbiguous(input.field, value, distinctItems);
    return { ...distinctItems[0]!, field: input.field };
  }

  if (input.field === "bin") {
    const subsidiaries = input.allowedSubsidiaryIds == null ? null : [...input.allowedSubsidiaryIds];
    const subsidiaryFilter = subsidiaries === null
      ? sql`true`
      : subsidiaries.length > 0
        ? sql`(l.subsidiary_id is null or l.subsidiary_id = any(${sql.param(subsidiaries)}::uuid[]))`
        : sql`l.subsidiary_id is null`;
    const matches = (await runner.execute<ScanCandidate>(sql`
      select sl.id, null::uuid as "itemId",
             sl.code || ' · ' || coalesce(l.name, l.code, 'stock location') as label,
             sl.kind, null::text as unit
        from stock_locations sl
        join locations l on l.id = sl.location_id and l.org_id = sl.org_id
       where sl.org_id = ${orgId} and sl.code = ${value} and sl.is_active
         and ${subsidiaryFilter}
       order by label, sl.id`)).rows;
    if (matches.length === 0) return refuseUnknown(input.field, value);
    if (matches.length > 1) return refuseAmbiguous(input.field, value, matches);
    return { ...matches[0]!, field: input.field };
  }

  if (!input.itemId) {
    throw new ScanRefusal(`${input.field} scanning requires an item selection first`, "scan_item_required", "select the item, then scan again", 422);
  }

  const matches = input.field === "lot"
    ? (await runner.execute<ScanCandidate>(sql`
        select l.id, l.item_id as "itemId",
               i.name || ' · lot ' || l.lot_number as label,
               'lot'::text as kind, null::text as unit
          from lots l join items i on i.id = l.item_id and i.org_id = l.org_id
         where l.org_id = ${orgId} and l.item_id = ${input.itemId} and l.lot_number = ${value}
         order by l.id`)).rows
    : (await runner.execute<ScanCandidate>(sql`
        select s.id, s.item_id as "itemId",
               i.name || ' · serial ' || s.serial_number as label,
               s.status as kind, null::text as unit
          from serials s
          join items i on i.id = s.item_id and i.org_id = s.org_id
          left join stock_locations sl on sl.id = s.current_stock_location_id and sl.org_id = s.org_id
          left join locations l on l.id = sl.location_id and l.org_id = sl.org_id
         where s.org_id = ${orgId} and s.item_id = ${input.itemId} and s.serial_number = ${value}
           and (${input.allowedSubsidiaryIds == null ? sql`true` : input.allowedSubsidiaryIds.size > 0
             ? sql`(l.subsidiary_id is null or l.subsidiary_id = any(${sql.param([...input.allowedSubsidiaryIds])}::uuid[]))`
             : sql`l.subsidiary_id is null`})
         order by s.id`)).rows;
  if (matches.length === 0) return refuseUnknown(input.field, value);
  if (matches.length > 1) return refuseAmbiguous(input.field, value, matches);
  return { ...matches[0]!, field: input.field };
}

/** Return lookup outcomes as data for interactive pickers. Callers that need
 * exactly one record can use resolveScan, which raises a typed refusal. */
export async function resolveScanResult(
  runner: Runner,
  orgId: string,
  input: ResolveScanInput,
): Promise<ScanLookupResult> {
  try {
    return { result: "matched", match: await resolveScan(runner, orgId, input) };
  } catch (error) {
    if (!(error instanceof ScanRefusal)) throw error;
    if (error.code === "ambiguous_scan") return { result: "ambiguous", candidates: error.candidates };
    if (error.code === "scan_not_found") return { result: "none" };
    throw error;
  }
}

/** Validate an optional scan unit against the item's stored base unit and
 * conversion map before a setup or import write. The conversion map's keys
 * are the supported alternate units; factors are never recalculated here. */
export async function validateIdentifierUnit(
  runner: Runner,
  orgId: string,
  itemId: string,
  unit: string | null,
): Promise<void> {
  await assertBarcodeScanning(runner, orgId);
  const row = (await runner.execute<{ item_unit: string | null; base_unit: string | null; unit_conversions: unknown }>(sql`
    select i.unit as item_unit, p.base_unit, p.unit_conversions
      from items i
      left join item_inventory_profiles p on p.item_id = i.id and p.org_id = i.org_id
     where i.org_id = ${orgId} and i.id = ${itemId}
     limit 1`)).rows[0];
  if (!row) {
    throw new ScanRefusal("item identifier must reference an item in this organization", "scan_item_out_of_scope", "select an item from this organization", 422);
  }
  if (unit === null || unit.trim() === "") return;
  const allowed = new Set<string>();
  for (const candidate of [row.base_unit, row.item_unit]) {
    if (candidate?.trim()) allowed.add(candidate.trim().toLowerCase());
  }
  if (row.unit_conversions && typeof row.unit_conversions === "object" && !Array.isArray(row.unit_conversions)) {
    for (const key of Object.keys(row.unit_conversions)) {
      if (key.trim()) allowed.add(key.trim().toLowerCase());
    }
  }
  if (!allowed.has(unit.trim().toLowerCase())) {
    const remedy = "use the item's base unit or add this unit to its inventory conversions";
    throw new ScanRefusal(`unit ${unit} is not a base or converted unit for this item; ${remedy}`, "invalid_identifier_unit", remedy, 422);
  }
}
