import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../db.ts";
import { documentRevisionSql } from "../document-revision.ts";
import { div, normalizeDecimal } from "../money.ts";
import type {
  AccountScope,
  AllocationDimension,
  AllocationDriver,
  AllocationDriverSourceKind,
  DriverVector,
  ReportTemporalMode,
} from "./types.ts";

/**
 * Driver registry administration (A8).
 *
 * A2 (`drivers.ts`) owns driver evaluation (`resolveDriverVector`) and the
 * manual values read path; this module owns the registry WRITES the Drivers
 * tab needs: driver CRUD plus effective-dated manual value maintenance. It
 * codes only against the frozen `types.ts` contract and the 0160 schema, so
 * A2 can reuse these validators without a file dependency in either
 * direction.
 */

export const DRIVER_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const NATIVE_MEASURES = [
  "headcount",
  "labor_hours",
  "billed_hours",
  "labor_cost",
  "revenue",
  "direct_cost",
  "rentable_area",
] as const;
export type NativeMeasure = (typeof NATIVE_MEASURES)[number];

const BUILTIN_DIMENSIONS = ["department", "location", "class", "project", "subsidiary"] as const;

export const DRIVER_SOURCE_KINDS: readonly AllocationDriverSourceKind[] = [
  "statistical_journal",
  "gl_activity",
  "gl_balance",
  "native_measure",
  "manual",
  "report_definition",
];

/**
 * What the requested period means for a `report_definition` driver:
 * `period_activity` weighs the from..to window, `balance_as_of` weighs the
 * snapshot at to, `fixed_query` weighs the report's own scope untouched.
 * The vocabulary lives in `types.ts`; this is its runtime list.
 */
export const REPORT_TEMPORAL_MODES: readonly ReportTemporalMode[] = [
  "period_activity",
  "balance_as_of",
  "fixed_query",
];

export type DriverAdminCode = "validation" | "not_found" | "conflict" | "referenced" | "stale";

export class DriverAdminError extends Error {
  readonly code: DriverAdminCode;
  readonly status: number;
  constructor(code: DriverAdminCode, message: string) {
    super(message);
    this.name = "DriverAdminError";
    this.code = code;
    this.status = code === "not_found" ? 404 : code === "conflict" || code === "referenced" ? 409 : code === "stale" ? 412 : 400;
  }
}

function fail(code: DriverAdminCode, message: string): never {
  throw new DriverAdminError(code, message);
}

/** Walk the drizzle/postgres error chain for a named unique violation. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string };
    if (candidate.code === "23505" && candidate.constraint === constraint) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Optimistic-concurrency check on the canonical revision token (the same
 * documentRevisionSql spelling rule mutations use). undefined skips the
 * check; anything else must match exactly.
 */
async function requireDriverRevision(
  tx: SqlExecutor,
  table: "allocation_drivers" | "allocation_driver_values",
  orgId: string,
  id: string,
  expected: string | undefined,
  what: string,
): Promise<void> {
  if (expected === undefined) return;
  const rows = await tx.execute<{ match: boolean }>(sql`
    select (${documentRevisionSql(sql`updated_at`)} = ${expected}) as match
      from ${sql.raw(table)} where org_id = ${orgId} and id = ${id}`);
  if (!rows.rows[0]?.match) fail("stale", `${what} changed since you read it; reload and retry`);
}

/** Bind a uuid array for `= any(...::uuid[])` (drizzle has no array params). */
function uuidArray(ids: string[]) {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Driver keys are org-unique slugs (same rule as allocation rule keys). */
export function validateDriverKey(key: unknown): string {
  if (typeof key !== "string" || !DRIVER_KEY_RE.test(key)) {
    fail("validation", "key must be a slug: lowercase letters, digits, - or _");
  }
  return key as string;
}

/** Built-in dimensions plus `extra:<segmentKey>` custom segments. */
export function parseAllocationDimension(dimension: unknown): AllocationDimension {
  if (typeof dimension !== "string") fail("validation", "dimension is required");
  const value = dimension as string;
  if ((BUILTIN_DIMENSIONS as readonly string[]).includes(value)) return value as AllocationDimension;
  const extra = /^extra:([a-z0-9][a-z0-9_-]{0,63})$/.exec(value);
  if (extra) return value as AllocationDimension;
  fail("validation", `unknown dimension: ${value}`);
}

function validateAccountScope(scope: unknown): AccountScope {
  if (!isRecord(scope)) fail("validation", "accountScope is required");
  const kind = (scope as Record<string, unknown>).kind;
  if (kind === "any") return { kind: "any" };
  if (kind === "accounts") {
    const ids = (scope as Record<string, unknown>).accountIds;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isUuid)) {
      fail("validation", "accountScope.accountIds must be a non-empty uuid array");
    }
    return { kind: "accounts", accountIds: ids as string[] };
  }
  if (kind === "account_group") {
    const rec = scope as Record<string, unknown>;
    if (typeof rec.dimension !== "string" || !rec.dimension || typeof rec.groupKey !== "string" || !rec.groupKey) {
      fail("validation", "accountScope.account_group needs dimension and groupKey");
    }
    return { kind: "account_group", dimension: rec.dimension, groupKey: rec.groupKey };
  }
  fail("validation", `unknown accountScope kind: ${String(kind)}`);
}

/**
 * Validate + canonicalize a driver config for its source kind. Returns the
 * stored shape (unknown fields are dropped so later kinds stay forward
 * compatible with older reads).
 */
export function validateDriverConfig(
  sourceKind: AllocationDriverSourceKind,
  config: unknown,
): Record<string, unknown> {
  const rec = isRecord(config) ? config : {};
  switch (sourceKind) {
    case "statistical_journal": {
      const unit = typeof rec.unit === "string" ? rec.unit.trim() : "";
      if (!unit) fail("validation", "config.unit is required for statistical journals");
      const out: Record<string, unknown> = { unit };
      if (rec.accountIds !== undefined) {
        if (!Array.isArray(rec.accountIds) || !rec.accountIds.every(isUuid)) {
          fail("validation", "config.accountIds must be a uuid array");
        }
        out.accountIds = rec.accountIds;
      }
      return out;
    }
    case "gl_activity":
    case "gl_balance":
      return { accountScope: validateAccountScope(rec.accountScope) };
    case "native_measure": {
      if (typeof rec.measure !== "string" || !(NATIVE_MEASURES as readonly string[]).includes(rec.measure)) {
        fail("validation", `config.measure must be one of: ${NATIVE_MEASURES.join(", ")}`);
      }
      return { measure: rec.measure };
    }
    case "manual":
      return {};
    case "report_definition": {
      if (!isUuid(rec.reportDefinitionId)) fail("validation", "config.reportDefinitionId must be a uuid");
      if (typeof rec.dimensionColumn !== "string" || !rec.dimensionColumn.trim()) {
        fail("validation", "config.dimensionColumn is required");
      }
      if (typeof rec.valueColumn !== "string" || !rec.valueColumn.trim()) {
        fail("validation", "config.valueColumn is required");
      }
      // The temporal contract declaring what the requested period means for
      // this driver. Absence keeps the historical as-of behavior, now echoed
      // instead of silent; anything outside the vocabulary is refused.
      const temporalMode = rec.temporalMode === undefined || rec.temporalMode === null
        ? "balance_as_of"
        : rec.temporalMode;
      if (!(REPORT_TEMPORAL_MODES as readonly string[]).includes(temporalMode as string)) {
        fail("validation", `config.temporalMode must be one of: ${REPORT_TEMPORAL_MODES.join(", ")}`);
      }
      return {
        reportDefinitionId: rec.reportDefinitionId,
        dimensionColumn: (rec.dimensionColumn as string).trim(),
        valueColumn: (rec.valueColumn as string).trim(),
        params: isRecord(rec.params) ? rec.params : {},
        temporalMode,
      };
    }
  }
}

/** Manual driver values are non-negative decimals with at most 4 places. */
export function validateDriverValueDecimal(value: unknown): string {
  let canonical: string;
  try {
    canonical = normalizeDecimal(value as string, 4);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/beyond 4 decimal places/.test(message)) fail("validation", `value keeps exact decimals (precision 4): ${String(value)}`);
    fail("validation", `value must be a decimal number: ${String(value)}`);
  }
  if (canonical!.startsWith("-")) fail("validation", "value must be >= 0");
  return canonical!;
}

export function validateIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail("validation", `${field} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}

export interface EffectiveWindow {
  from: string;
  to: string | null;
}

/** Closed-open sharing: windows sharing a boundary day overlap. */
export function driverValueWindowsOverlap(a: EffectiveWindow, b: EffectiveWindow): boolean {
  const aTo = a.to ?? "9999-12-31";
  const bTo = b.to ?? "9999-12-31";
  return a.from <= bTo && b.from <= aTo;
}

export interface CreateDriverInput {
  key: string;
  name: string;
  description?: string | null;
  unit?: string | null;
  dimension: string;
  sourceKind: AllocationDriverSourceKind;
  config?: unknown;
  isActive?: boolean;
}

export interface UpdateDriverInput {
  name?: string;
  description?: string | null;
  unit?: string | null;
  dimension?: string;
  sourceKind?: AllocationDriverSourceKind;
  config?: unknown;
  isActive?: boolean;
  /** Optimistic concurrency: the updated_at the caller read. */
  expectedUpdatedAt?: string;
}

export interface DriverValueInput {
  dimensionValueId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  value: string;
  note?: string | null;
}

export interface DriverValueRow {
  id: string;
  orgId: string;
  driverId: string;
  dimensionValueId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  value: string;
  note: string | null;
}

function mapDriver(row: Record<string, unknown>): AllocationDriver {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    key: String(row.key),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    updatedAt: typeof row.revision === "string" ? row.revision : null,
    unit: (row.unit as string | null) ?? null,
    dimension: String(row.dimension) as AllocationDimension,
    sourceKind: String(row.source_kind) as AllocationDriverSourceKind,
    config: (row.config as Record<string, unknown>) ?? {},
    isActive: Boolean(row.is_active),
  };
}

function mapDriverValue(row: Record<string, unknown>): DriverValueRow {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    driverId: String(row.driver_id),
    dimensionValueId: String(row.dimension_value_id),
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to == null ? null : String(row.effective_to).slice(0, 10),
    value: String(row.value),
    note: (row.note as string | null) ?? null,
  };
}

async function audit(
  tx: SqlExecutor,
  orgId: string,
  table: string,
  rowId: string,
  action: string,
  changes: unknown,
  actorId: string,
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
  `);
}

async function assertAccountScopeOrg(tx: SqlExecutor, orgId: string, scope: AccountScope): Promise<void> {
  if (scope.kind === "accounts") {
    const found = await tx.execute<{ id: string }>(sql`
      select id from accounts where org_id = ${orgId} and id = any(${uuidArray(scope.accountIds)})
    `);
    if (found.rows.length !== scope.accountIds.length) {
      fail("validation", "accountScope.accountIds must reference accounts in this org");
    }
  }
}

async function assertStatisticalAccountsOrg(
  tx: SqlExecutor,
  orgId: string,
  config: Record<string, unknown>,
): Promise<void> {
  if (config.accountIds === undefined) return;
  const ids = config.accountIds as string[];
  const found = await tx.execute<{ id: string }>(sql`
    select id from accounts where org_id = ${orgId} and id = any(${uuidArray(ids)})
  `);
  if (found.rows.length !== ids.length) {
    fail("validation", "config.accountIds must reference accounts in this org");
  }
}

export async function listDrivers(
  orgId: string,
  opts?: { includeInactive?: boolean; executor?: SqlExecutor },
): Promise<AllocationDriver[]> {
  const ex = opts?.executor ?? db;
  const rows = opts?.includeInactive
    ? await ex.execute<Record<string, unknown>>(sql`
        select *, ${documentRevisionSql(sql`updated_at`)} as revision
          from allocation_drivers where org_id = ${orgId} order by name, key`)
    : await ex.execute<Record<string, unknown>>(sql`
        select *, ${documentRevisionSql(sql`updated_at`)} as revision
          from allocation_drivers where org_id = ${orgId} and is_active order by name, key`);
  return rows.rows.map(mapDriver);
}

export async function getDriver(
  orgId: string,
  id: string,
  executor?: SqlExecutor,
): Promise<AllocationDriver | null> {
  if (!isUuid(id)) return null;
  const ex = executor ?? db;
  const rows = await ex.execute<Record<string, unknown>>(sql`
    select *, ${documentRevisionSql(sql`updated_at`)} as revision
      from allocation_drivers where org_id = ${orgId} and id = ${id}`);
  const row = rows.rows[0];
  return row ? mapDriver(row) : null;
}

export async function createDriver(
  orgId: string,
  actorId: string,
  input: CreateDriverInput,
): Promise<AllocationDriver> {
  const key = validateDriverKey(input.key);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) fail("validation", "name is required");
  const dimension = parseAllocationDimension(input.dimension);
  if (!DRIVER_SOURCE_KINDS.includes(input.sourceKind)) {
    fail("validation", `unknown sourceKind: ${String(input.sourceKind)}`);
  }
  const config = validateDriverConfig(input.sourceKind, input.config);
  return db.transaction(async (tx) => {
    await assertAccountScopeOrg(tx, orgId, (config.accountScope as AccountScope | undefined) ?? { kind: "any" });
    if (input.sourceKind === "statistical_journal") await assertStatisticalAccountsOrg(tx, orgId, config);
    let row: Record<string, unknown>;
    try {
      const inserted = await tx.execute<Record<string, unknown>>(sql`
        insert into allocation_drivers
          (org_id, key, name, description, unit, dimension, source_kind, config, is_active, created_by, updated_by)
        values
          (${orgId}, ${key}, ${name}, ${input.description ?? null}, ${input.unit ?? null},
           ${dimension}, ${input.sourceKind}, ${JSON.stringify(config)}::jsonb,
           ${input.isActive ?? true}, ${actorId}, ${actorId})
        returning *, ${documentRevisionSql(sql`updated_at`)} as revision`);
      row = inserted.rows[0]!;
    } catch (error) {
      if (isUniqueViolation(error, "allocation_drivers_org_key")) {
        fail("conflict", `driver key already exists: ${key}`);
      }
      throw error;
    }
    await audit(tx, orgId, "allocation_drivers", String(row.id), "insert", { after: row }, actorId);
    return mapDriver(row);
  });
}

export async function updateDriver(
  orgId: string,
  actorId: string,
  id: string,
  patch: UpdateDriverInput,
): Promise<AllocationDriver> {
  if (!isUuid(id)) fail("not_found", "driver not found");
  return db.transaction(async (tx) => {
    const current = await tx.execute<Record<string, unknown>>(sql`
      select * from allocation_drivers where org_id = ${orgId} and id = ${id} for update`);
    const before = current.rows[0];
    if (!before) fail("not_found", "driver not found");
    await requireDriverRevision(tx, "allocation_drivers", orgId, id, patch.expectedUpdatedAt, "driver");
    const nextSourceKind = patch.sourceKind ?? (String(before.source_kind) as AllocationDriverSourceKind);
    if (!DRIVER_SOURCE_KINDS.includes(nextSourceKind)) {
      fail("validation", `unknown sourceKind: ${String(patch.sourceKind)}`);
    }
    // Changing the dimensionality of live manual values would silently
    // re-target history: refuse while values exist.
    const nextDimension = patch.dimension !== undefined ? parseAllocationDimension(patch.dimension) : String(before.dimension);
    if (nextDimension !== String(before.dimension)) {
      const values = await tx.execute<{ n: string }>(sql`
        select count(*) as n from allocation_driver_values where org_id = ${orgId} and driver_id = ${id}`);
      if (Number(values.rows[0]?.n ?? 0) > 0) {
        fail("conflict", "dimension cannot change while manual values exist");
      }
    }
    const nextConfig = patch.config !== undefined || patch.sourceKind !== undefined
      ? validateDriverConfig(nextSourceKind, patch.config ?? before.config)
      : (before.config as Record<string, unknown>);
    await assertAccountScopeOrg(tx, orgId, (nextConfig.accountScope as AccountScope | undefined) ?? { kind: "any" });
    if (nextSourceKind === "statistical_journal") await assertStatisticalAccountsOrg(tx, orgId, nextConfig);
    const name = patch.name !== undefined ? patch.name.trim() : String(before.name);
    if (!name) fail("validation", "name is required");
    const updated = await tx.execute<Record<string, unknown>>(sql`
      update allocation_drivers
         set name = ${name},
             description = ${patch.description !== undefined ? patch.description : (before.description as string | null)},
             unit = ${patch.unit !== undefined ? patch.unit : (before.unit as string | null)},
             dimension = ${nextDimension},
             source_kind = ${nextSourceKind},
             config = ${JSON.stringify(nextConfig)}::jsonb,
             is_active = ${patch.isActive ?? Boolean(before.is_active)},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id}
       returning *, ${documentRevisionSql(sql`updated_at`)} as revision`);
    const after = updated.rows[0]!;
    await audit(tx, orgId, "allocation_drivers", id, "update", { before, after }, actorId);
    return mapDriver(after);
  });
}

export async function deleteDriver(
  orgId: string,
  actorId: string,
  id: string,
): Promise<void> {
  if (!isUuid(id)) fail("not_found", "driver not found");
  await db.transaction(async (tx) => {
    const current = await tx.execute<Record<string, unknown>>(sql`
      select * from allocation_drivers where org_id = ${orgId} and id = ${id} for update`);
    const before = current.rows[0];
    if (!before) fail("not_found", "driver not found");
    const refs = await tx.execute<{ n: string }>(sql`
      select count(*) as n from allocation_rule_versions where org_id = ${orgId} and driver_id = ${id}`);
    if (Number(refs.rows[0]?.n ?? 0) > 0) {
      fail("referenced", "driver is used by a rule version and cannot be deleted");
    }
    await tx.execute(sql`delete from allocation_driver_values where org_id = ${orgId} and driver_id = ${id}`);
    await tx.execute(sql`delete from allocation_drivers where org_id = ${orgId} and id = ${id}`);
    await audit(tx, orgId, "allocation_drivers", id, "delete", { before }, actorId);
  });
}

export async function listDriverValues(
  orgId: string,
  driverId: string,
  opts?: { onDate?: string; executor?: SqlExecutor },
): Promise<DriverValueRow[]> {
  if (!isUuid(driverId)) return [];
  if (opts?.onDate !== undefined) validateIsoDate(opts.onDate, "onDate");
  const ex = opts?.executor ?? db;
  if (opts?.onDate) {
    const rows = await ex.execute<Record<string, unknown>>(sql`
      select * from allocation_driver_values
       where org_id = ${orgId} and driver_id = ${driverId}
         and effective_from <= ${opts.onDate}
         and (effective_to is null or effective_to >= ${opts.onDate})
       order by dimension_value_id`);
    return rows.rows.map(mapDriverValue);
  }
  const rows = await ex.execute<Record<string, unknown>>(sql`
    select * from allocation_driver_values
     where org_id = ${orgId} and driver_id = ${driverId}
     order by dimension_value_id, effective_from`);
  return rows.rows.map(mapDriverValue);
}

async function assertNoValueOverlap(
  tx: SqlExecutor,
  orgId: string,
  driverId: string,
  dimensionValueId: string,
  window: EffectiveWindow,
  ignoreId?: string,
): Promise<void> {
  const existing = ignoreId
    ? await tx.execute<{ effective_from: string; effective_to: string | null }>(sql`
        select effective_from::text as effective_from, effective_to::text as effective_to
          from allocation_driver_values
         where org_id = ${orgId} and driver_id = ${driverId} and dimension_value_id = ${dimensionValueId}
           and id <> ${ignoreId}`)
    : await tx.execute<{ effective_from: string; effective_to: string | null }>(sql`
        select effective_from::text as effective_from, effective_to::text as effective_to
          from allocation_driver_values
         where org_id = ${orgId} and driver_id = ${driverId} and dimension_value_id = ${dimensionValueId}`);
  for (const row of existing.rows) {
    if (driverValueWindowsOverlap(window, { from: String(row.effective_from).slice(0, 10), to: row.effective_to ? String(row.effective_to).slice(0, 10) : null })) {
      fail("conflict", "effective window overlaps an existing value for this dimension value");
    }
  }
}

export async function createDriverValue(
  orgId: string,
  actorId: string,
  driverId: string,
  input: DriverValueInput,
): Promise<DriverValueRow> {
  if (!isUuid(driverId)) fail("not_found", "driver not found");
  if (!isUuid(input.dimensionValueId)) fail("validation", "dimensionValueId must be a uuid");
  const from = validateIsoDate(input.effectiveFrom, "effectiveFrom");
  const to = input.effectiveTo == null || input.effectiveTo === "" ? null : validateIsoDate(input.effectiveTo, "effectiveTo");
  if (to !== null && to < from) fail("validation", "effectiveTo must be on or after effectiveFrom");
  const value = validateDriverValueDecimal(input.value);
  return db.transaction(async (tx) => {
    const driver = await tx.execute<Record<string, unknown>>(sql`
      select id from allocation_drivers where org_id = ${orgId} and id = ${driverId}`);
    if (!driver.rows[0]) fail("not_found", "driver not found");
    await assertNoValueOverlap(tx, orgId, driverId, input.dimensionValueId, { from, to });
    let row: Record<string, unknown>;
    try {
      const inserted = await tx.execute<Record<string, unknown>>(sql`
        insert into allocation_driver_values
          (org_id, driver_id, dimension_value_id, effective_from, effective_to, value, note, created_by, updated_by)
        values
          (${orgId}, ${driverId}, ${input.dimensionValueId}, ${from}, ${to}, ${value}, ${input.note ?? null}, ${actorId}, ${actorId})
        returning *, ${documentRevisionSql(sql`updated_at`)} as revision`);
      row = inserted.rows[0]!;
    } catch (error) {
      if (isUniqueViolation(error, "allocation_driver_values_unique")) {
        fail("conflict", "a value already starts on this date for this dimension value");
      }
      throw error;
    }
    await audit(tx, orgId, "allocation_driver_values", String(row.id), "insert", { after: row }, actorId);
    return mapDriverValue(row);
  });
}

export async function updateDriverValue(
  orgId: string,
  actorId: string,
  id: string,
  patch: { effectiveTo?: string | null; value?: string; note?: string | null; expectedUpdatedAt?: string },
): Promise<DriverValueRow> {
  if (!isUuid(id)) fail("not_found", "driver value not found");
  return db.transaction(async (tx) => {
    const current = await tx.execute<Record<string, unknown>>(sql`
      select * from allocation_driver_values where org_id = ${orgId} and id = ${id} for update`);
    const before = current.rows[0];
    if (!before) fail("not_found", "driver value not found");
    await requireDriverRevision(tx, "allocation_driver_values", orgId, id, patch.expectedUpdatedAt, "driver value");
    // effectiveFrom is immutable: the unique key is (driver, value, from), so
    // a start-date change is a delete + insert, never a silent re-key.
    const from = String(before.effective_from).slice(0, 10);
    const to = patch.effectiveTo !== undefined
      ? (patch.effectiveTo == null || patch.effectiveTo === "" ? null : validateIsoDate(patch.effectiveTo, "effectiveTo"))
      : before.effective_to == null ? null : String(before.effective_to).slice(0, 10);
    if (to !== null && to < from) fail("validation", "effectiveTo must be on or after effectiveFrom");
    const value = patch.value !== undefined ? validateDriverValueDecimal(patch.value) : String(before.value);
    await assertNoValueOverlap(
      tx, orgId, String(before.driver_id), String(before.dimension_value_id), { from, to }, id,
    );
    const updated = await tx.execute<Record<string, unknown>>(sql`
      update allocation_driver_values
         set effective_to = ${to}, value = ${value},
             note = ${patch.note !== undefined ? patch.note : (before.note as string | null)},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id}
       returning *, ${documentRevisionSql(sql`updated_at`)} as revision`);
    const after = updated.rows[0]!;
    await audit(tx, orgId, "allocation_driver_values", id, "update", { before, after }, actorId);
    return mapDriverValue(after);
  });
}

export async function deleteDriverValue(
  orgId: string,
  actorId: string,
  id: string,
): Promise<void> {
  if (!isUuid(id)) fail("not_found", "driver value not found");
  await db.transaction(async (tx) => {
    const current = await tx.execute<Record<string, unknown>>(sql`
      select * from allocation_driver_values where org_id = ${orgId} and id = ${id} for update`);
    const before = current.rows[0];
    if (!before) fail("not_found", "driver value not found");
    await tx.execute(sql`delete from allocation_driver_values where org_id = ${orgId} and id = ${id}`);
    await audit(tx, orgId, "allocation_driver_values", id, "delete", { before }, actorId);
  });
}

/**
 * Display names for driver vector keys (dimension value ids). Custom
 * segments have no fixed label table: the caller falls back to ids.
 */
export async function getDimensionValueLabels(
  orgId: string,
  dimension: AllocationDimension,
  ids: string[],
  executor?: SqlExecutor,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (ids.length === 0) return labels;
  const table =
    dimension === "department" ? "departments"
    : dimension === "location" ? "locations"
    : dimension === "class" ? "classes"
    : dimension === "project" ? "projects"
    : dimension === "subsidiary" ? "subsidiaries"
    : null;
  if (!table) return labels;
  const ex = executor ?? db;
  const rows = await ex.execute<{ id: string; name: string }>(sql`
    select id::text as id, name from ${sql.raw(table)}
     where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`);
  for (const row of rows.rows) labels.set(row.id, row.name);
  return labels;
}

/** Exact display shares (4dp, bigint math) for a preview vector. Zero-safe. */
export function vectorShares(vector: DriverVector): Map<string, string> {
  const shares = new Map<string, string>();
  if (vector.size === 0) return shares;
  let total = "0";
  for (const value of vector.values()) {
    const [whole = "0", fraction = ""] = value.split(".");
    total = addDecimal(total, `${whole}.${(fraction + "0000").slice(0, 4)}`);
  }
  for (const [key, value] of vector) {
    shares.set(key, total === "0.0000" ? "0.0000" : div(value, total));
  }
  return shares;
}

function addDecimal(a: string, b: string): string {
  const parse = (s: string) => {
    const [whole = "0", fraction = ""] = s.split(".");
    return BigInt(whole) * 10000n + BigInt((fraction + "0000").slice(0, 4).padEnd(4, "0"));
  };
  const sum = parse(a) + parse(b);
  const negative = sum < 0n;
  const abs = negative ? -sum : sum;
  return `${negative ? "-" : ""}${abs / 10000n}.${String(abs % 10000n).padStart(4, "0")}`;
}
