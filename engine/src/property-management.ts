import { sql } from "drizzle-orm";
import { db, withBypass, withOrg, withOrgTransaction } from "./db.ts";
import { businessToday } from "./business-date.ts";
import { add, cmp, fromUnits, mulPercent, mulRatio, neg, normalizeMoney, sum, toUnits } from "./money.ts";
import { apportion } from "./revenue-recognition.ts";
import { createSubscriptionInvoice } from "./subscription-billing.ts";
import type { AdvancedBillingLine } from "./advanced-subscriptions.ts";

export class PropertyManagementError extends Error {}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value: string | null | undefined, label: string): string | null {
  if (value == null || value === "") return null;
  if (!isoDate.test(value)) throw new PropertyManagementError(`${label} is invalid`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || toIso(parsed) !== value) throw new PropertyManagementError(`${label} is invalid`);
  return value;
}
function utc(iso: string): Date { return new Date(`${iso}T00:00:00Z`); }
function toIso(date: Date): string { return date.toISOString().slice(0, 10); }
function addDays(iso: string, days: number): string { const d = utc(iso); d.setUTCDate(d.getUTCDate() + days); return toIso(d); }
function startOfMonth(iso: string): string { return `${iso.slice(0, 7)}-01`; }
function addMonths(iso: string, months: number): string {
  const d = utc(startOfMonth(iso)); d.setUTCMonth(d.getUTCMonth() + months); return toIso(d);
}
function endOfMonth(iso: string): string { return addDays(addMonths(startOfMonth(iso), 1), -1); }
function dayCount(a: string, b: string): number { return Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000) + 1; }
function clampDue(month: string, billingDay: number): string {
  const last = Number(endOfMonth(month).slice(8, 10));
  return `${month.slice(0, 8)}${String(Math.min(Math.max(1, billingDay), last)).padStart(2, "0")}`;
}
function maxDate(...dates: string[]): string { return dates.reduce((a, b) => a > b ? a : b); }
function minDate(...dates: string[]): string { return dates.reduce((a, b) => a < b ? a : b); }

/** Inclusive overlap used for occupancy-weighted CAM allocations. */
export function overlapDayCount(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const start = maxDate(aStart, bStart);
  const end = minDate(aEnd, bEnd);
  return end < start ? 0 : dayCount(start, end);
}

export interface SchedulePeriod {
  periodStartsOn: string;
  periodEndsOn: string;
  dueOn: string;
  amount: string;
}

/** Exact, inclusive-day proration for partial first/last rental periods. */
export function prorateLeaseCharge(amount: string, nominalStart: string, nominalEnd: string, activeStart: string, activeEnd: string): string {
  const total = dayCount(nominalStart, nominalEnd);
  const active = Math.max(0, dayCount(maxDate(nominalStart, activeStart), minDate(nominalEnd, activeEnd)));
  if (active <= 0 || total <= 0) return "0.0000";
  return mulRatio(normalizeMoney(amount), BigInt(active), BigInt(total));
}

/** Deterministic charge schedule used by activation, amendments, and tests. */
export function leaseChargeSchedule(input: {
  amount: string; frequency: "monthly" | "quarterly" | "annually" | "one_time";
  effectiveFrom: string; effectiveTo?: string | null; leaseStartsOn: string; leaseEndsOn?: string | null;
  throughOn: string; billingDay: number;
}): SchedulePeriod[] {
  const start = maxDate(input.effectiveFrom, input.leaseStartsOn);
  const end = minDate(input.effectiveTo ?? input.throughOn, input.leaseEndsOn ?? input.throughOn, input.throughOn);
  if (end < start) return [];
  if (input.frequency === "one_time") return [{ periodStartsOn: start, periodEndsOn: start, dueOn: start, amount: normalizeMoney(input.amount) }];
  const step = input.frequency === "monthly" ? 1 : input.frequency === "quarterly" ? 3 : 12;
  const rows: SchedulePeriod[] = [];
  for (let nominalStart = startOfMonth(start); nominalStart <= end; nominalStart = addMonths(nominalStart, step)) {
    const nominalEnd = addDays(addMonths(nominalStart, step), -1);
    const activeStart = maxDate(nominalStart, start);
    const activeEnd = minDate(nominalEnd, end);
    if (activeEnd < activeStart) continue;
    const amount = prorateLeaseCharge(input.amount, nominalStart, nominalEnd, activeStart, activeEnd);
    if (cmp(amount, "0") > 0) rows.push({ periodStartsOn: activeStart, periodEndsOn: activeEnd, dueOn: clampDue(nominalStart, input.billingDay), amount });
  }
  return rows;
}

export function escalatedRent(current: string, method: "percent" | "fixed" | "new_amount", value: string): string {
  const base = normalizeMoney(current); const v = normalizeMoney(value);
  const next = method === "percent" ? add(base, mulPercent(base, v)) : method === "fixed" ? add(base, v) : v;
  if (cmp(next, "0") <= 0) throw new PropertyManagementError("Escalated rent must be positive");
  return next;
}

export type DepositKind = "received" | "interest" | "applied" | "refunded" | "adjustment_increase" | "adjustment_decrease";
const DEPOSIT_KINDS = new Set<DepositKind>(["received", "interest", "applied", "refunded", "adjustment_increase", "adjustment_decrease"]);
function asDepositKind(value: string): DepositKind {
  if (!DEPOSIT_KINDS.has(value as DepositKind)) throw new PropertyManagementError("Unsupported deposit transaction type");
  return value as DepositKind;
}

export function depositReversalKind(value: string): DepositKind {
  const reverse: Partial<Record<DepositKind, DepositKind>> = {
    received: "refunded",
    refunded: "received",
    interest: "adjustment_decrease",
    adjustment_increase: "adjustment_decrease",
    adjustment_decrease: "adjustment_increase",
    applied: "adjustment_increase",
  };
  const kind = reverse[asDepositKind(value)];
  if (!kind) throw new PropertyManagementError("Unsupported deposit reversal");
  return kind;
}

/** Accounting-side contract for the security-deposit subledger. */
export function depositPostingShape(kindValue: string): {
  kind: DepositKind;
  liabilitySide: "debit" | "credit";
  offsetSide: "debit" | "credit";
  offsetIsArOpenItem: boolean;
} {
  const kind = asDepositKind(kindValue);
  const increase = kind === "received" || kind === "interest" || kind === "adjustment_increase";
  return {
    kind,
    liabilitySide: increase ? "credit" : "debit",
    offsetSide: increase ? "debit" : "credit",
    offsetIsArOpenItem: kind === "applied",
  };
}

export function depositBalance(transactions: Array<{ kind: string; amount: string }>): string {
  return sum(transactions.map((row) => depositPostingShape(row.kind).liabilitySide === "credit" ? row.amount : neg(row.amount)));
}

async function assertEnabled(runner: Pick<typeof db, "execute">, orgId: string): Promise<void> {
  const result = (await runner.execute<{ enabled: boolean }>(sql`
    select coalesce((settings->'features'->>'propertyManagement')::boolean,false) as enabled from orgs where id=${orgId}
  `));
  if (!result.rows[0]?.enabled) throw new PropertyManagementError("Property management feature is disabled");
}

async function audit(tx: Pick<typeof db, "execute">, orgId: string, table: string, rowId: string, action: string, actorId: string, changes: unknown) {
  await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${orgId},${table},${rowId},${action},${JSON.stringify(changes)}::jsonb,${actorId})`);
}

export async function createManagedProperty(input: {
  orgId: string; actorId: string; subsidiaryId: string; locationId?: string | null; fixedAssetId?: string | null;
  code: string; name: string; propertyType: string; currency?: string | null; address?: Record<string, string>;
  rentIncomeAccountId?: string | null; camIncomeAccountId?: string | null; depositLiabilityAccountId?: string | null; defaultBankAccountId?: string | null;
}): Promise<{ id: string }> {
  const code = input.code.trim(); const name = input.name.trim();
  if (!code || !name) throw new PropertyManagementError("Property code and name are required");
  const requestedCurrency = (input.currency ?? "").trim().toUpperCase();
  if (requestedCurrency && !/^[A-Z]{3}$/.test(requestedCurrency)) throw new PropertyManagementError("Property currency must be a three-letter ISO code");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const scope = (await tx.execute<{ currency: string; location_ok: boolean; asset_ok: boolean; rent_account_ok: boolean; cam_account_ok: boolean; deposit_account_ok: boolean; bank_account_ok: boolean }>(sql`
      select s.base_currency as currency,
        (${input.locationId ?? null}::uuid is null or exists(select 1 from locations where org_id=${input.orgId} and id=${input.locationId ?? null})) as location_ok,
        (${input.fixedAssetId ?? null}::uuid is null or exists(select 1 from fixed_assets where org_id=${input.orgId} and id=${input.fixedAssetId ?? null} and subsidiary_id=s.id)) as asset_ok,
        (${input.rentIncomeAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.rentIncomeAccountId ?? null} and type in ('income','income_other') and is_active and not is_summary)) as rent_account_ok,
        (${input.camIncomeAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.camIncomeAccountId ?? null} and type in ('income','income_other') and is_active and not is_summary)) as cam_account_ok,
        (${input.depositLiabilityAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.depositLiabilityAccountId ?? null} and type in ('liability_current_other','liability_long_term') and is_active and not is_summary)) as deposit_account_ok,
        (${input.defaultBankAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.defaultBankAccountId ?? null} and type='asset_bank' and is_active and not is_summary)) as bank_account_ok
      from subsidiaries s where s.org_id=${input.orgId} and s.id=${input.subsidiaryId}
    `));
    const row = scope.rows[0];
    if (!row) throw new PropertyManagementError("Subsidiary not found");
    if (!row.location_ok || !row.asset_ok) throw new PropertyManagementError("Property dimensions do not belong to this organization");
    if (!row.rent_account_ok || !row.cam_account_ok || !row.deposit_account_ok || !row.bank_account_ok) throw new PropertyManagementError("Property control accounts have incompatible account types");
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into managed_properties(org_id,subsidiary_id,location_id,fixed_asset_id,code,name,property_type,currency,address,
        rent_income_account_id,cam_income_account_id,deposit_liability_account_id,default_bank_account_id,created_by,updated_by)
      values(${input.orgId},${input.subsidiaryId},${input.locationId ?? null},${input.fixedAssetId ?? null},${code},${name},${input.propertyType},
        ${requestedCurrency || row.currency},${JSON.stringify(input.address ?? {})}::jsonb,${input.rentIncomeAccountId ?? null},${input.camIncomeAccountId ?? null},
        ${input.depositLiabilityAccountId ?? null},${input.defaultBankAccountId ?? null},${input.actorId},${input.actorId}) returning id
    `));
    const id = inserted.rows[0]!.id;
    await audit(tx, input.orgId, "managed_properties", id, "insert", input.actorId, { code, name });
    return { id };
  });
}

export async function updateManagedProperty(input: {
  orgId: string;
  actorId: string;
  propertyId: string;
  subsidiaryId: string;
  locationId?: string | null;
  fixedAssetId?: string | null;
  code: string;
  name: string;
  propertyType: string;
  status: string;
  currency: string;
  address?: Record<string, string>;
  rentIncomeAccountId?: string | null;
  camIncomeAccountId?: string | null;
  depositLiabilityAccountId?: string | null;
  defaultBankAccountId?: string | null;
  custom?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const code = input.code.trim();
  const name = input.name.trim();
  const currency = input.currency.trim().toUpperCase();
  if (!code || !name)
    throw new PropertyManagementError("Property code and name are required");
  if (!/^[A-Z]{3}$/.test(currency))
    throw new PropertyManagementError(
      "Property currency must be a three-letter ISO code",
    );
  if (
    !["residential", "commercial", "mixed_use", "industrial", "other"].includes(
      input.propertyType,
    )
  ) {
    throw new PropertyManagementError("Invalid property type");
  }
  if (!["active", "inactive", "sold"].includes(input.status))
    throw new PropertyManagementError("Invalid property status");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const scope = (await tx.execute<{
        currentSubsidiaryId: string;
        currentCurrency: string;
        has_leases: boolean;
        has_active_leases: boolean;
        subsidiary_ok: boolean;
        location_ok: boolean;
        asset_ok: boolean;
        rent_account_ok: boolean;
        cam_account_ok: boolean;
        deposit_account_ok: boolean;
        bank_account_ok: boolean;
      }>(sql`
      select p.subsidiary_id as "currentSubsidiaryId",p.currency as "currentCurrency",
        exists(select 1 from property_leases where org_id=p.org_id and property_id=p.id) as has_leases,
        exists(select 1 from property_leases where org_id=p.org_id and property_id=p.id and status in ('active','notice')) as has_active_leases,
        exists(select 1 from subsidiaries where org_id=${input.orgId} and id=${input.subsidiaryId}) as subsidiary_ok,
        (${input.locationId ?? null}::uuid is null or exists(select 1 from locations where org_id=${input.orgId} and id=${input.locationId ?? null})) as location_ok,
        (${input.fixedAssetId ?? null}::uuid is null or exists(select 1 from fixed_assets where org_id=${input.orgId} and id=${input.fixedAssetId ?? null} and subsidiary_id=${input.subsidiaryId})) as asset_ok,
        (${input.rentIncomeAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.rentIncomeAccountId ?? null} and type in ('income','income_other') and is_active and not is_summary)) as rent_account_ok,
        (${input.camIncomeAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.camIncomeAccountId ?? null} and type in ('income','income_other') and is_active and not is_summary)) as cam_account_ok,
        (${input.depositLiabilityAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.depositLiabilityAccountId ?? null} and type in ('liability_current_other','liability_long_term') and is_active and not is_summary)) as deposit_account_ok,
        (${input.defaultBankAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.defaultBankAccountId ?? null} and type='asset_bank' and is_active and not is_summary)) as bank_account_ok
      from managed_properties p where p.org_id=${input.orgId} and p.id=${input.propertyId} for update
    `));
    const row = scope.rows[0];
    if (!row) throw new PropertyManagementError("Property not found");
    if (!row.subsidiary_ok || !row.location_ok || !row.asset_ok)
      throw new PropertyManagementError(
        "Property dimensions do not belong to this organization",
      );
    if (
      !row.rent_account_ok ||
      !row.cam_account_ok ||
      !row.deposit_account_ok ||
      !row.bank_account_ok
    ) {
      throw new PropertyManagementError(
        "Property control accounts have incompatible account types",
      );
    }
    if (
      row.has_leases &&
      (row.currentSubsidiaryId !== input.subsidiaryId ||
        row.currentCurrency !== currency)
    ) {
      throw new PropertyManagementError(
        "Subsidiary and currency cannot change after a lease exists",
      );
    }
    if (row.has_active_leases && input.status !== "active") {
      throw new PropertyManagementError(
        "End active or notice leases before deactivating this property",
      );
    }
    await tx.execute(sql`
      update managed_properties set subsidiary_id=${input.subsidiaryId},location_id=${input.locationId ?? null},
        fixed_asset_id=${input.fixedAssetId ?? null},code=${code},name=${name},property_type=${input.propertyType},
        status=${input.status},currency=${currency},address=${JSON.stringify(input.address ?? {})}::jsonb,
        rent_income_account_id=${input.rentIncomeAccountId ?? null},cam_income_account_id=${input.camIncomeAccountId ?? null},
        deposit_liability_account_id=${input.depositLiabilityAccountId ?? null},default_bank_account_id=${input.defaultBankAccountId ?? null},
        custom=${JSON.stringify(input.custom ?? {})}::jsonb,updated_at=now(),updated_by=${input.actorId}
      where org_id=${input.orgId} and id=${input.propertyId}
    `);
    await audit(
      tx,
      input.orgId,
      "managed_properties",
      input.propertyId,
      "update",
      input.actorId,
      {
        code,
        name,
        propertyType: input.propertyType,
        status: input.status,
      },
    );
    return { id: input.propertyId };
  });
}

export async function deleteManagedProperty(orgId: string, actorId: string, propertyId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const record = (await tx.execute<{ code: string; name: string; has_units: boolean; has_leases: boolean; has_cam: boolean }>(sql`
      select p.code,p.name,
        exists(select 1 from property_units where org_id=p.org_id and property_id=p.id) as has_units,
        exists(select 1 from property_leases where org_id=p.org_id and property_id=p.id) as has_leases,
        exists(select 1 from cam_pools where org_id=p.org_id and property_id=p.id) as has_cam
      from managed_properties p where p.org_id=${orgId} and p.id=${propertyId} for update
    `));
    const row = record.rows[0];
    if (!row) throw new PropertyManagementError("Property not found");
    if (row.has_units || row.has_leases || row.has_cam) {
      throw new PropertyManagementError("A property with units, leases, or CAM history cannot be deleted; deactivate it instead");
    }
    await tx.execute(sql`delete from managed_properties where org_id=${orgId} and id=${propertyId}`);
    await audit(tx, orgId, "managed_properties", propertyId, "delete", actorId, { before: { code: row.code, name: row.name } });
  });
}

export async function createPropertyUnit(input: { orgId: string; actorId: string; propertyId: string; code: string; name?: string | null; unitType?: string | null; rentableArea?: string | null; bedrooms?: number | null }): Promise<{ id: string }> {
  if (!input.code.trim()) throw new PropertyManagementError("Unit code is required");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const result = (await tx.execute<{ id: string }>(sql`
      insert into property_units(org_id,property_id,code,name,unit_type,rentable_area,bedrooms,created_by,updated_by)
      select ${input.orgId},id,${input.code.trim()},${input.name ?? null},${input.unitType ?? null},${input.rentableArea ?? null},${input.bedrooms ?? null},${input.actorId},${input.actorId}
        from managed_properties where org_id=${input.orgId} and id=${input.propertyId} and status='active' returning id
    `));
    if (!result.rows[0]) throw new PropertyManagementError("Active property not found");
    await audit(tx, input.orgId, "property_units", result.rows[0].id, "insert", input.actorId, { propertyId: input.propertyId, code: input.code.trim() });
    return { id: result.rows[0].id };
  });
}

export async function updatePropertyUnit(input: {
  orgId: string; actorId: string; unitId: string; code: string; name?: string | null;
  unitType?: string | null; rentableArea?: string | null; bedrooms?: number | null; status?: string;
}): Promise<{ id: string }> {
  const code = input.code.trim();
  const rentableArea = input.rentableArea == null || input.rentableArea === "" ? null : normalizeMoney(input.rentableArea);
  if (!code) throw new PropertyManagementError("Unit code is required");
  if (rentableArea != null && cmp(rentableArea, "0") <= 0) throw new PropertyManagementError("Rentable area must be positive");
  if (input.bedrooms != null && (!Number.isInteger(input.bedrooms) || input.bedrooms < 0)) {
    throw new PropertyManagementError("Bedrooms must be a non-negative whole number");
  }
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const currentResult = (await tx.execute<{ status: string; has_active_lease: boolean }>(sql`
      select u.status,
        exists(select 1 from property_leases l where l.org_id=u.org_id and l.unit_id=u.id and l.status in ('active','notice')) as has_active_lease
      from property_units u where u.org_id=${input.orgId} and u.id=${input.unitId} for update
    `));
    const current = currentResult.rows[0];
    if (!current) throw new PropertyManagementError("Unit not found");
    const status = input.status ?? current.status;
    if (!["vacant", "occupied", "notice", "offline"].includes(status)) throw new PropertyManagementError("Invalid unit status");
    if (current.has_active_lease && status !== current.status) throw new PropertyManagementError("End the active lease before changing unit availability");
    if (!current.has_active_lease && ["occupied", "notice"].includes(status)) throw new PropertyManagementError("Unit occupancy is controlled by lease activation");
    const result = (await tx.execute<{ id: string; propertyId: string }>(sql`
      update property_units set code=${code},name=${input.name?.trim() || null},unit_type=${input.unitType?.trim() || null},
        rentable_area=${rentableArea},bedrooms=${input.bedrooms ?? null},status=${status},updated_at=now(),updated_by=${input.actorId}
      where org_id=${input.orgId} and id=${input.unitId} returning id,property_id as "propertyId"
    `));
    const unit = result.rows[0];
    if (!unit) throw new PropertyManagementError("Unit not found");
    await audit(tx, input.orgId, "property_units", unit.id, "update", input.actorId, { propertyId: unit.propertyId, code });
    return { id: unit.id };
  });
}

export async function deletePropertyUnit(orgId: string, actorId: string, unitId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const record = (await tx.execute<{ code: string; propertyId: string; has_leases: boolean }>(sql`
      select u.code,u.property_id as "propertyId",
        exists(select 1 from property_leases where org_id=u.org_id and unit_id=u.id) as has_leases
      from property_units u where u.org_id=${orgId} and u.id=${unitId} for update
    `));
    const row = record.rows[0];
    if (!row) throw new PropertyManagementError("Unit not found");
    if (row.has_leases) throw new PropertyManagementError("A unit with lease history cannot be deleted; take it offline instead");
    await tx.execute(sql`delete from property_units where org_id=${orgId} and id=${unitId}`);
    await audit(tx, orgId, "property_units", unitId, "delete", actorId, { before: { code: row.code, propertyId: row.propertyId } });
  });
}

export async function createPropertyLease(input: {
  orgId: string; actorId: string; propertyId: string; unitId?: string | null; tenantId: string; leaseNumber: string;
  startsOn: string; endsOn?: string | null; baseRent: string; billingDay?: number; paymentTermsDays?: number;
  securityDepositRequired?: string; camMethod?: "none" | "fixed" | "pro_rata"; camSharePercent?: string | null;
  lateFeeType?: "none" | "fixed" | "percent"; lateFeeValue?: string; graceDays?: number; autoInvoice?: boolean; autoPost?: boolean;
}): Promise<{ id: string }> {
  const leaseNumber = input.leaseNumber.trim(); const startsOn = validDate(input.startsOn, "Lease start")!;
  const endsOn = validDate(input.endsOn, "Lease end"); const baseRent = normalizeMoney(input.baseRent);
  if (!leaseNumber || !startsOn || cmp(baseRent, "0") <= 0) throw new PropertyManagementError("Lease number, start date, and positive base rent are required");
  if (endsOn && endsOn < startsOn) throw new PropertyManagementError("Lease end cannot precede start");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const scope = (await tx.execute<{ id: string; rent_income_account_id: string | null; tenant_ok: boolean; unit_ok: boolean }>(sql`
      select p.id,p.rent_income_account_id,
        exists(select 1 from customer_roles cr where cr.org_id=p.org_id and cr.party_id=${input.tenantId} and cr.is_active) as tenant_ok,
        (${input.unitId ?? null}::uuid is null or exists(select 1 from property_units u where u.org_id=p.org_id and u.id=${input.unitId ?? null} and u.property_id=p.id and u.status<>'offline')) as unit_ok
      from managed_properties p where p.org_id=${input.orgId} and p.id=${input.propertyId} and p.status='active'
    `));
    const property = scope.rows[0];
    if (!property) throw new PropertyManagementError("Active property not found");
    if (!property.tenant_ok) throw new PropertyManagementError("Tenant must be an active customer");
    if (!property.unit_ok) throw new PropertyManagementError("Unit does not belong to this property");
    if (!property.rent_income_account_id) throw new PropertyManagementError("Configure the property rent income account first");
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into property_leases(org_id,property_id,unit_id,tenant_id,lease_number,starts_on,ends_on,billing_day,payment_terms_days,
        security_deposit_required,cam_method,cam_share_percent,late_fee_type,late_fee_value,grace_days,auto_invoice,auto_post,created_by,updated_by)
      values(${input.orgId},${input.propertyId},${input.unitId ?? null},${input.tenantId},${leaseNumber},${startsOn},${endsOn},${input.billingDay ?? 1},
        ${input.paymentTermsDays ?? 0},${normalizeMoney(input.securityDepositRequired ?? "0")},${input.camMethod ?? "none"},${input.camSharePercent ?? null},
        ${input.lateFeeType ?? "none"},${normalizeMoney(input.lateFeeValue ?? "0")},${input.graceDays ?? 0},${input.autoInvoice ?? true},${input.autoPost ?? false},${input.actorId},${input.actorId}) returning id
    `));
    const id = inserted.rows[0]!.id;
    await tx.execute(sql`insert into lease_charges(org_id,lease_id,charge_type,description,amount,frequency,effective_from,effective_to,income_account_id,created_by,updated_by)
      values(${input.orgId},${id},'base_rent','Base rent',${baseRent},'monthly',${startsOn},${endsOn},${property.rent_income_account_id},${input.actorId},${input.actorId})`);
    await audit(tx, input.orgId, "property_leases", id, "insert", input.actorId, { leaseNumber, propertyId: input.propertyId, tenantId: input.tenantId, baseRent });
    return { id };
  });
}

export async function updatePropertyLease(input: {
  orgId: string; actorId: string; leaseId: string; propertyId: string; unitId?: string | null; tenantId: string; leaseNumber: string;
  startsOn: string; endsOn?: string | null; baseRent: string; billingDay: number; paymentTermsDays: number;
  securityDepositRequired: string; camMethod: "none" | "fixed" | "pro_rata"; camSharePercent?: string | null;
  lateFeeType: "none" | "fixed" | "percent"; lateFeeValue: string; graceDays: number; autoInvoice: boolean; autoPost: boolean;
}): Promise<{ id: string }> {
  const leaseNumber = input.leaseNumber.trim();
  const startsOn = validDate(input.startsOn, "Lease start")!;
  const endsOn = validDate(input.endsOn, "Lease end");
  const baseRent = normalizeMoney(input.baseRent);
  const deposit = normalizeMoney(input.securityDepositRequired);
  const camShare = input.camSharePercent == null || input.camSharePercent === "" ? null : normalizeMoney(input.camSharePercent);
  const lateFeeValue = input.lateFeeType === "none" ? "0.0000" : normalizeMoney(input.lateFeeValue);
  if (!leaseNumber || cmp(baseRent, "0") <= 0) throw new PropertyManagementError("Lease number and positive base rent are required");
  if (endsOn && endsOn < startsOn) throw new PropertyManagementError("Lease end cannot precede start");
  if (!Number.isInteger(input.billingDay) || input.billingDay < 1 || input.billingDay > 31) throw new PropertyManagementError("Billing day must be between 1 and 31");
  if (!Number.isInteger(input.paymentTermsDays) || input.paymentTermsDays < 0 || !Number.isInteger(input.graceDays) || input.graceDays < 0) {
    throw new PropertyManagementError("Payment terms and grace days must be non-negative whole numbers");
  }
  if (cmp(deposit, "0") < 0) throw new PropertyManagementError("Security deposit cannot be negative");
  if (!(["none", "fixed", "pro_rata"] as string[]).includes(input.camMethod)) throw new PropertyManagementError("Invalid CAM method");
  if (camShare != null && (cmp(camShare, "0") < 0 || cmp(camShare, "100") > 0)) throw new PropertyManagementError("CAM share must be between 0 and 100");
  if (!(["none", "fixed", "percent"] as string[]).includes(input.lateFeeType)) throw new PropertyManagementError("Invalid late-fee type");
  if (input.lateFeeType !== "none" && cmp(lateFeeValue, "0") <= 0) throw new PropertyManagementError("Late-fee value must be positive");
  if (input.lateFeeType === "percent" && cmp(lateFeeValue, "100") > 0) throw new PropertyManagementError("Late-fee percent cannot exceed 100");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const currentResult = (await tx.execute<{ id: string; status: string; propertyId: string; unitId: string | null; tenantId: string; startsOn: string; endsOn: string | null; billingDay: number; baseRent: string }>(sql`
      select l.id,l.status,l.property_id as "propertyId",l.unit_id as "unitId",l.tenant_id as "tenantId",l.starts_on as "startsOn",
        l.ends_on as "endsOn",l.billing_day as "billingDay",
        (select amount from lease_charges where org_id=l.org_id and lease_id=l.id and charge_type='base_rent' order by effective_from desc limit 1) as "baseRent"
      from property_leases l where l.org_id=${input.orgId} and l.id=${input.leaseId} for update
    `));
    const current = currentResult.rows[0];
    if (!current || !["draft", "active", "notice"].includes(current.status)) throw new PropertyManagementError("Editable lease not found");
    const draft = current.status === "draft";
    if (!draft && (current.propertyId !== input.propertyId || current.unitId !== (input.unitId ?? null) || current.tenantId !== input.tenantId || current.startsOn !== startsOn)) {
      throw new PropertyManagementError("Property, unit, tenant, and start date cannot change after activation");
    }
    if (!draft && (current.billingDay !== input.billingDay || cmp(current.baseRent, baseRent) !== 0)) {
      throw new PropertyManagementError("Use rent escalation to change active rent; billing day is fixed after activation");
    }
    if (!draft && ((current.endsOn == null && endsOn != null) || (current.endsOn != null && endsOn != null && endsOn < current.endsOn))) {
      throw new PropertyManagementError("An active lease term may only be extended");
    }
    const scope = (await tx.execute<{ id: string; rent_income_account_id: string | null; tenant_ok: boolean; unit_ok: boolean; unit_available: boolean }>(sql`
      select p.id,p.rent_income_account_id,
        exists(select 1 from customer_roles cr where cr.org_id=p.org_id and cr.party_id=${input.tenantId} and cr.is_active) as tenant_ok,
        (${input.unitId ?? null}::uuid is null or exists(select 1 from property_units u where u.org_id=p.org_id and u.id=${input.unitId ?? null} and u.property_id=p.id and u.status<>'offline')) as unit_ok,
        (${input.unitId ?? null}::uuid is null or not exists(select 1 from property_leases x where x.org_id=p.org_id and x.unit_id=${input.unitId ?? null} and x.id<>${input.leaseId} and x.status in ('active','notice'))) as unit_available
      from managed_properties p where p.org_id=${input.orgId} and p.id=${input.propertyId} and p.status='active'
    `));
    const property = scope.rows[0];
    if (!property) throw new PropertyManagementError("Active property not found");
    if (!property.tenant_ok) throw new PropertyManagementError("Tenant must be an active customer");
    if (!property.unit_ok || !property.unit_available) throw new PropertyManagementError("Unit is unavailable for this lease");
    if (!property.rent_income_account_id) throw new PropertyManagementError("Configure the property rent income account first");
    await tx.execute(sql`
      update property_leases set property_id=${input.propertyId},unit_id=${input.unitId ?? null},tenant_id=${input.tenantId},lease_number=${leaseNumber},
        starts_on=${startsOn},ends_on=${endsOn},billing_day=${input.billingDay},payment_terms_days=${input.paymentTermsDays},
        security_deposit_required=${deposit},cam_method=${input.camMethod},cam_share_percent=${input.camMethod === "none" ? null : camShare},
        late_fee_type=${input.lateFeeType},late_fee_value=${lateFeeValue},grace_days=${input.graceDays},auto_invoice=${input.autoInvoice},auto_post=${input.autoPost},
        updated_at=now(),updated_by=${input.actorId} where org_id=${input.orgId} and id=${input.leaseId}
    `);
    if (draft) {
      await tx.execute(sql`
        update lease_charges set amount=${baseRent},effective_from=${startsOn},effective_to=${endsOn},income_account_id=${property.rent_income_account_id},
          updated_at=now(),updated_by=${input.actorId} where org_id=${input.orgId} and lease_id=${input.leaseId} and charge_type='base_rent'
      `);
    }
    await audit(tx, input.orgId, "property_leases", input.leaseId, "update", input.actorId, { leaseNumber, propertyId: input.propertyId, unitId: input.unitId ?? null, status: current.status });
    return { id: input.leaseId };
  });
}

export async function cancelPropertyLease(orgId: string, actorId: string, leaseId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const result = (await tx.execute<{ leaseNumber: string }>(sql`
      update property_leases set status='cancelled',updated_at=now(),updated_by=${actorId}
      where org_id=${orgId} and id=${leaseId} and status='draft' returning lease_number as "leaseNumber"
    `));
    if (!result.rows[0]) throw new PropertyManagementError("Draft lease not found");
    await audit(tx, orgId, "property_leases", leaseId, "cancel", actorId, { after: { status: "cancelled" }, leaseNumber: result.rows[0].leaseNumber });
  });
}

export async function addLeaseCharge(input: { orgId: string; actorId: string; leaseId: string; chargeType: string; description: string; amount: string; frequency: string; effectiveFrom: string; effectiveTo?: string | null; incomeAccountId?: string | null; itemId?: string | null; taxCodeId?: string | null }): Promise<{ id: string }> {
  const amount = normalizeMoney(input.amount); if (!input.description.trim() || cmp(amount, "0") <= 0) throw new PropertyManagementError("Charge description and positive amount are required");
  const result = (await db.execute<{ id: string }>(sql`
    insert into lease_charges(org_id,lease_id,charge_type,description,amount,frequency,effective_from,effective_to,income_account_id,item_id,tax_code_id,created_by,updated_by)
    select ${input.orgId},l.id,${input.chargeType},${input.description.trim()},${amount},${input.frequency},${input.effectiveFrom},${input.effectiveTo ?? null},
      coalesce(${input.incomeAccountId ?? null},case when ${input.chargeType}='cam' then p.cam_income_account_id else p.rent_income_account_id end),
      ${input.itemId ?? null},${input.taxCodeId ?? null},${input.actorId},${input.actorId}
      from property_leases l join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
     where l.org_id=${input.orgId} and l.id=${input.leaseId} and l.status in ('draft','active') returning id
  `));
  if (!result.rows[0]) throw new PropertyManagementError("Editable lease not found");
  return { id: result.rows[0].id };
}

export async function scheduleLeaseCharges(orgId: string, actorId: string, leaseId: string, throughOn?: string): Promise<{ created: number }> {
  const leaseResult = (await db.execute<any>(sql`select starts_on as "startsOn",ends_on as "endsOn",billing_day as "billingDay",status from property_leases where org_id=${orgId} and id=${leaseId}`));
  const lease = leaseResult.rows[0]; if (!lease || !["active", "notice"].includes(lease.status)) throw new PropertyManagementError("Active lease not found");
  const horizon = throughOn ?? addDays(addMonths(startOfMonth(await businessToday(orgId)), 13), -1);
  const charges = (await db.execute<any>(sql`select id,amount,frequency,effective_from as "effectiveFrom",effective_to as "effectiveTo" from lease_charges where org_id=${orgId} and lease_id=${leaseId} order by effective_from`));
  let created = 0;
  for (const charge of charges.rows) {
    for (const period of leaseChargeSchedule({ ...charge, leaseStartsOn: lease.startsOn, leaseEndsOn: lease.endsOn, throughOn: horizon, billingDay: lease.billingDay })) {
      const result = (await db.execute(sql`
        insert into lease_schedule_lines(org_id,lease_id,charge_id,period_starts_on,period_ends_on,due_on,amount,created_by,updated_by)
        values(${orgId},${leaseId},${charge.id},${period.periodStartsOn},${period.periodEndsOn},${period.dueOn},${period.amount},${actorId},${actorId})
        on conflict(org_id,charge_id,period_starts_on) do nothing returning id
      `));
      created += result.rows.length;
    }
  }
  return { created };
}

export async function activatePropertyLease(orgId: string, actorId: string, leaseId: string): Promise<{ scheduled: number }> {
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const lease = (await tx.execute<any>(sql`select * from property_leases where org_id=${orgId} and id=${leaseId} for update`));
    const row = lease.rows[0]; if (!row || row.status !== "draft") throw new PropertyManagementError("Draft lease not found");
    if (row.unit_id) {
      const conflict = (await tx.execute(sql`select 1 from property_leases where org_id=${orgId} and unit_id=${row.unit_id} and id<>${leaseId} and status in ('active','notice')`));
      if (conflict.rows.length) throw new PropertyManagementError("Unit already has an active lease");
      await tx.execute(sql`update property_units set status='occupied',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${row.unit_id}`);
    }
    await tx.execute(sql`update property_leases set status='active',activated_at=now(),activated_by=${actorId},updated_at=now(),updated_by=${actorId} where id=${leaseId} and org_id=${orgId}`);
    await audit(tx, orgId, "property_leases", leaseId, "activate", actorId, { after: { status: "active" } });
  });
  return { scheduled: (await scheduleLeaseCharges(orgId, actorId, leaseId)).created };
}

export async function terminatePropertyLease(orgId: string, actorId: string, leaseId: string, terminatedOn: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new PropertyManagementError("Termination reason is required");
  const effectiveOn = validDate(terminatedOn, "Termination date")!;
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const lease = (await tx.execute<{ starts_on: string; unit_id: string | null }>(sql`select starts_on,unit_id from property_leases where org_id=${orgId} and id=${leaseId} and status in ('active','notice') for update`));
    const row = lease.rows[0];
    if (!row) throw new PropertyManagementError("Active lease not found");
    if (effectiveOn < row.starts_on) throw new PropertyManagementError("Termination date cannot precede the lease start");
    const partials = (await tx.execute<{ id: string; period_starts_on: string; period_ends_on: string; amount: string }>(sql`select id,period_starts_on,period_ends_on,amount from lease_schedule_lines
      where org_id=${orgId} and lease_id=${leaseId} and status='scheduled' and period_starts_on<=${effectiveOn} and period_ends_on>${effectiveOn} for update`));
    for (const period of partials.rows) {
      const prorated = mulRatio(period.amount, BigInt(dayCount(period.period_starts_on, effectiveOn)), BigInt(dayCount(period.period_starts_on, period.period_ends_on)));
      await tx.execute(sql`update lease_schedule_lines set period_ends_on=${effectiveOn},amount=${prorated},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${period.id} and status='scheduled'`);
    }
    await tx.execute(sql`update lease_schedule_lines set status='cancelled',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and lease_id=${leaseId} and status='scheduled' and period_starts_on>${effectiveOn}`);
    await tx.execute(sql`update property_leases set status='terminated',ends_on=least(coalesce(ends_on,${effectiveOn}),${effectiveOn}),move_out_on=${effectiveOn},terminated_at=now(),terminated_by=${actorId},termination_reason=${reason.trim()},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${leaseId}`);
    if (row.unit_id) await tx.execute(sql`update property_units set status='vacant',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${row.unit_id}`);
    await audit(tx, orgId, "property_leases", leaseId, "terminate", actorId, { terminatedOn: effectiveOn, reason: reason.trim() });
  });
}

export async function addLeaseEscalation(input: { orgId: string; actorId: string; leaseId: string; effectiveOn: string; method: "percent" | "fixed" | "new_amount"; value: string }): Promise<{ id: string }> {
  const effectiveOn = validDate(input.effectiveOn, "Escalation date")!;
  const value = normalizeMoney(input.value);
  if (cmp(value, "0") <= 0) throw new PropertyManagementError("Escalation value must be positive");
  await assertEnabled(db, input.orgId);
  const result = (await db.execute<{ id: string }>(sql`insert into lease_escalations(org_id,lease_id,effective_on,method,value,created_by,updated_by)
    select ${input.orgId},id,${effectiveOn},${input.method},${value},${input.actorId},${input.actorId}
      from property_leases where org_id=${input.orgId} and id=${input.leaseId} and status in ('draft','active','notice') returning id`));
  if (!result.rows[0]) throw new PropertyManagementError("Lease not found"); return { id: result.rows[0].id };
}

export async function applyLeaseEscalation(orgId: string, actorId: string, escalationId: string): Promise<{ chargeId: string; newAmount: string }> {
  const applied = await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const escalation = (await tx.execute<any>(sql`select * from lease_escalations where org_id=${orgId} and id=${escalationId} for update`));
    const e = escalation.rows[0]; if (!e || e.status !== "scheduled") throw new PropertyManagementError("Scheduled escalation not found");
    const chargeResult = (await tx.execute<any>(sql`select * from lease_charges where org_id=${orgId} and lease_id=${e.lease_id} and charge_type='base_rent' and effective_from<=${e.effective_on} and (effective_to is null or effective_to>=${e.effective_on}) order by effective_from desc, id desc limit 1 for update`));
    const charge = chargeResult.rows[0]; if (!charge) throw new PropertyManagementError("Effective base-rent charge not found");
    if (e.effective_on <= charge.effective_from) throw new PropertyManagementError("Escalation must begin after the current rent charge starts");
    const alreadyBilled = (await tx.execute(sql`select 1 from lease_schedule_lines where org_id=${orgId} and charge_id=${charge.id}
      and status in ('invoiced','credited') and period_ends_on>=${e.effective_on} limit 1`));
    if (alreadyBilled.rows.length) throw new PropertyManagementError("Affected rent is already billed; credit or void it before applying this escalation");
    const next = escalatedRent(charge.amount, e.method, e.value);
    const scheduled = (await tx.execute<{ id: string; period_starts_on: string; period_ends_on: string; amount: string }>(sql`select id,period_starts_on,period_ends_on,amount from lease_schedule_lines
      where org_id=${orgId} and charge_id=${charge.id} and status='scheduled' and period_ends_on>=${e.effective_on} for update`));
    for (const period of scheduled.rows) {
      if (period.period_starts_on >= e.effective_on) {
        await tx.execute(sql`update lease_schedule_lines set status='cancelled',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${period.id}`);
      } else {
        const oldEnd = addDays(e.effective_on, -1);
        const amount = mulRatio(period.amount, BigInt(dayCount(period.period_starts_on, oldEnd)), BigInt(dayCount(period.period_starts_on, period.period_ends_on)));
        await tx.execute(sql`update lease_schedule_lines set period_ends_on=${oldEnd},amount=${amount},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${period.id}`);
      }
    }
    await tx.execute(sql`update lease_charges set effective_to=(${e.effective_on}::date-interval '1 day')::date,updated_at=now(),updated_by=${actorId} where id=${charge.id} and org_id=${orgId}`);
    const inserted = (await tx.execute<{ id: string }>(sql`insert into lease_charges(org_id,lease_id,charge_type,description,amount,frequency,effective_from,effective_to,income_account_id,item_id,tax_code_id,created_by,updated_by)
      values(${orgId},${e.lease_id},'base_rent',${charge.description},${next},${charge.frequency},${e.effective_on},${charge.effective_to},${charge.income_account_id},${charge.item_id},${charge.tax_code_id},${actorId},${actorId}) returning id`));
    await tx.execute(sql`update lease_escalations set status='applied',previous_amount=${charge.amount},new_amount=${next},applied_at=now(),applied_by=${actorId},updated_at=now(),updated_by=${actorId} where id=${escalationId} and org_id=${orgId}`);
    await audit(tx, orgId, "lease_escalations", escalationId, "apply", actorId, { previousAmount: charge.amount, newAmount: next, effectiveOn: e.effective_on });
    return { chargeId: inserted.rows[0]!.id, newAmount: next, leaseId: e.lease_id };
  });
  await scheduleLeaseCharges(orgId, actorId, applied.leaseId);
  return { chargeId: applied.chargeId, newAmount: applied.newAmount };
}

function billingKey(leaseId: string, scheduleIds: string[]): string { return `rent:${leaseId}:${[...scheduleIds].sort().join(",")}`; }
export interface LeaseLevellingResult {
  leaseId: string;
  leaseNumber: string;
  /** Straight-line income attributable to completed billing periods. */
  straightLineToDate: string;
  /** Contractual rent billed for those same periods. */
  billedToDate: string;
  /** SL − billed: the rent receivable (positive) or deferred rent (negative). */
  targetAccrual: string;
  postedAccrual: string;
  delta: string;
  entryId: string | null;
}

/**
 * Straight-line an operating lease's escalating rent (IFRS 16.81 /
 * ASC 842-30-25-11): income is level over the term regardless of the billing
 * pattern, so a lease billed 10k→14k over five years recognises 12k a year,
 * accruing a rent receivable while billing lags and releasing it as billing
 * catches up — returning to exactly zero at the end of the term.
 *
 * The mechanism: rebuild the FULL contractual base-rent stream (all charge
 * rows including applied escalations, over the whole lease term), apportion
 * the total across the billing periods (day-weighted for partial first/last
 * periods, equal otherwise), and true the cumulative accrual up for every
 * COMPLETED period as of `asOf`. Idempotent: the posted accrual is measured
 * from the ledger, so a rerun with no change posts nothing.
 *
 * Requires a determinable term (`ends_on`) — an open-ended lease has no total
 * to level. Accounts: income from the property's rent income account; the
 * accrual sits on `orgs.settings.controlAccounts.straightLineRent`.
 */
export async function levelLeaseRentStraightLine(
  orgId: string,
  actorId: string | null,
  opts: { asOf: string; onlyLeaseId?: string },
): Promise<LeaseLevellingResult[]> {
  await assertEnabled(db, orgId);
  const asOf = validDate(opts.asOf, "Levelling date")!;

  const slAccount = (await db.execute<{ acct: string | null }>(sql`
    select settings->'controlAccounts'->>'straightLineRent' as acct from orgs where id = ${orgId}
  `));
  const straightLineRentAccountId = slAccount.rows[0]?.acct ?? null;

  const leases = (await db.execute<{
      id: string; leaseNumber: string; startsOn: string; endsOn: string; billingDay: number;
      tenantId: string; subsidiaryId: string; locationId: string | null; currency: string;
      rentIncomeAccountId: string | null;
    }>(sql`
    select l.id, l.lease_number as "leaseNumber", l.starts_on as "startsOn", l.ends_on as "endsOn",
           l.billing_day as "billingDay", l.tenant_id as "tenantId",
           p.subsidiary_id as "subsidiaryId", p.location_id as "locationId", p.currency,
           p.rent_income_account_id as "rentIncomeAccountId"
      from property_leases l
      join managed_properties p on p.id = l.property_id and p.org_id = l.org_id
     where l.org_id = ${orgId} and l.status in ('active','notice') and l.ends_on is not null
       and (${opts.onlyLeaseId ?? null}::uuid is null or l.id = ${opts.onlyLeaseId ?? null})
     order by l.lease_number`));

  const results: LeaseLevellingResult[] = [];
  for (const lease of leases.rows) {
    const charges = (await db.execute<{ amount: string; frequency: "monthly" | "quarterly" | "annually" | "one_time"; effectiveFrom: string; effectiveTo: string | null }>(sql`
      select amount, frequency, effective_from as "effectiveFrom", effective_to as "effectiveTo"
        from lease_charges
       where org_id = ${orgId} and lease_id = ${lease.id} and charge_type = 'base_rent'
       order by effective_from`));
    if (charges.rows.length === 0) continue;

    // The full contractual stream over the term, with a day-count weight per
    // billing period (1 for full periods, the active/nominal ratio otherwise).
    const rows: { periodEndsOn: string; amount: string; weight: string }[] = [];
    for (const charge of charges.rows) {
      if (charge.frequency === "one_time") continue; // not periodic rent
      const step = charge.frequency === "monthly" ? 1 : charge.frequency === "quarterly" ? 3 : 12;
      for (const period of leaseChargeSchedule({
        amount: charge.amount, frequency: charge.frequency,
        effectiveFrom: charge.effectiveFrom, effectiveTo: charge.effectiveTo,
        leaseStartsOn: lease.startsOn, leaseEndsOn: lease.endsOn,
        throughOn: lease.endsOn, billingDay: lease.billingDay,
      })) {
        const nominalStart = startOfMonth(period.periodStartsOn);
        const nominalEnd = addDays(addMonths(nominalStart, step), -1);
        const active = dayCount(period.periodStartsOn, period.periodEndsOn);
        const nominal = dayCount(nominalStart, nominalEnd);
        rows.push({
          periodEndsOn: period.periodEndsOn,
          amount: period.amount,
          weight: active >= nominal ? "1" : mulRatio("1", BigInt(active), BigInt(nominal)),
        });
      }
    }
    if (rows.length === 0) continue;
    rows.sort((a, b) => (a.periodEndsOn < b.periodEndsOn ? -1 : a.periodEndsOn > b.periodEndsOn ? 1 : 0));

    const totalUnits = rows.reduce((a, r) => a + toUnits(r.amount), 0n);
    const level = apportion(totalUnits, rows.map((r) => r.weight));
    let straightLine = 0n;
    let billed = 0n;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]!.periodEndsOn > asOf) break;
      straightLine += level[i]!;
      billed += toUnits(rows[i]!.amount);
    }
    const target = straightLine - billed;

    const posted = (await db.execute<{ accrual: string }>(sql`
      select coalesce(sum(jl.amount), 0)::text as accrual
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted','reversed')
       where jl.org_id = ${orgId} and je.origin = 'lease'
         and je.custom->'propertyManagement'->>'levellingLeaseId' = ${lease.id}
         and (${straightLineRentAccountId}::uuid is null or jl.account_id = ${straightLineRentAccountId}::uuid)
    `));
    const postedUnits = toUnits(posted.rows[0]?.accrual ?? "0");
    const deltaUnits = target - postedUnits;

    const base: LeaseLevellingResult = {
      leaseId: lease.id,
      leaseNumber: lease.leaseNumber,
      straightLineToDate: fromUnits(straightLine),
      billedToDate: fromUnits(billed),
      targetAccrual: fromUnits(target),
      postedAccrual: posted.rows[0]?.accrual ?? "0",
      delta: fromUnits(deltaUnits),
      entryId: null,
    };

    if (deltaUnits === 0n) {
      results.push(base);
      continue;
    }
    if (!straightLineRentAccountId) {
      throw new PropertyManagementError(
        "Configure the straight-line rent account (Company Settings → controlAccounts.straightLineRent) before levelling lease income",
      );
    }
    if (!lease.rentIncomeAccountId) {
      throw new PropertyManagementError(`Property for lease ${lease.leaseNumber} has no rent income account`);
    }

    const entryId = await withOrgTransaction(orgId, async () => {
      const ctx = (await db.execute<{ book_id: string | null; period_id: string | null }>(sql`
        select (select id from accounting_books where org_id = ${orgId} and is_primary limit 1) as book_id,
               (select id from accounting_periods where org_id = ${orgId} and not is_adjustment
                  and starts_on <= ${asOf} and ends_on >= ${asOf} limit 1) as period_id
      `));
      if (!ctx.rows[0]?.book_id) throw new PropertyManagementError("No primary accounting book");
      if (!ctx.rows[0]?.period_id) throw new PropertyManagementError(`No accounting period covers ${asOf}`);

      const amount = fromUnits(deltaUnits < 0n ? -deltaUnits : deltaUnits);
      const memo = `Straight-line rent levelling — ${lease.leaseNumber} (as of ${asOf})`;
      const entry = (await db.execute<{ id: string }>(sql`
        insert into journal_entries(org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin,custom,created_by,updated_by)
        values(${orgId},${ctx.rows[0].book_id},${lease.subsidiaryId},
               ${`SLR-${lease.leaseNumber}-${asOf}-${crypto.randomUUID().slice(0, 8)}`},${asOf},${ctx.rows[0].period_id},
               ${memo},'draft','lease',
               ${JSON.stringify({ propertyManagement: { levellingLeaseId: lease.id, asOf } })}::jsonb,
               ${actorId},${actorId}) returning id`));
      const eid = entry.rows[0]!.id;
      // delta > 0: income levelled ABOVE billing → DR accrual / CR income.
      // delta < 0: billing ran ahead (or the accrual releases) → reverse.
      const accrualLeg = deltaUnits > 0n ? amount : neg(amount);
      const incomeLeg = neg(accrualLeg);
      await db.execute(sql`
        insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,location_id,party_id,is_open_item,memo)
        values(${orgId},${eid},1,${straightLineRentAccountId},${lease.subsidiaryId},${accrualLeg},${lease.currency},${accrualLeg},1,${lease.locationId},${lease.tenantId},false,${memo})`);
      await db.execute(sql`
        insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,location_id,party_id,is_open_item,memo)
        values(${orgId},${eid},2,${lease.rentIncomeAccountId},${lease.subsidiaryId},${incomeLeg},${lease.currency},${incomeLeg},1,${lease.locationId},${lease.tenantId},false,${memo})`);
      await db.execute(sql`
        update journal_entries set status='posted',posted_at=now(),posted_by=${actorId},updated_at=now(),updated_by=${actorId}
         where org_id=${orgId} and id=${eid}`);
      return eid;
    });

    results.push({ ...base, entryId });
  }
  return results;
}

export async function billDueLeaseCharges(orgId: string, actorId: string | null, asOf?: string, onlyLeaseId?: string, onlyPropertyId?: string): Promise<{ billed: number; invoices: string[] }> {
  const through = asOf ?? await businessToday(orgId);
  await assertEnabled(db, orgId);
  const due = (await db.execute<any>(sql`
    select s.id,s.lease_id as "leaseId",s.due_on as "dueOn",s.amount,s.period_starts_on as "periodStartsOn",s.period_ends_on as "periodEndsOn",
      c.description,c.income_account_id as "incomeAccountId",c.item_id as "itemId",c.tax_code_id as "taxCodeId",
      l.tenant_id as "tenantId",l.lease_number as "leaseNumber",l.payment_terms_days as "paymentTermsDays",l.auto_post as "autoPost",l.created_by as "createdBy",
      p.subsidiary_id as "subsidiaryId",p.location_id as "locationId",p.currency
    from lease_schedule_lines s join lease_charges c on c.id=s.charge_id and c.org_id=s.org_id
    join property_leases l on l.id=s.lease_id and l.org_id=s.org_id join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
    where s.org_id=${orgId} and s.status='scheduled' and s.due_on<=${through} and l.status in ('active','notice')
      and l.auto_invoice and (${onlyLeaseId ?? null}::uuid is null or l.id=${onlyLeaseId ?? null})
      and (${onlyPropertyId ?? null}::uuid is null or l.property_id=${onlyPropertyId ?? null}) order by l.id,s.due_on,s.id
  `));
  const groups = new Map<string, any[]>(); for (const row of due.rows) groups.set(row.leaseId, [...(groups.get(row.leaseId) ?? []), row]);
  const invoices: string[] = [];
  for (const [leaseId, rows] of groups) {
    await withOrgTransaction(orgId, async () => {
      const candidateIds = rows.map((row) => row.id);
      const locked = (await db.execute<{ id: string }>(sql`
        select id from lease_schedule_lines
        where org_id=${orgId} and status='scheduled'
          and id::text in (select jsonb_array_elements_text(${JSON.stringify(candidateIds)}::jsonb))
        order by id for update
      `));
      const lockedIds = new Set(locked.rows.map((row) => row.id));
      const billRows = rows.filter((row) => lockedIds.has(row.id));
      if (!billRows.length) return;
      const ids = billRows.map((row) => row.id);
      const key = billingKey(leaseId, ids);
      const first = billRows[0]!;
      const prior = (await db.execute<{ id: string }>(sql`select id from documents where org_id=${orgId} and custom->'propertyManagement'->>'billingKey'=${key}`));
      let invoiceId = prior.rows[0]?.id;
      if (!invoiceId) {
        const lines: AdvancedBillingLine[] = billRows.map((row) => ({ description: `${row.description} · ${row.periodStartsOn}–${row.periodEndsOn}`, quantity: "1", unitPrice: row.amount, incomeAccountId: row.incomeAccountId, itemId: row.itemId, taxCodeId: row.taxCodeId }));
        const actor = actorId ?? first.createdBy; if (!actor) throw new PropertyManagementError(`Lease ${first.leaseNumber} has no billing owner`);
        const generated = await createSubscriptionInvoice({ orgId, actorId: actor, customerId: first.tenantId, subsidiaryId: first.subsidiaryId,
          locationId: first.locationId, currency: first.currency, incomeAccountId: null, itemId: null, taxCodeId: null,
          description: `Lease ${first.leaseNumber}`, quantity: "1", unitPrice: "0", memo: `Lease ${first.leaseNumber}`,
          invoiceDate: through, dueDate: addDays(through, first.paymentTermsDays), autoPost: first.autoPost, lines,
          custom: { propertyManagement: { billingKey: key, leaseId, scheduleIds: ids, kind: "rent" } } });
        invoiceId = generated.invoiceId;
      }
      await db.execute(sql`update lease_schedule_lines set status='invoiced',invoice_document_id=${invoiceId},updated_at=now(),updated_by=${actorId ?? first.createdBy}
        where org_id=${orgId} and status='scheduled' and id::text in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`);
      invoices.push(invoiceId);
    });
  }
  const billed = invoices.length
    ? (await db.execute<{ n: number }>(sql`select count(*)::int as n from lease_schedule_lines where org_id=${orgId} and invoice_document_id::text in (select jsonb_array_elements_text(${JSON.stringify(invoices)}::jsonb))`))
    : { rows: [{ n: 0 }] };
  return { billed: billed.rows[0]?.n ?? 0, invoices };
}

export async function assessLeaseLateFees(orgId: string, actorId: string, asOf?: string, onlyLeaseId?: string, onlyPropertyId?: string): Promise<{ created: number }> {
  const date = validDate(asOf ?? await businessToday(orgId), "Late-fee date")!;
  await assertEnabled(db, orgId);
  const overdue = (await db.execute<any>(sql`
    select (array_agg(s.id order by s.id))[1] as source_schedule_id,s.lease_id,
      l.late_fee_type,l.late_fee_value,p.rent_income_account_id,oi.transaction_open
    from lease_schedule_lines s join property_leases l on l.id=s.lease_id and l.org_id=s.org_id
    join managed_properties p on p.id=l.property_id and p.org_id=l.org_id join documents d on d.id=s.invoice_document_id and d.org_id=s.org_id
    join lateral (
      select greatest(abs(jl.txn_amount)-coalesce(sum(a.target_transaction_amount) filter(where a.unapplied_at is null),0),0)::text as transaction_open
      from journal_lines jl left join applications a on a.to_line_id=jl.id and a.org_id=jl.org_id
      where jl.entry_id=d.posted_entry_id and jl.org_id=d.org_id and jl.is_open_item and jl.amount>0
      group by jl.id
    ) oi on true
    where s.org_id=${orgId} and s.status='invoiced' and l.status in ('active','notice') and l.late_fee_type<>'none'
      and (${onlyLeaseId ?? null}::uuid is null or l.id=${onlyLeaseId ?? null})
      and (${onlyPropertyId ?? null}::uuid is null or l.property_id=${onlyPropertyId ?? null})
      and d.kind='customer_invoice' and d.status='posted' and d.due_date is not null and d.due_date + l.grace_days < ${date}
      and oi.transaction_open::numeric>0
    group by d.id,s.lease_id,l.late_fee_type,l.late_fee_value,p.rent_income_account_id,oi.transaction_open
  `));
  let created = 0;
  for (const row of overdue.rows) {
    const amount = row.late_fee_type === "fixed" ? normalizeMoney(row.late_fee_value) : mulPercent(row.transaction_open, row.late_fee_value);
    if (cmp(amount, "0") <= 0) continue;
    const result = (await db.execute(sql`
      with charge as (insert into lease_charges(org_id,lease_id,charge_type,description,amount,frequency,effective_from,effective_to,income_account_id,created_by,updated_by)
        select ${orgId},${row.lease_id},'late_fee','Late fee',${amount},'one_time',${date},${date},${row.rent_income_account_id},${actorId},${actorId}
        where not exists(select 1 from lease_schedule_lines where org_id=${orgId} and source_schedule_id=${row.source_schedule_id}) returning id)
      insert into lease_schedule_lines(org_id,lease_id,charge_id,period_starts_on,period_ends_on,due_on,amount,source_schedule_id,created_by,updated_by)
      select ${orgId},${row.lease_id},id,${date},${date},${date},${amount},${row.source_schedule_id},${actorId},${actorId} from charge returning id
    `));
    created += result.rows.length;
  }
  return { created };
}

export async function recordSecurityDeposit(input: { orgId: string; actorId: string; leaseId: string; kind: string; occurredOn: string; amount: string; bankAccountId?: string | null; offsetAccountId?: string | null; appliedDocumentId?: string | null; memo?: string | null; importKey?: string | null }): Promise<{ id: string; entryId: string; balance: string }> {
  const shape = depositPostingShape(input.kind);
  const occurredOn = validDate(input.occurredOn, "Deposit date")!;
  const amount = normalizeMoney(input.amount);
  if (cmp(amount, "0") <= 0) throw new PropertyManagementError("Deposit amount must be positive");
  if ((input.kind === "applied") !== Boolean(input.appliedDocumentId)) {
    throw new PropertyManagementError("An applied deposit must identify exactly one tenant invoice");
  }
  if (["interest", "adjustment_increase", "adjustment_decrease"].includes(input.kind) && !input.offsetAccountId) {
    throw new PropertyManagementError("Interest and adjustments require an offset account");
  }

  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    // The lease lock serializes balance-changing deposit activity. Journal,
    // application, and append-only subledger evidence commit as one unit.
    const ctx = (await tx.execute<any>(sql`
      select l.tenant_id,p.subsidiary_id,p.location_id,p.currency,s.base_currency,p.deposit_liability_account_id,p.default_bank_account_id,
        da.type as deposit_account_type,
        (select id from accounting_books where org_id=l.org_id and is_primary order by id limit 1) as book_id,
        (select id from accounting_periods where org_id=l.org_id and not is_adjustment and starts_on<=${occurredOn} and ends_on>=${occurredOn}
          and not period_module_is_closed(l.org_id,id,(select id from accounting_books where org_id=l.org_id and is_primary order by id limit 1),p.subsidiary_id,'gl')
          order by starts_on desc limit 1) as period_id
      from property_leases l join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
      join subsidiaries s on s.id=p.subsidiary_id and s.org_id=p.org_id
      left join accounts da on da.id=p.deposit_liability_account_id and da.org_id=p.org_id
      where l.org_id=${input.orgId} and l.id=${input.leaseId}
      for update of l
    `));
    const row = ctx.rows[0];
    if (!row) throw new PropertyManagementError("Lease not found");
    if (!row.deposit_liability_account_id || !["liability_current_other", "liability_long_term"].includes(row.deposit_account_type)) {
      throw new PropertyManagementError("Configure a liability account for property security deposits");
    }
    if (row.currency !== row.base_currency) {
      throw new PropertyManagementError("Security-deposit journals require the property currency to match the subsidiary functional currency");
    }
    if (!row.book_id || !row.period_id) throw new PropertyManagementError("A primary book and open GL period are required");

    const prior = (await tx.execute<{ kind: string; amount: string }>(sql`select kind,amount from security_deposit_transactions where org_id=${input.orgId} and lease_id=${input.leaseId}`));
    const nextBalance = depositBalance([...prior.rows, { kind: input.kind, amount }]);
    if (cmp(nextBalance, "0") < 0) throw new PropertyManagementError("Deposit transaction exceeds the tenant balance");

    const increase = shape.liabilitySide === "credit";
    const applied = shape.offsetIsArOpenItem;
    const bankId = ["received", "refunded"].includes(input.kind) ? input.bankAccountId ?? row.default_bank_account_id : null;
    if (["received", "refunded"].includes(input.kind) && !bankId) throw new PropertyManagementError("A bank account is required");
    if (bankId) {
      const bank = (await tx.execute<{ type: string }>(sql`select type from accounts where org_id=${input.orgId} and id=${bankId} and is_active and not is_summary`));
      if (bank.rows[0]?.type !== "asset_bank") throw new PropertyManagementError("Security-deposit cash must use an active bank account");
    }

    let targetLineId: string | null = null;
    let offsetId: string | null = applied ? null : input.offsetAccountId ?? bankId;
    if (applied) {
      const target = (await tx.execute<{ id: string; account_id: string }>(sql`
        select jl.id,jl.account_id
        from documents d join journal_lines jl on jl.entry_id=d.posted_entry_id and jl.org_id=d.org_id and jl.is_open_item
        join accounts a on a.id=jl.account_id and a.org_id=jl.org_id and a.type='asset_receivable'
        where d.org_id=${input.orgId} and d.id=${input.appliedDocumentId!} and d.kind='customer_invoice'
          and d.party_id=${row.tenant_id} and d.status='posted' and coalesce(d.open_balance,0)>=${amount}
        order by jl.line_number limit 1 for update of jl
      `));
      targetLineId = target.rows[0]?.id ?? null;
      offsetId = target.rows[0]?.account_id ?? null;
      if (!targetLineId || !offsetId) throw new PropertyManagementError("Posted tenant invoice with sufficient open balance not found");
    } else if (!offsetId) {
      throw new PropertyManagementError("An offset account is required");
    }

    const entryNumber = `DEP-${occurredOn}-${input.leaseId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    const entry = (await tx.execute<{ id: string }>(sql`insert into journal_entries(org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin,custom,created_by,updated_by)
      values(${input.orgId},${row.book_id},${row.subsidiary_id},${entryNumber},${occurredOn},${row.period_id},
        ${input.memo ?? `Security deposit ${input.kind}`},'draft','manual',${JSON.stringify({ propertyManagement: { leaseId: input.leaseId, kind: input.kind } })}::jsonb,
        ${input.actorId},${input.actorId}) returning id`));
    const entryId = entry.rows[0]!.id;
    const debitAccount = increase ? offsetId : row.deposit_liability_account_id;
    const creditAccount = increase ? row.deposit_liability_account_id : offsetId;
    // Party belongs on the deposit-liability leg. Cash/expense offsets do not
    // carry the tenant; an AR application additionally carries it on AR.
    const debitParty = increase ? null : row.tenant_id;
    const creditParty = increase || applied ? row.tenant_id : null;
    await tx.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,location_id,party_id,is_open_item,memo)
      values(${input.orgId},${entryId},1,${debitAccount},${row.subsidiary_id},${amount},${row.currency},${amount},1,${row.location_id},${debitParty},false,${input.memo ?? "Security deposit"})`);
    const credit = (await tx.execute<{ id: string }>(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,location_id,party_id,is_open_item,memo)
      values(${input.orgId},${entryId},2,${creditAccount},${row.subsidiary_id},${neg(amount)},${row.currency},${neg(amount)},1,${row.location_id},${creditParty},${applied},${input.memo ?? "Security deposit"}) returning id`));
    await tx.execute(sql`update journal_entries set status='posted',posted_at=now(),posted_by=${input.actorId},updated_at=now(),updated_by=${input.actorId} where org_id=${input.orgId} and id=${entryId}`);
    if (applied && targetLineId) {
      await tx.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,
        target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
        values(${input.orgId},${credit.rows[0]!.id},${targetLineId},${amount},${amount},${amount},${row.currency},${amount},${row.currency},1,'same_currency','Security deposit application',${occurredOn},${input.actorId},${input.actorId})`);
    }
    const inserted = (await tx.execute<{ id: string }>(sql`insert into security_deposit_transactions(org_id,lease_id,kind,occurred_on,amount,bank_account_id,offset_account_id,applied_document_id,journal_entry_id,import_key,memo,created_by,updated_by)
      values(${input.orgId},${input.leaseId},${input.kind},${occurredOn},${amount},${bankId},${offsetId},${input.appliedDocumentId ?? null},${entryId},${input.importKey?.trim() || null},${input.memo ?? null},${input.actorId},${input.actorId}) returning id`));
    return { id: inserted.rows[0]!.id, entryId, balance: nextBalance };
  });
}

export async function reverseSecurityDepositTransaction(input: {
  orgId: string; actorId: string; transactionId: string; occurredOn: string; reason: string;
}): Promise<{ id: string; entryId: string; balance: string }> {
  const occurredOn = validDate(input.occurredOn, "Reversal date")!;
  const reason = input.reason.trim();
  if (!reason) throw new PropertyManagementError("Reversal reason is required");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const context = (await tx.execute<any>(sql`
      select t.*,p.subsidiary_id,p.currency,s.base_currency,je.book_id,
        exists(select 1 from security_deposit_transactions r where r.org_id=t.org_id and r.reversal_of_id=t.id) as already_reversed,
        (select id from accounting_periods where org_id=t.org_id and not is_adjustment and starts_on<=${occurredOn} and ends_on>=${occurredOn}
          and not period_module_is_closed(t.org_id,id,je.book_id,p.subsidiary_id,'gl') order by starts_on desc limit 1) as period_id
      from security_deposit_transactions t
      join property_leases l on l.id=t.lease_id and l.org_id=t.org_id
      join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
      join subsidiaries s on s.id=p.subsidiary_id and s.org_id=p.org_id
      join journal_entries je on je.id=t.journal_entry_id and je.org_id=t.org_id
      where t.org_id=${input.orgId} and t.id=${input.transactionId} for update of t
    `));
    const row = context.rows[0];
    if (!row) throw new PropertyManagementError("Deposit transaction not found");
    if (row.reversal_of_id || row.already_reversed) throw new PropertyManagementError("Deposit transaction is already a reversal or has already been reversed");
    if (!row.period_id) throw new PropertyManagementError("An open GL period is required for the reversal date");
    if (row.currency !== row.base_currency) throw new PropertyManagementError("Security-deposit reversals require functional-currency deposits");

    const kind = depositReversalKind(row.kind);
    const prior = (await tx.execute<{ kind: string; amount: string }>(sql`select kind,amount from security_deposit_transactions where org_id=${input.orgId} and lease_id=${row.lease_id}`));
    const balance = depositBalance([...prior.rows, { kind, amount: row.amount }]);
    if (cmp(balance, "0") < 0) throw new PropertyManagementError("Later deposit activity must be corrected before this transaction can be reversed");

    const entryNumber = `DEP-REV-${occurredOn}-${input.transactionId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    const entry = (await tx.execute<{ id: string }>(sql`
      insert into journal_entries(org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin,reverses_entry_id,custom,created_by,updated_by)
      values(${input.orgId},${row.book_id},${row.subsidiary_id},${entryNumber},${occurredOn},${row.period_id},${`Deposit reversal: ${reason}`},'draft','manual',${row.journal_entry_id},
        ${JSON.stringify({ propertyManagement: { leaseId: row.lease_id, reversalOfId: input.transactionId, kind } })}::jsonb,${input.actorId},${input.actorId}) returning id
    `));
    const entryId = entry.rows[0]!.id;
    await tx.execute(sql`
      insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,memo,party_id,department_id,project_id,location_id,class_id,equipment_unit_id,payment_card_id,extra_dims,quantity,unit,due_date,is_open_item,tax_code_id,custom)
      select org_id,${entryId},line_number,account_id,subsidiary_id,-amount,currency,-txn_amount,fx_rate,${`Deposit reversal: ${reason}`},party_id,department_id,project_id,location_id,class_id,equipment_unit_id,payment_card_id,extra_dims,
        case when quantity is null then null else -quantity end,unit,due_date,is_open_item,tax_code_id,custom
      from journal_lines where org_id=${input.orgId} and entry_id=${row.journal_entry_id} order by line_number
    `);

    const applications = (await tx.execute<any>(sql`
      select a.*,source.line_number
      from applications a join journal_lines source on source.id=a.from_line_id and source.org_id=a.org_id
      where a.org_id=${input.orgId} and source.entry_id=${row.journal_entry_id} and a.unapplied_at is null for update of a
    `));
    if (applications.rows.length) {
      await tx.execute(sql`
        update applications set unapplied_at=now(),updated_at=now(),updated_by=${input.actorId}
        where org_id=${input.orgId} and unapplied_at is null and from_line_id in
          (select id from journal_lines where org_id=${input.orgId} and entry_id=${row.journal_entry_id})
      `);
      for (const application of applications.rows) {
        const reversalLine = (await tx.execute<{ id: string }>(sql`
          select id from journal_lines where org_id=${input.orgId} and entry_id=${entryId} and line_number=${application.line_number}
        `));
        await tx.execute(sql`
          insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,
            target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
          values(${input.orgId},${application.from_line_id},${reversalLine.rows[0]!.id},${application.amount},${application.source_amount},
            ${application.source_transaction_amount},${application.source_transaction_currency},${application.target_transaction_amount},${application.target_transaction_currency},
            ${application.settlement_rate},${application.settlement_rate_source},'Security deposit reversal',${occurredOn},${input.actorId},${input.actorId})
        `);
      }
    }
    await tx.execute(sql`update journal_entries set status='posted',posted_at=now(),posted_by=${input.actorId},updated_at=now(),updated_by=${input.actorId} where org_id=${input.orgId} and id=${entryId}`);
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into security_deposit_transactions(org_id,lease_id,kind,occurred_on,amount,bank_account_id,offset_account_id,journal_entry_id,reversal_of_id,memo,created_by,updated_by)
      values(${input.orgId},${row.lease_id},${kind},${occurredOn},${row.amount},${["received", "refunded"].includes(kind) ? row.bank_account_id : null},
        ${["received", "refunded"].includes(kind) ? row.bank_account_id : row.offset_account_id},${entryId},${input.transactionId},${`Reversal: ${reason}`},${input.actorId},${input.actorId}) returning id
    `));
    await audit(tx, input.orgId, "security_deposit_transactions", inserted.rows[0]!.id, "reverse", input.actorId, { reversalOfId: input.transactionId, reason, occurredOn });
    return { id: inserted.rows[0]!.id, entryId, balance };
  });
}

export async function createCamPool(input: { orgId: string; actorId: string; propertyId: string; name: string; fiscalYear: number; periodStartsOn: string; periodEndsOn: string; allocationBasis: "rentable_area" | "equal" | "custom"; budgetAmount: string; expenseAccountIds: string[] }): Promise<{ id: string }> {
  const name = input.name.trim();
  const startsOn = validDate(input.periodStartsOn, "CAM period start")!;
  const endsOn = validDate(input.periodEndsOn, "CAM period end")!;
  const expenseAccountIds = [...new Set(input.expenseAccountIds)];
  if (!name || !Number.isInteger(input.fiscalYear) || endsOn < startsOn) throw new PropertyManagementError("CAM name, fiscal year, and a valid period are required");
  if (!expenseAccountIds.length) throw new PropertyManagementError("Select at least one CAM expense account");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const accounts = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from accounts where org_id=${input.orgId} and id::text in
      (select jsonb_array_elements_text(${JSON.stringify(expenseAccountIds)}::jsonb)) and type in ('expense','expense_other') and is_active and not is_summary`));
    if (accounts.rows[0]?.n !== expenseAccountIds.length) throw new PropertyManagementError("CAM accounts must be active posting expense accounts");
    const result = (await tx.execute<{ id: string }>(sql`insert into cam_pools(org_id,property_id,name,fiscal_year,period_starts_on,period_ends_on,allocation_basis,budget_amount,expense_account_ids,status,created_by,updated_by)
      select ${input.orgId},id,${name},${input.fiscalYear},${startsOn},${endsOn},${input.allocationBasis},${normalizeMoney(input.budgetAmount)},${JSON.stringify(expenseAccountIds)}::jsonb,'open',${input.actorId},${input.actorId}
        from managed_properties where org_id=${input.orgId} and id=${input.propertyId} and status='active' returning id`));
    if (!result.rows[0]) throw new PropertyManagementError("Active property not found");
    return { id: result.rows[0].id };
  });
}

export async function updateCamPool(input: { orgId: string; actorId: string; poolId: string; name: string; fiscalYear: number; periodStartsOn: string; periodEndsOn: string; allocationBasis: "rentable_area" | "equal" | "custom"; budgetAmount: string; expenseAccountIds: string[] }): Promise<{ id: string }> {
  const name = input.name.trim();
  const startsOn = validDate(input.periodStartsOn, "CAM period start")!;
  const endsOn = validDate(input.periodEndsOn, "CAM period end")!;
  const expenseAccountIds = [...new Set(input.expenseAccountIds)];
  if (!name || !Number.isInteger(input.fiscalYear) || endsOn < startsOn) throw new PropertyManagementError("CAM name, fiscal year, and a valid period are required");
  if (!expenseAccountIds.length) throw new PropertyManagementError("Select at least one CAM expense account");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const accounts = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from accounts where org_id=${input.orgId} and id::text in
      (select jsonb_array_elements_text(${JSON.stringify(expenseAccountIds)}::jsonb)) and type in ('expense','expense_other') and is_active and not is_summary`));
    if (accounts.rows[0]?.n !== expenseAccountIds.length) throw new PropertyManagementError("CAM accounts must be active posting expense accounts");
    const result = (await tx.execute<{ id: string; propertyId: string }>(sql`
      update cam_pools set name=${name},fiscal_year=${input.fiscalYear},period_starts_on=${startsOn},period_ends_on=${endsOn},
        allocation_basis=${input.allocationBasis},budget_amount=${normalizeMoney(input.budgetAmount)},expense_account_ids=${JSON.stringify(expenseAccountIds)}::jsonb,
        updated_at=now(),updated_by=${input.actorId}
      where org_id=${input.orgId} and id=${input.poolId} and status in ('draft','open') returning id,property_id as "propertyId"
    `));
    const row = result.rows[0];
    if (!row) throw new PropertyManagementError("Editable CAM pool not found");
    await audit(tx, input.orgId, "cam_pools", input.poolId, "update", input.actorId, { name, fiscalYear: input.fiscalYear, periodStartsOn: startsOn, periodEndsOn: endsOn, allocationBasis: input.allocationBasis, budgetAmount: normalizeMoney(input.budgetAmount), expenseAccountIds });
    return { id: row.id };
  });
}

export async function cancelCamPool(orgId: string, actorId: string, poolId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const result = (await tx.execute<{ name: string }>(sql`
      update cam_pools set status='cancelled',updated_at=now(),updated_by=${actorId}
      where org_id=${orgId} and id=${poolId} and status in ('draft','open') returning name
    `));
    if (!result.rows[0]) throw new PropertyManagementError("Open CAM pool not found");
    await audit(tx, orgId, "cam_pools", poolId, "cancel", actorId, { after: { status: "cancelled" }, name: result.rows[0].name });
  });
}

export async function reopenFinalizedCamPool(orgId: string, actorId: string, poolId: string, reason: string): Promise<void> {
  const correctionReason = reason.trim();
  if (!correctionReason) throw new PropertyManagementError("CAM correction reason is required");
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const result = (await tx.execute<{ name: string; status: string; billed: boolean }>(sql`
      select cp.name,cp.status,exists(select 1 from cam_allocations a where a.org_id=cp.org_id and a.pool_id=cp.id and a.invoice_document_id is not null) as billed
      from cam_pools cp where cp.org_id=${orgId} and cp.id=${poolId} for update
    `));
    const pool = result.rows[0];
    if (!pool || pool.status !== "finalized") throw new PropertyManagementError("Finalized CAM pool not found");
    if (pool.billed) throw new PropertyManagementError("An invoiced CAM pool is immutable; correct the tenant documents and create a supplemental pool");
    await tx.execute(sql`delete from cam_allocations where org_id=${orgId} and pool_id=${poolId}`);
    await tx.execute(sql`update cam_pools set status='open',actual_amount=null,finalized_at=null,finalized_by=null,updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${poolId}`);
    await audit(tx, orgId, "cam_pools", poolId, "reopen", actorId, { reason: correctionReason, before: { status: "finalized" }, after: { status: "open" }, name: pool.name });
  });
}

export async function finalizeCamPool(orgId: string, actorId: string, poolId: string): Promise<{ actualAmount: string; allocations: number }> {
  return db.transaction(async (tx) => {
    const poolResult = (await tx.execute<any>(sql`select cp.*,p.location_id from cam_pools cp join managed_properties p on p.id=cp.property_id and p.org_id=cp.org_id where cp.org_id=${orgId} and cp.id=${poolId} for update`));
    const pool = poolResult.rows[0]; if (!pool || !["draft","open"].includes(pool.status)) throw new PropertyManagementError("Open CAM pool not found");
    if (!pool.location_id) throw new PropertyManagementError("Property needs a location dimension before CAM actuals can be calculated");
    const actual = (await tx.execute<{ amount: string }>(sql`select coalesce(sum(jl.amount),0)::text as amount from journal_lines jl join journal_entries je on je.id=jl.entry_id and je.org_id=jl.org_id
      where jl.org_id=${orgId} and je.status='posted' and je.posting_date between ${pool.period_starts_on} and ${pool.period_ends_on} and jl.location_id=${pool.location_id}
        and jl.account_id::text in(select jsonb_array_elements_text(${JSON.stringify(pool.expense_account_ids)}::jsonb))`));
    const actualAmount = normalizeMoney(actual.rows[0]?.amount ?? "0");
    if (cmp(actualAmount, "0") < 0) throw new PropertyManagementError("CAM expense activity is net-negative; review the selected accounts before finalizing");
    const leases = (await tx.execute<any>(sql`select l.id,l.cam_share_percent,u.rentable_area,
      greatest(l.starts_on,coalesce(l.move_in_on,l.starts_on),${pool.period_starts_on}::date)::text as overlap_start,
      least(coalesce(l.move_out_on,l.ends_on,${pool.period_ends_on}::date),${pool.period_ends_on}::date)::text as overlap_end,
      coalesce((select sum(s.amount) from lease_schedule_lines s join lease_charges c on c.id=s.charge_id and c.org_id=s.org_id
        join documents d on d.id=s.invoice_document_id and d.org_id=s.org_id and d.status<>'voided'
        where s.org_id=l.org_id and s.lease_id=l.id and c.charge_type='cam' and s.status='invoiced'
          and s.period_starts_on<=${pool.period_ends_on} and s.period_ends_on>=${pool.period_starts_on}),0)::text as billed
      from property_leases l left join property_units u on u.id=l.unit_id and u.org_id=l.org_id where l.org_id=${orgId} and l.property_id=${pool.property_id}
        and l.cam_method='pro_rata' and l.status not in ('draft','cancelled') and l.starts_on<=${pool.period_ends_on}
        and coalesce(l.move_out_on,l.ends_on,${pool.period_ends_on})>=${pool.period_starts_on}`));
    if (!leases.rows.length) throw new PropertyManagementError("No pro-rata CAM leases overlap this period");
    const poolDays = dayCount(pool.period_starts_on, pool.period_ends_on);
    const weighted = leases.rows.map((lease) => {
      const days = overlapDayCount(lease.overlap_start, lease.overlap_end, pool.period_starts_on, pool.period_ends_on);
      const basis = pool.allocation_basis === "equal" ? 10_000n
        : pool.allocation_basis === "rentable_area" ? toUnits(lease.rentable_area ?? "0")
          : toUnits(lease.cam_share_percent ?? "0");
      return { ...lease, days, weight: basis * BigInt(days) };
    }).filter((lease) => lease.days > 0 && lease.weight > 0n);
    if (!weighted.length) throw new PropertyManagementError(pool.allocation_basis === "rentable_area"
      ? "Overlapping CAM leases need positive rentable area" : "Overlapping CAM leases need a positive allocation weight");
    const totalWeight = weighted.reduce((total, lease) => total + lease.weight, 0n);
    const shares: string[] = [];
    for (const [index, lease] of weighted.entries()) {
      if (pool.allocation_basis === "custom") {
        shares.push(mulRatio(normalizeMoney(lease.cam_share_percent), BigInt(lease.days), BigInt(poolDays)));
      } else if (index === weighted.length - 1) {
        shares.push(add("100", neg(sum(shares))));
      } else {
        shares.push(mulRatio("100", lease.weight, totalWeight));
      }
    }
    if (pool.allocation_basis === "custom" && cmp(sum(shares), "100") > 0) {
      throw new PropertyManagementError("Time-weighted custom CAM shares exceed 100%");
    }
    const budgetAllocations: string[] = [];
    const actualAllocations: string[] = [];
    for (const [index, share] of shares.entries()) {
      const forceResidual = pool.allocation_basis !== "custom" && index === shares.length - 1;
      budgetAllocations.push(forceResidual ? add(pool.budget_amount, neg(sum(budgetAllocations))) : mulPercent(pool.budget_amount, share));
      actualAllocations.push(forceResidual ? add(actualAmount, neg(sum(actualAllocations))) : mulPercent(actualAmount, share));
    }
    await tx.execute(sql`delete from cam_allocations where org_id=${orgId} and pool_id=${poolId}`);
    for (const [index, lease] of weighted.entries()) {
      const share = shares[index]!;
      const budgetAllocation = budgetAllocations[index]!; const actualAllocation = actualAllocations[index]!;
      await tx.execute(sql`insert into cam_allocations(org_id,pool_id,lease_id,share_percent,budget_allocation,actual_allocation,billed_estimate,reconciliation_amount,created_by,updated_by)
        values(${orgId},${poolId},${lease.id},${share},${budgetAllocation},${actualAllocation},${lease.billed},${add(actualAllocation,neg(lease.billed))},${actorId},${actorId})`);
    }
    await tx.execute(sql`update cam_pools set actual_amount=${actualAmount},status='finalized',finalized_at=now(),finalized_by=${actorId},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${poolId}`);
    return { actualAmount, allocations: weighted.length };
  });
}

export async function billCamReconciliation(orgId: string, actorId: string, poolId: string, invoiceDate?: string): Promise<{ documents: string[] }> {
  const date = validDate(invoiceDate ?? await businessToday(orgId), "CAM invoice date")!;
  await assertEnabled(db, orgId);
  const allocations = (await db.execute<any>(sql`select a.id,a.reconciliation_amount as amount,a.lease_id,l.tenant_id,l.lease_number,l.payment_terms_days,
    p.subsidiary_id,p.location_id,p.currency,p.cam_income_account_id,cp.name from cam_allocations a join cam_pools cp on cp.id=a.pool_id and cp.org_id=a.org_id
    join property_leases l on l.id=a.lease_id and l.org_id=a.org_id join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
    where a.org_id=${orgId} and a.pool_id=${poolId} and cp.status='finalized' and a.invoice_document_id is null and a.reconciliation_amount<>0 order by l.lease_number`));
  const documents: string[] = [];
  for (const row of allocations.rows) {
    await withOrgTransaction(orgId, async () => {
      const locked = (await db.execute<{ id: string }>(sql`select id from cam_allocations where org_id=${orgId} and id=${row.id} and invoice_document_id is null for update`));
      if (!locked.rows[0]) return;
      if (!row.cam_income_account_id) throw new PropertyManagementError("Configure the property CAM income account first");
      const credit = cmp(row.amount, "0") < 0; const amount = credit ? neg(row.amount) : row.amount; const key = `cam:${poolId}:${row.id}`;
      const prior = (await db.execute<{ id: string }>(sql`select id from documents where org_id=${orgId} and custom->'propertyManagement'->>'billingKey'=${key}`));
      let documentId = prior.rows[0]?.id;
      if (!documentId) {
        const generated = await createSubscriptionInvoice({ orgId, actorId, customerId: row.tenant_id, subsidiaryId: row.subsidiary_id, locationId: row.location_id,
          currency: row.currency, incomeAccountId: row.cam_income_account_id, itemId: null, taxCodeId: null, description: `${row.name} CAM reconciliation`,
          quantity: "1", unitPrice: amount, memo: `${row.lease_number} · ${row.name}`, invoiceDate: date,
          dueDate: credit ? null : addDays(date, row.payment_terms_days), autoPost: false, applyTax: false, documentKind: credit ? "customer_credit" : "customer_invoice",
          custom: { propertyManagement: { billingKey: key, poolId, allocationId: row.id, leaseId: row.lease_id, kind: "cam_reconciliation" } } });
        documentId = generated.invoiceId;
      }
      await db.execute(sql`update cam_allocations set invoice_document_id=${documentId},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${row.id} and invoice_document_id is null`);
      documents.push(documentId);
    });
  }
  await db.execute(sql`update cam_pools cp set status='invoiced',updated_at=now(),updated_by=${actorId}
    where cp.org_id=${orgId} and cp.id=${poolId} and cp.status='finalized'
      and not exists(select 1 from cam_allocations a where a.org_id=cp.org_id and a.pool_id=cp.id and a.reconciliation_amount<>0 and a.invoice_document_id is null)`);
  return { documents };
}

export async function securityDepositReconciliation(orgId: string, asOf?: string) {
  const throughOn = validDate(asOf ?? await businessToday(orgId), "Reconciliation date")!;
  await assertEnabled(db, orgId);
  const properties = (await db.execute<any>(sql`
    select p.id as "propertyId",p.code as "propertyCode",p.name as "propertyName",p.subsidiary_id as "subsidiaryId",p.location_id as "locationId",p.currency,
      p.deposit_liability_account_id as "liabilityAccountId",concat_ws(' · ',la.number,la.name) as "liabilityAccountName",
      p.default_bank_account_id as "defaultBankAccountId",concat_ws(' · ',ba.number,ba.name) as "defaultBankAccountName",
      coalesce((select sum(case when d.kind in ('received','interest','adjustment_increase') then d.amount else -d.amount end)
        from security_deposit_transactions d join property_leases l on l.id=d.lease_id and l.org_id=d.org_id
        where d.org_id=p.org_id and l.property_id=p.id and d.occurred_on<=${throughOn}),0)::text as "subledgerBalance",
      coalesce((select -sum(jl.amount) from security_deposit_transactions d
        join property_leases l on l.id=d.lease_id and l.org_id=d.org_id
        join journal_entries je on je.id=d.journal_entry_id and je.org_id=d.org_id and je.status='posted'
        join journal_lines jl on jl.entry_id=je.id and jl.org_id=je.org_id and jl.account_id=p.deposit_liability_account_id
        where d.org_id=p.org_id and l.property_id=p.id and d.occurred_on<=${throughOn}),0)::text as "linkedGlBalance",
      case when p.location_id is null or p.deposit_liability_account_id is null then null else
        coalesce((select -sum(jl.amount) from journal_lines jl join journal_entries je on je.id=jl.entry_id and je.org_id=jl.org_id
          where jl.org_id=p.org_id and je.status='posted' and je.posting_date<=${throughOn}
            and jl.account_id=p.deposit_liability_account_id and jl.location_id=p.location_id),0)::text end as "locationControlBalance",
      coalesce((select sum(case when d.kind='received' then d.amount when d.kind='refunded' then -d.amount else 0 end)
        from security_deposit_transactions d join property_leases l on l.id=d.lease_id and l.org_id=d.org_id
        where d.org_id=p.org_id and l.property_id=p.id and d.occurred_on<=${throughOn}),0)::text as "cashActivity",
      (select max(d.occurred_on)::text from security_deposit_transactions d join property_leases l on l.id=d.lease_id and l.org_id=d.org_id
        where d.org_id=p.org_id and l.property_id=p.id and d.occurred_on<=${throughOn}) as "lastActivityOn"
    from managed_properties p
    left join accounts la on la.id=p.deposit_liability_account_id and la.org_id=p.org_id
    left join accounts ba on ba.id=p.default_bank_account_id and ba.org_id=p.org_id
    where p.org_id=${orgId} order by p.name
  `));
  const banks = (await db.execute<any>(sql`
    select l.property_id as "propertyId",d.bank_account_id as "bankAccountId",concat_ws(' · ',a.number,a.name) as "bankAccountName",
      sum(case when d.kind='received' then d.amount when d.kind='refunded' then -d.amount else 0 end)::text as "cashActivity"
    from security_deposit_transactions d join property_leases l on l.id=d.lease_id and l.org_id=d.org_id
    join accounts a on a.id=d.bank_account_id and a.org_id=d.org_id
    where d.org_id=${orgId} and d.occurred_on<=${throughOn} and d.bank_account_id is not null
    group by l.property_id,d.bank_account_id,a.number,a.name order by a.number,a.name
  `));
  const leases = (await db.execute<any>(sql`
    select l.id as "leaseId",l.property_id as "propertyId",l.lease_number as "leaseNumber",l.status,t.display_name as "tenantName",u.code as "unitCode",
      coalesce(sum(case when d.kind in ('received','interest','adjustment_increase') then d.amount else -d.amount end),0)::text as balance,
      max(d.occurred_on)::text as "lastActivityOn"
    from property_leases l join parties t on t.id=l.tenant_id and t.org_id=l.org_id
    left join property_units u on u.id=l.unit_id and u.org_id=l.org_id
    left join security_deposit_transactions d on d.lease_id=l.id and d.org_id=l.org_id and d.occurred_on<=${throughOn}
    where l.org_id=${orgId} group by l.id,t.display_name,u.code order by l.lease_number
  `));
  const rows = properties.rows.map((row) => {
    const subledgerBalance = normalizeMoney(row.subledgerBalance ?? "0");
    const linkedGlBalance = normalizeMoney(row.linkedGlBalance ?? "0");
    const locationControlBalance = row.locationControlBalance == null ? null : normalizeMoney(row.locationControlBalance);
    const linkedVariance = add(linkedGlBalance, neg(subledgerBalance));
    const controlVariance = locationControlBalance == null ? null : add(locationControlBalance, neg(subledgerBalance));
    const status = !row.liabilityAccountId
      ? "configuration_required"
      : cmp(linkedVariance, "0") !== 0 || (controlVariance != null && cmp(controlVariance, "0") !== 0)
        ? "discrepancy"
        : !row.locationId
          ? "limited"
          : "reconciled";
    return {
      ...row,
      subledgerBalance,
      linkedGlBalance,
      locationControlBalance,
      linkedVariance,
      controlVariance,
      cashActivity: normalizeMoney(row.cashActivity ?? "0"),
      status,
      bankAccounts: banks.rows.filter((bank) => bank.propertyId === row.propertyId).map((bank) => ({ ...bank, cashActivity: normalizeMoney(bank.cashActivity ?? "0") })),
      leases: leases.rows.filter((lease) => lease.propertyId === row.propertyId).map((lease) => ({ ...lease, balance: normalizeMoney(lease.balance ?? "0") })),
    };
  });
  return {
    asOf: throughOn,
    rows,
    totals: {
      subledgerBalance: sum(rows.map((row) => row.subledgerBalance)),
      linkedGlBalance: sum(rows.map((row) => row.linkedGlBalance)),
      cashActivity: sum(rows.map((row) => row.cashActivity)),
      discrepancies: rows.filter((row) => row.status === "discrepancy").length,
      configurationRequired: rows.filter((row) => row.status === "configuration_required").length,
    },
  };
}

export async function propertyManagementWorkspace(orgId: string) {
  const [properties, units, leases, charges, escalations, schedules, deposits, pools, allocations] = await Promise.all([
    db.execute<any>(sql`select p.id,p.code,p.name,p.property_type as "propertyType",p.status,p.currency,p.address,p.custom,p.subsidiary_id as "subsidiaryId",s.name as "subsidiaryName",p.location_id as "locationId",l.name as "locationName",p.fixed_asset_id as "fixedAssetId",
      p.rent_income_account_id as "rentIncomeAccountId",p.cam_income_account_id as "camIncomeAccountId",p.deposit_liability_account_id as "depositLiabilityAccountId",p.default_bank_account_id as "defaultBankAccountId",
      count(u.id)::int as "unitCount",count(u.id) filter(where u.status='occupied')::int as "occupiedUnits" from managed_properties p join subsidiaries s on s.id=p.subsidiary_id and s.org_id=p.org_id
      left join locations l on l.id=p.location_id and l.org_id=p.org_id left join property_units u on u.property_id=p.id and u.org_id=p.org_id where p.org_id=${orgId} group by p.id,s.name,l.name order by p.name`),
    db.execute<any>(sql`select id,property_id as "propertyId",code,name,unit_type as "unitType",rentable_area as "rentableArea",bedrooms,status from property_units where org_id=${orgId} order by property_id,code`),
    db.execute<any>(sql`select l.id,l.property_id as "propertyId",l.unit_id as "unitId",l.tenant_id as "tenantId",l.lease_number as "leaseNumber",l.status,l.starts_on as "startsOn",l.ends_on as "endsOn",
      l.billing_day as "billingDay",l.payment_terms_days as "paymentTermsDays",l.security_deposit_required as "securityDepositRequired",l.cam_method as "camMethod",l.cam_share_percent as "camSharePercent",
      l.late_fee_type as "lateFeeType",l.late_fee_value as "lateFeeValue",l.grace_days as "graceDays",l.auto_invoice as "autoInvoice",l.auto_post as "autoPost",l.notes,
      (select c.amount from lease_charges c where c.org_id=l.org_id and c.lease_id=l.id and c.charge_type='base_rent' order by c.effective_from desc limit 1) as "baseRent",
      p.name as "propertyName",u.code as "unitCode",t.display_name as "tenantName",p.currency,
      coalesce((select sum(case when d.kind in ('received','interest','adjustment_increase') then d.amount else -d.amount end) from security_deposit_transactions d where d.org_id=l.org_id and d.lease_id=l.id),0)::text as "depositBalance"
      from property_leases l join managed_properties p on p.id=l.property_id and p.org_id=l.org_id left join property_units u on u.id=l.unit_id and u.org_id=l.org_id
      join parties t on t.id=l.tenant_id and t.org_id=l.org_id where l.org_id=${orgId} order by case l.status when 'active' then 0 when 'notice' then 1 when 'draft' then 2 else 3 end,l.lease_number`),
    db.execute<any>(sql`select id,lease_id as "leaseId",charge_type as "chargeType",description,amount,frequency,effective_from as "effectiveFrom",effective_to as "effectiveTo" from lease_charges where org_id=${orgId} order by effective_from`),
    db.execute<any>(sql`select id,lease_id as "leaseId",effective_on as "effectiveOn",method,value,previous_amount as "previousAmount",new_amount as "newAmount",status from lease_escalations where org_id=${orgId} order by effective_on desc`),
    db.execute<any>(sql`select s.id,s.lease_id as "leaseId",s.period_starts_on as "periodStartsOn",s.period_ends_on as "periodEndsOn",s.due_on as "dueOn",s.amount,s.status,s.invoice_document_id as "invoiceDocumentId",d.document_number as "invoiceNumber",
      d.status as "invoiceStatus",d.due_date as "invoiceDueOn",d.open_balance as "invoiceOpenBalance",c.charge_type as "chargeType",c.description
      from lease_schedule_lines s join lease_charges c on c.id=s.charge_id and c.org_id=s.org_id
      left join documents d on d.id=s.invoice_document_id and d.org_id=s.org_id where s.org_id=${orgId} order by s.due_on desc limit 2000`),
    db.execute<any>(sql`select d.id,d.lease_id as "leaseId",d.kind,d.occurred_on as "occurredOn",d.amount,d.bank_account_id as "bankAccountId",d.offset_account_id as "offsetAccountId",d.applied_document_id as "appliedDocumentId",d.journal_entry_id as "journalEntryId",d.reversal_of_id as "reversalOfId",d.memo,
      exists(select 1 from security_deposit_transactions r where r.org_id=d.org_id and r.reversal_of_id=d.id) as reversed
      from security_deposit_transactions d where d.org_id=${orgId} order by d.occurred_on desc,d.created_at desc`),
    db.execute<any>(sql`select id,property_id as "propertyId",name,fiscal_year as "fiscalYear",period_starts_on as "periodStartsOn",period_ends_on as "periodEndsOn",allocation_basis as "allocationBasis",budget_amount as "budgetAmount",actual_amount as "actualAmount",expense_account_ids as "expenseAccountIds",status from cam_pools where org_id=${orgId} order by fiscal_year desc,name`),
    db.execute<any>(sql`select id,pool_id as "poolId",lease_id as "leaseId",share_percent as "sharePercent",budget_allocation as "budgetAllocation",actual_allocation as "actualAllocation",billed_estimate as "billedEstimate",reconciliation_amount as "reconciliationAmount",invoice_document_id as "invoiceDocumentId" from cam_allocations where org_id=${orgId} order by created_at`),
  ]);
  return { properties: properties.rows, units: units.rows, leases: leases.rows, charges: charges.rows, escalations: escalations.rows, schedules: schedules.rows, deposits: deposits.rows, camPools: pools.rows, camAllocations: allocations.rows };
}

/** Scheduler entry point. Each org/lease is idempotent through invoice billing keys and schedule status. */
export async function runDuePropertyBilling(asOf?: string): Promise<{ billed: number; invoices: number; lateFees: number }> {
  const result = { billed: 0, invoices: 0, lateFees: 0 };
  const orgs = await withBypass(async () => (await db.execute<{ id: string }>(sql`select id from orgs where coalesce((settings->'features'->>'propertyManagement')::boolean,false)`)));
  for (const org of orgs.rows) await withOrg(org.id, async () => {
    // Each org bills on its own calendar day.
    const date = asOf ?? await businessToday(org.id);
    const leases = (await db.execute<{ id: string; actor: string | null }>(sql`select id,coalesce(updated_by,created_by) as actor from property_leases where org_id=${org.id} and status in ('active','notice') and auto_invoice`));
    for (const lease of leases.rows) {
      if (!lease.actor) continue;
      await scheduleLeaseCharges(org.id, lease.actor, lease.id);
    }
    const feeActor = leases.rows.find((lease) => lease.actor)?.actor;
    const fees = feeActor ? await assessLeaseLateFees(org.id, feeActor, date) : { created: 0 };
    const billed = await billDueLeaseCharges(org.id, null, date);
    result.billed += billed.billed; result.invoices += billed.invoices.length; result.lateFees += fees.created;
  });
  return result;
}
