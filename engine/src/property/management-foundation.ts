/** Foundation: error, scope locks, money/date helpers, shared row shapes, guards. Split from property/management.ts (pure moves only). */
import { sql } from "drizzle-orm";
import { type db, type SqlExecutor } from "../platform/db.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { add, cmp, fitsLedgerRange, mulPercent, mulRatio, neg, normalizeMoney, sum } from "../money/money.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { dataDependentFeatureDefault } from "../organization/feature-defaults.ts";
import { loadSubsidiaryContext, SubsidiaryError, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";

export class PropertyManagementError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "PropertyManagementError";
  }
}
/**
 * Rehome-safe subsidiary gate for property writes, on the canonical
 * lock-then-assert order: lock the property row FIRST (FOR UPDATE) so a
 * concurrent subsidiary move either commits before this lock is taken (and
 * is then observed) or waits behind it — then assert the caller may touch
 * the freshly-read subsidiary. A missing row and an out-of-scope row are
 * the same uniform not-found, so a restricted caller cannot probe another
 * entity's records by id.
 */
export async function lockPropertyInScope(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  propertyId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<string> {
  const row = (await tx.execute<{ subsidiary_id: string }>(sql`
    select subsidiary_id from managed_properties where org_id=${orgId} and id=${propertyId} for update`)).rows[0];
  if (!row || !subsidiaryScopeAllows(allowedSubsidiaryIds, String(row.subsidiary_id))) {
    throw new ScopeNotFoundError();
  }
  return String(row.subsidiary_id);
}
/**
 * Global property lock order: whenever one transaction holds two property
 * rows at once (a lease moving between properties locks its current and its
 * target), they are taken in ascending id order. Two concurrent moves in
 * opposite directions otherwise take the same pair in opposite orders and
 * Postgres aborts one with a deadlock. A single id locks once; every id is
 * scope-checked while its lock is held, exactly as lockPropertyInScope does.
 */
export async function lockPropertiesInScope(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  propertyIds: readonly string[],
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<string[]> {
  const ordered = [...new Set(propertyIds)].sort();
  const subsidiaries: string[] = [];
  for (const propertyId of ordered) {
    subsidiaries.push(await lockPropertyInScope(tx, orgId, propertyId, allowedSubsidiaryIds));
  }
  return subsidiaries;
}
/**
 * Lease-anchored variant: locks the lease AND its property (lease first,
 * matching the termination/lease-edit lock order) and asserts the caller
 * may touch the property's freshly-read subsidiary.
 */
export async function lockLeasePropertyInScope(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  leaseId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ propertyId: string; subsidiaryId: string }> {
  const row = (await tx.execute<{ property_id: string; subsidiary_id: string }>(sql`
    select p.id as property_id, p.subsidiary_id
      from property_leases l join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
     where l.org_id=${orgId} and l.id=${leaseId} for update of l, p`)).rows[0];
  if (!row || !subsidiaryScopeAllows(allowedSubsidiaryIds, String(row.subsidiary_id))) {
    throw new ScopeNotFoundError();
  }
  return { propertyId: String(row.property_id), subsidiaryId: String(row.subsidiary_id) };
}
/**
 * Scope recheck for writes that already hold the parent lock through their
 * own locked read: the subsidiary below was read under the lock, so the
 * uniform denial closes the rehome window.
 */
export function assertLockedSubsidiaryInScope(
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  subsidiaryId: string,
): void {
  if (!subsidiaryScopeAllows(allowedSubsidiaryIds, subsidiaryId)) throw new ScopeNotFoundError();
}
export const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Cash and control classes never serve as the offset for deposit interest or adjustments. */
export const DEPOSIT_OFFSET_EXCLUDED_TYPES = new Set(["asset_bank", "asset_receivable", "liability_payable", "liability_card"]);
export function exactMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new PropertyManagementError(`${label} must be an exact decimal`);
  // Every property money column is numeric(19,4): a wider figure would die in
  // Postgres as a raw storage failure (generic 500 at the route), so refuse
  // it here with a named error before any write — one funnel for all callers,
  // through the one shared ledger bound every amount gate uses.
  if (!fitsLedgerRange(exact)) throw new PropertyManagementError(`${label} is out of range — at most 15 whole digits fit the ledger`);
  try {
    return normalizeMoney(exact);
  } catch {
    throw new PropertyManagementError(`${label} must be an exact decimal`);
  }
}
export const isoDate = /^\d{4}-\d{2}-\d{2}$/;
export function validDate(value: string | null | undefined, label: string): string | null {
  if (value == null || value === "") return null;
  if (!isoDate.test(value)) throw new PropertyManagementError(`${label} is invalid`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || toIso(parsed) !== value) throw new PropertyManagementError(`${label} is invalid`);
  return value;
}
export function utc(iso: string): Date { return new Date(`${iso}T00:00:00Z`); }
export function toIso(date: Date): string { return date.toISOString().slice(0, 10); }
export function addDays(iso: string, days: number): string { const d = utc(iso); d.setUTCDate(d.getUTCDate() + days); return toIso(d); }
export function startOfMonth(iso: string): string { return `${iso.slice(0, 7)}-01`; }
export function addMonths(iso: string, months: number): string {
  const d = utc(startOfMonth(iso)); d.setUTCMonth(d.getUTCMonth() + months); return toIso(d);
}
export function endOfMonth(iso: string): string { return addDays(addMonths(startOfMonth(iso), 1), -1); }
export function dayCount(a: string, b: string): number { return Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000) + 1; }
export function clampDue(month: string, billingDay: number): string {
  const last = Number(endOfMonth(month).slice(8, 10));
  return `${month.slice(0, 8)}${String(Math.min(Math.max(1, billingDay), last)).padStart(2, "0")}`;
}
export function maxDate(...dates: string[]): string { return dates.reduce((a, b) => a > b ? a : b); }
export function minDate(...dates: string[]): string { return dates.reduce((a, b) => a < b ? a : b); }
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
export interface LeaseScheduleContextRow extends Record<string, unknown> {
  startsOn: string; endsOn: string | null; billingDay: number; status: string;
}
export interface LeaseChargeScheduleRow extends Record<string, unknown> {
  id: string; amount: string; frequency: "monthly" | "quarterly" | "annually" | "one_time";
  effectiveFrom: string; effectiveTo: string | null;
}
export interface LeaseEscalationDbRow extends Record<string, unknown> {
  id: string; lease_id: string; effective_on: string; method: "percent" | "fixed" | "new_amount";
  value: string; status: string;
}
export interface BaseRentChargeRow extends Record<string, unknown> {
  id: string; description: string; amount: string; frequency: string; effective_from: string;
  effective_to: string | null; income_account_id: string | null; item_id: string | null; tax_code_id: string | null;
}
export interface DueLeaseChargeRow extends Record<string, unknown> {
  id: string; leaseId: string; dueOn: string; amount: string; periodStartsOn: string; periodEndsOn: string;
  description: string; incomeAccountId: string | null; itemId: string | null; taxCodeId: string | null;
  tenantId: string; leaseNumber: string; paymentTermsDays: number; autoPost: boolean;
  subsidiaryId: string; locationId: string | null; currency: string;
}
export interface LateFeeRow extends Record<string, unknown> {
  source_schedule_id: string; lease_id: string; late_fee_type: string; late_fee_value: string;
  rent_income_account_id: string; transaction_open: string;
}
export interface DepositContextRow extends Record<string, unknown> {
  tenant_id: string; subsidiary_id: string; location_id: string | null; currency: string; base_currency: string;
  deposit_liability_account_id: string | null; default_bank_account_id: string | null;
  book_id: string | null;
}
export interface DepositReversalRow extends Record<string, unknown> {
  kind: string; amount: string; lease_id: string; reversal_of_id: string | null; already_reversed: boolean;
  currency: string; base_currency: string; book_id: string; subsidiary_id: string;
  journal_entry_id: string; bank_account_id: string | null; offset_account_id: string | null;
}
export interface CamPoolDbRow extends Record<string, unknown> {
  id: string; property_id: string; status: string; location_id: string | null; period_starts_on: string;
  period_ends_on: string; expense_account_ids: string[]; allocation_basis: "rentable_area" | "equal" | "custom";
  budget_amount: string; subsidiary_id: string; currency: string;
}
export interface CamLeaseRow extends Record<string, unknown> {
  id: string; lease_number: string; cam_share_percent: string | null; rentable_area: string | null; overlap_start: string;
  overlap_end: string; billed: string;
}
export interface CamAllocationDbRow extends Record<string, unknown> {
  id: string; amount: string; lease_id: string; tenant_id: string; lease_number: string; payment_terms_days: number;
  subsidiary_id: string; location_id: string | null; currency: string; cam_income_account_id: string | null; name: string;
}
export interface DepositPropertyRow extends Record<string, unknown> {
  propertyId: string; propertyCode: string; propertyName: string; subsidiaryId: string; locationId: string | null;
  currency: string; liabilityAccountId: string | null; liabilityAccountName: string | null;
  defaultBankAccountId: string | null; defaultBankAccountName: string | null; subledgerBalance: string;
  linkedGlBalance: string; locationControlBalance: string | null; cashActivity: string; lastActivityOn: string | null;
}
export interface DepositBankRow extends Record<string, unknown> {
  propertyId: string; bankAccountId: string; bankAccountName: string; cashActivity: string;
}
export interface DepositLeaseRow extends Record<string, unknown> {
  leaseId: string; propertyId: string; leaseNumber: string; status: string; tenantName: string;
  unitCode: string | null; balance: string; lastActivityOn: string | null;
}
/** Exact, inclusive-day proration for partial first/last rental periods. */
export function prorateLeaseCharge(amount: string, nominalStart: string, nominalEnd: string, activeStart: string, activeEnd: string): string {
  const total = dayCount(nominalStart, nominalEnd);
  const active = Math.max(0, dayCount(maxDate(nominalStart, activeStart), minDate(nominalEnd, activeEnd)));
  if (active <= 0 || total <= 0) return "0.0000";
  return mulRatio(exactMoney(amount, "Charge amount"), BigInt(active), BigInt(total));
}
/** Deterministic charge schedule used by activation, amendments, and tests. */
export function leaseChargeSchedule(input: {
  amount: string; frequency: "monthly" | "quarterly" | "annually" | "one_time";
  effectiveFrom: string; effectiveTo?: string | null; leaseStartsOn: string; leaseEndsOn?: string | null;
  throughOn: string; billingDay: number;
}): SchedulePeriod[] {
  if (input.frequency !== "monthly" && input.frequency !== "quarterly" && input.frequency !== "annually" && input.frequency !== "one_time") {
    throw new PropertyManagementError("Invalid charge frequency");
  }
  const start = maxDate(input.effectiveFrom, input.leaseStartsOn);
  const end = minDate(input.effectiveTo ?? input.throughOn, input.leaseEndsOn ?? input.throughOn, input.throughOn);
  if (end < start) return [];
  if (input.frequency === "one_time") return [{ periodStartsOn: start, periodEndsOn: start, dueOn: start, amount: exactMoney(input.amount, "Charge amount") }];
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
  if (method !== "percent" && method !== "fixed" && method !== "new_amount") throw new PropertyManagementError("Invalid escalation method");
  const base = exactMoney(current, "Current rent"); const v = exactMoney(value, "Escalation value");
  const next = method === "percent" ? add(base, mulPercent(base, v)) : method === "fixed" ? add(base, v) : v;
  if (cmp(next, "0") <= 0) throw new PropertyManagementError("Escalated rent must be positive");
  return next;
}
export type DepositKind = "received" | "interest" | "applied" | "refunded" | "adjustment_increase" | "adjustment_decrease";
export const DEPOSIT_KINDS = new Set<DepositKind>(["received", "interest", "applied", "refunded", "adjustment_increase", "adjustment_decrease"]);
export function asDepositKind(value: string): DepositKind {
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
/** Narrow mapper for the deposit import backstop. The import key is org-wide
 * while the duplicate preflight runs under one lease lock, so a concurrent
 * import on another lease can only surface as this exact unique violation.
 * Only that conflict becomes a domain error; every other storage failure
 * propagates untouched. */
export function isSecurityDepositImportConflict(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; cursor instanceof Error && depth < 5; depth += 1) {
    if ((cursor as { constraint?: unknown }).constraint === "security_deposits_import_key_once") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}
// Canonical switchboard read: the previous inline ::boolean cast threw
// 22P02 on a non-boolean stored value.
export async function assertEnabled(runner: Pick<typeof db, "execute">, orgId: string): Promise<void> {
  const tx = runner as SqlExecutor
  await acquireOrgFeatureGateLock(tx, orgId)
  if (!(await lockAndCheckOrgFeature(tx, orgId, "propertyManagement"))) {
    throw new PropertyManagementError("Property management feature is disabled");
  }
}
export async function assertPropertyPostingScope(
  runner: Pick<typeof db, "execute">,
  orgId: string,
  subsidiaryId: string,
  accountIds: Array<string | null | undefined>,
): Promise<void> {
  const lines = [...new Set(accountIds.filter((id): id is string => Boolean(id)))].map((accountId) => ({
    accountId,
    amount: "0",
    subsidiaryId,
  }));
  try {
    await validateSubsidiaryRestrictions(runner, {
      orgId,
      ctx: await loadSubsidiaryContext(runner, orgId),
      docSubsidiaryId: subsidiaryId,
      lines,
    });
  } catch (error) {
    if (error instanceof SubsidiaryError) throw new PropertyManagementError(error.message);
    throw error;
  }
}
// Canonical switchboard read: the previous inline ::boolean cast threw
// 22P02 on a non-boolean stored value.
export async function fixedAssetsFeatureEnabled(runner: Pick<typeof db, "execute">, orgId: string): Promise<boolean> {
  return orgFeatureEnabled(orgId, "fixedAssets", runner as SqlExecutor);
}
/** The shared data-dependent resolver, not a second copy of the SQL: the
 * previous local read answered "off" for orgs whose flag was never stored
 * but whose ledger carries foreign-currency lines — precisely the orgs the
 * default exists to keep working. */
export async function multiCurrencyFeatureEnabled(runner: Pick<typeof db, "execute">, orgId: string): Promise<boolean> {
  const result = (await runner.execute<{ features: Record<string, boolean> | null }>(sql`
    select settings->'features' as features from orgs where id=${orgId}
  `));
  return dataDependentFeatureDefault(runner as Parameters<typeof dataDependentFeatureDefault>[0], orgId, "multiCurrency", result.rows[0]?.features ?? null);
}
export async function audit(tx: Pick<typeof db, "execute">, orgId: string, table: string, rowId: string, action: string, actorId: string | null, changes: unknown, requestId?: string | null) {
  await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id,request_id)
    values(${orgId},${table},${rowId},${action},${JSON.stringify(changes)}::jsonb,${actorId},${requestId ?? null})`);
}
