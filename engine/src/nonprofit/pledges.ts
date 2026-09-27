import { sql } from "drizzle-orm";
import {
  MAX_PRESENT_VALUE_PERIODS,
  periodInterest,
  periodRateFromAnnualPercent,
  presentValueOfLevelStream,
} from "../money/present-value.ts";
import { fromUnits, roundDiv, toUnits } from "../money/money.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { db, schema, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { NonprofitError } from "./errors.ts";

const FEATURE = "pledges";
const MONTHS_PER_YEAR = 12;
const MAX_MONTHS = MAX_PRESENT_VALUE_PERIODS;
const MAX_NUMERIC_19_4_UNITS = 9_999_999_999_999_999_999n;
const MARKER = "nonprofitPledge";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
type EntryNumberTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface PledgeInstallmentInput { dueOn: string; amount: string }
export interface CreatePledgeInput {
  orgId: string;
  subsidiaryId: string;
  donorPartyId: string;
  fundId: string;
  totalAmount: string;
  /** Annual percentage, discounted with the money kernel's monthly rate. */
  discountRate: string;
  installments: readonly PledgeInstallmentInput[];
  reason: string;
  custom?: Record<string, unknown>;
  actorId?: string | null;
}
export interface PledgeCashFlow { dueOn: string; amount: string }
export interface PledgeAmortizationPeriod {
  period: number;
  month: string;
  periodEnd: string;
  openingCarryingAmount: string;
  discountAmortization: string;
  scheduledCollection: string;
  closingCarryingAmount: string;
}
export interface PledgeScheduleInstallment {
  id: string;
  installmentNumber: number;
  dueOn: string;
  amount: string;
  collectedAmount: string;
  writtenOffAmount: string;
  outstandingAmount: string;
  status: "open" | "overdue" | "partially_collected" | "collected" | "partially_written_off" | "written_off";
}
export interface PledgeSchedule {
  pledgeId: string;
  pledgeNumber: string;
  status: string;
  bookedOn: string;
  totalAmount: string;
  presentValue: string;
  discountRate: string;
  installments: PledgeScheduleInstallment[];
  amortization: PledgeAmortizationPeriod[];
}
interface PledgeRow extends Record<string, unknown> {
  id: string; pledge_number: string; subsidiary_id: string; donor_party_id: string;
  fund_id: string; total_amount: string; discount_rate: string; present_value: string | null;
  allowance_amount: string; status: string; booked_on: string | null; booking_entry_id: string | null;
}
interface InstallmentRow extends Record<string, unknown> {
  id: string; installment_number: number; due_on: string; amount: string;
}
interface Activity {
  collected: Map<string, bigint>;
  writtenOff: Map<string, bigint>;
  collectionsByMonth: Map<string, bigint>;
  amortizedByMonth: Map<string, bigint>;
  amortizedMonths: Set<string>;
  totalCollected: bigint;
  totalWrittenOff: bigint;
  totalAllowanceTopUp: bigint;
}
interface Marker {
  operation?: string;
  pledgeId?: string;
  amount?: string;
  month?: string;
  allocations?: { installmentId?: string; amount?: string }[];
}

function fail(input: {
  message: string; code: string; remedy: string; status?: 409 | 422; field?: string;
}): NonprofitError {
  return new NonprofitError({
    message: input.message, status: input.status ?? 422, code: input.code, remedy: input.remedy,
    ...(input.field ? { field: input.field } : {}),
  });
}
function featureOff(): NonprofitError {
  return fail({
    message: "Pledges are disabled; enable pledges in Company Settings → Features.",
    code: "feature_off", remedy: "Enable Pledges in Company Settings → Features.",
  });
}
async function lockFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, FEATURE))) throw featureOff();
}
function uuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) throw fail({
    message: field + " must identify a valid record.", code: "pledge_reference_invalid",
    remedy: "Choose an existing record for " + field + ".", field,
  });
}
function date(value: string, field: string): void {
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!DATE_RE.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw fail({
      message: field + " must be a valid calendar date.", code: "pledge_date_invalid",
      remedy: "Enter a valid YYYY-MM-DD date for " + field + ".", field,
    });
  }
}
function reason(value: string): string {
  const clean = value.trim();
  if (clean.length < 5 || clean.length > 500) throw fail({
    message: "A reason between 5 and 500 characters is required.", code: "pledge_reason_required",
    remedy: "Enter the business reason for this pledge change.", field: "reason",
  });
  return clean;
}
function money(value: string, field: string): string {
  try { return fromUnits(toUnits(value)); } catch {
    throw fail({
      message: field + " must be a decimal amount with no more than four places.",
      code: "pledge_amount_invalid", remedy: "Enter a valid decimal amount for " + field + ".", field,
    });
  }
}
function monthlyRate(value: string) {
  try {
    const trimmed = value.trim();
    const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (!match || match[1]!.length > 9 || (match[2]?.length ?? 0) > 10) throw new Error("invalid rate");
    return periodRateFromAnnualPercent(trimmed, MONTHS_PER_YEAR);
  } catch {
    throw fail({
      message: "The annual pledge discount rate is invalid or outside the supported range.",
      code: "pledge_discount_rate_invalid",
      remedy: "Enter a non-negative annual percentage below 1,000,000,000 with no more than ten decimal places.",
      field: "discountRate",
    });
  }
}
function monthIndex(value: string): number {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
}
function monthKey(value: string): string { return value.slice(0, 7); }
function monthEnd(month: string): string {
  const parts = month.split("-");
  return new Date(Date.UTC(Number(parts[0]), Number(parts[1]), 0)).toISOString().slice(0, 10);
}
function periodFor(bookedOn: string, dueOn: string): number {
  const period = monthIndex(dueOn) - monthIndex(bookedOn);
  if (dueOn <= bookedOn || period < 0) throw fail({
    message: "Installment due date " + dueOn + " is not after booking date " + bookedOn + ".",
    code: "pledge_due_date_not_future", remedy: "Set each installment due date after the booking date.",
    field: "dueOn",
  });
  return Math.max(1, period);
}
function pow(base: bigint, exponent: number): bigint {
  let out = 1n;
  for (let i = 0; i < exponent; i += 1) out *= base;
  return out;
}
function validateFlows(flows: readonly PledgeCashFlow[], expectedTotal?: string): PledgeCashFlow[] {
  if (flows.length === 0 || flows.length > MAX_MONTHS) throw fail({
    message: "A pledge schedule must contain between one and 1,200 installments.",
    code: "pledge_installments_invalid",
    remedy: "Add a valid installment schedule within the supported 100-year horizon.",
    field: "installments",
  });
  const result = flows.map((flow) => {
    date(flow.dueOn, "dueOn");
    const amount = money(flow.amount, "installment amount");
    if (toUnits(amount) <= 0n) throw fail({
      message: "Each pledge installment must be greater than zero.",
      code: "pledge_installment_nonpositive",
      remedy: "Enter a positive amount for each promised installment.", field: "installments",
    });
    return { dueOn: flow.dueOn, amount };
  });
  for (let i = 1; i < result.length; i += 1) if (result[i]!.dueOn <= result[i - 1]!.dueOn) {
    throw fail({
      message: "Pledge installment dates must be strictly increasing.",
      code: "pledge_installment_dates_invalid",
      remedy: "Order the installment dates and remove duplicate due dates.", field: "installments",
    });
  }
  if (expectedTotal !== undefined) {
    const sum = result.reduce((total, flow) => total + toUnits(flow.amount), 0n);
    if (sum !== toUnits(expectedTotal)) throw fail({
      message: "The installment amounts do not equal the pledge amount.",
      code: "pledge_installment_total_mismatch",
      remedy: "Adjust the installments so they add exactly to the total pledge amount.",
      field: "installments",
    });
  }
  return result;
}

/** Exact PV for uneven dated installments; the common monthly rate comes from the money kernel. */
export function presentValueOfPledgeStream(input: {
  bookedOn: string; discountRate: string; installments: readonly PledgeCashFlow[];
}): string {
  date(input.bookedOn, "bookedOn");
  const flows = validateFlows(input.installments);
  const rate = monthlyRate(input.discountRate);
  const entries = flows.map((flow) => ({ period: periodFor(input.bookedOn, flow.dueOn), units: toUnits(flow.amount) }));
  const periods = Math.max(...entries.map((entry) => entry.period));
  if (periods > MAX_MONTHS) throw fail({
    message: "The pledge schedule exceeds the supported 100-year horizon.",
    code: "pledge_schedule_too_long", remedy: "Use no more than 1,200 monthly periods.",
  });
  if (rate.num === 0n) return fromUnits(entries.reduce((sum, entry) => sum + entry.units, 0n));
  if (entries.length === periods &&
      entries.every((entry, index) => entry.period === index + 1 && entry.units === entries[0]!.units)) {
    return presentValueOfLevelStream({
      payment: fromUnits(entries[0]!.units), periods, rate, timing: "arrears",
    });
  }
  const denominator = rate.den + rate.num;
  const numerator = entries.reduce((sum, entry) =>
    sum + entry.units * pow(rate.den, entry.period) * pow(denominator, periods - entry.period), 0n);
  return fromUnits(roundDiv(numerator, pow(denominator, periods)));
}

/** Readable installment and monthly discount schedule using the stored opening PV. */
export function buildPledgeDiscountSchedule(input: {
  bookedOn: string; presentValue: string; discountRate: string; installments: readonly PledgeCashFlow[];
}): PledgeAmortizationPeriod[] {
  date(input.bookedOn, "bookedOn");
  const flows = validateFlows(input.installments);
  const byPeriod = new Map<number, bigint>();
  for (const flow of flows) {
    const period = periodFor(input.bookedOn, flow.dueOn);
    byPeriod.set(period, (byPeriod.get(period) ?? 0n) + toUnits(flow.amount));
  }
  const periodCount = Math.max(...byPeriod.keys());
  if (periodCount > MAX_MONTHS) throw fail({
    message: "The pledge schedule exceeds the supported 100-year horizon.",
    code: "pledge_schedule_too_long", remedy: "Use no more than 1,200 monthly periods.",
  });
  let opening = toUnits(input.presentValue);
  const face = flows.reduce((sum, flow) => sum + toUnits(flow.amount), 0n);
  if (opening <= 0n || opening > face) throw fail({
    message: "The stored pledge present value is outside its promised amount.",
    status: 409, code: "pledge_present_value_invalid",
    remedy: "Correct the pledge through a controlled reversal and rebooking.",
  });
  const rate = monthlyRate(input.discountRate);
  const out: PledgeAmortizationPeriod[] = [];
  for (let period = 1; period <= periodCount; period += 1) {
    const absoluteMonth = monthIndex(input.bookedOn) + period;
    const year = Math.floor(absoluteMonth / 12);
    const number = absoluteMonth % 12 + 1;
    const month = String(year) + "-" + String(number).padStart(2, "0");
    const payment = byPeriod.get(period) ?? 0n;
    const computedInterest = periodInterest(opening, rate);
    const interest = period === periodCount ? payment - opening : computedInterest;
    const drift = interest - computedInterest;
    const tolerance = BigInt(periodCount) * 100n;
    if (period === periodCount && (interest < 0n || drift > tolerance || -drift > tolerance)) {
      throw fail({
        message: "The pledge schedule cannot accrete its stored present value to the promised collections.",
        code: "pledge_schedule_does_not_close",
        remedy: "Review the installment amounts and discount rate before booking the pledge.",
      });
    }
    const closing = opening + interest - payment;
    if (closing < 0n) throw fail({
      message: "A scheduled installment exceeds the pledge carrying amount.",
      code: "pledge_schedule_overpays", remedy: "Review the installment dates, amounts, and discount rate.",
    });
    out.push({
      period, month, periodEnd: monthEnd(month), openingCarryingAmount: fromUnits(opening),
      discountAmortization: fromUnits(interest), scheduledCollection: fromUnits(payment),
      closingCarryingAmount: fromUnits(closing),
    });
    opening = closing;
  }
  if (opening !== 0n) throw fail({
    message: "The pledge schedule leaves residual carrying amount " + fromUnits(opening) + ".",
    code: "pledge_schedule_does_not_close",
    remedy: "Review the installment amounts and discount rate before booking the pledge.",
  });
  return out;
}

async function audit(input: {
  orgId: string; id: string; action: string; actorId?: string | null;
  before?: Record<string, unknown>; after?: Record<string, unknown>; reason?: string;
}): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'pledges', ${input.id}, ${input.action},
      ${JSON.stringify({
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.after === undefined ? {} : { after: input.after }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })}::jsonb, ${input.actorId ?? null})`);
}
async function installments(orgId: string, pledgeId: string): Promise<InstallmentRow[]> {
  return (await db.execute<InstallmentRow>(sql`
    select id, installment_number, due_on::text as due_on, amount::text as amount
      from pledge_installments
     where org_id = ${orgId} and pledge_id = ${pledgeId}
     order by installment_number, due_on, id`)).rows;
}
async function readPledge(orgId: string, id: string, lock = false): Promise<PledgeRow | null> {
  const result = await db.execute<PledgeRow>(sql`
    select id, pledge_number, subsidiary_id, donor_party_id, fund_id,
           total_amount::text as total_amount, discount_rate::text as discount_rate,
           present_value::text as present_value, allowance_amount::text as allowance_amount,
           status, booked_on::text as booked_on, booking_entry_id
      from pledges where org_id = ${orgId} and id = ${id}
      ${sql.raw(lock ? "for update" : "")}`);
  return result.rows[0] ?? null;
}
async function activity(orgId: string, pledgeId: string, asOfDate?: string): Promise<Activity> {
  const rows = (await db.execute<{ posting_date: string; custom: Record<string, unknown> | null }>(sql`
    select posting_date::text as posting_date, custom from journal_entries
     where org_id = ${orgId} and origin = 'pledge' and status = 'posted'
       and custom #>> '{nonprofitPledge,pledgeId}' = ${pledgeId}
       and (${asOfDate ?? null}::date is null or posting_date <= ${asOfDate ?? null}::date)
     order by posting_date, id`)).rows;
  const out: Activity = {
    collected: new Map(), writtenOff: new Map(), collectionsByMonth: new Map(),
    amortizedByMonth: new Map(), amortizedMonths: new Set(), totalCollected: 0n,
    totalWrittenOff: 0n, totalAllowanceTopUp: 0n,
  };
  for (const row of rows) {
    const marker = row.custom?.[MARKER] as Marker | undefined;
    if (marker?.operation === "collection") for (const item of marker.allocations ?? []) {
      if (!item.installmentId || !item.amount) continue;
      const value = toUnits(item.amount);
      out.collected.set(item.installmentId, (out.collected.get(item.installmentId) ?? 0n) + value);
      out.totalCollected += value;
      const key = monthKey(row.posting_date);
      out.collectionsByMonth.set(key, (out.collectionsByMonth.get(key) ?? 0n) + value);
    }
    if (marker?.operation === "write_off") for (const item of marker.allocations ?? []) {
      if (!item.installmentId || !item.amount) continue;
      const value = toUnits(item.amount);
      out.writtenOff.set(item.installmentId, (out.writtenOff.get(item.installmentId) ?? 0n) + value);
      out.totalWrittenOff += value;
    }
    if (marker?.operation === "discount_amortization" && marker.month && marker.amount) {
      const value = toUnits(marker.amount);
      out.amortizedMonths.add(marker.month);
      out.amortizedByMonth.set(marker.month, (out.amortizedByMonth.get(marker.month) ?? 0n) + value);
    }
    if (marker?.operation === "allowance_top_up" && marker.amount) {
      out.totalAllowanceTopUp += toUnits(marker.amount);
    }
  }
  return out;
}
async function postPledge(input: {
  orgId: string; pledge: PledgeRow; postingDate: string; preferred: string; memo: string;
  lines: { accountId: string; amount: string }[]; actorId?: string | null;
  custom?: Record<string, unknown>; idempotencyKey?: string; auditChanges?: Record<string, unknown>;
}) {
  const period = await resolveCoveringPeriod(db, input.orgId, input.postingDate);
  if (!period) throw fail({
    message: "No open accounting period covers " + input.postingDate + ".",
    status: 409, code: "pledge_period_unavailable", remedy: "Open the GL period covering the posting date.",
  });
  const book = (await db.execute<{ id: string; currency: string }>(sql`
    select b.id, s.base_currency as currency
      from accounting_books b join subsidiaries s
        on s.org_id = b.org_id and s.id = ${input.pledge.subsidiary_id}
     where b.org_id = ${input.orgId} and b.is_primary and b.is_active and b.posts_gl limit 1`)).rows[0];
  if (!book) throw fail({
    message: "The pledge's subsidiary has no active primary GL book.",
    status: 409, code: "pledge_book_unavailable",
    remedy: "Configure an active primary GL book and subsidiary currency.",
  });
  const entryNumber = await nextFreeEntryNumber(
    db as unknown as EntryNumberTx, input.orgId, input.preferred,
  );
  return postEntry(db, {
    orgId: input.orgId, bookId: book.id, subsidiaryId: input.pledge.subsidiary_id,
    entryNumber, postingDate: input.postingDate, periodId: period.id, memo: input.memo,
    origin: "pledge", actorId: input.actorId, custom: input.custom,
    idempotencyKey: input.idempotencyKey, auditAction: "post", auditChanges: input.auditChanges,
    lines: input.lines.map((line) => ({
      accountId: line.accountId, amount: line.amount, currency: book.currency,
      extraDims: { fund: input.pledge.fund_id },
    })),
  });
}

export async function createPledge(input: CreatePledgeInput): Promise<{
  id: string; pledgeNumber: string; status: "draft"; totalAmount: string; installmentCount: number;
}> {
  for (const [field, value] of Object.entries({
    orgId: input.orgId, subsidiaryId: input.subsidiaryId, donorPartyId: input.donorPartyId, fundId: input.fundId,
  })) uuid(value, field);
  const totalAmount = money(input.totalAmount, "totalAmount");
  const why = reason(input.reason);
  if (toUnits(totalAmount) <= 0n) throw fail({
    message: "A pledge amount must be greater than zero.", code: "pledge_amount_nonpositive",
    remedy: "Enter a positive promised amount.", field: "totalAmount",
  });
  const discountRate = input.discountRate.trim();
  monthlyRate(discountRate);
  if (toUnits(totalAmount) > MAX_NUMERIC_19_4_UNITS) throw fail({
    message: "The pledge amount exceeds the supported ledger precision.",
    code: "pledge_amount_out_of_range",
    remedy: "Enter a total pledge amount within the supported 19-digit ledger range.",
    field: "totalAmount",
  });
  const flows = validateFlows(input.installments, totalAmount);
  if (input.custom !== undefined && (
    input.custom === null || typeof input.custom !== "object" || Array.isArray(input.custom)
  )) throw fail({
    message: "Custom pledge data must be an object.", code: "pledge_custom_invalid",
    remedy: "Provide custom pledge fields as a JSON object.", field: "custom",
  });
  return withOrgTransaction(input.orgId, async () => {
    await lockFeature(input.orgId);
    const refs = await db.execute<{ id: string }>(sql`
      select p.id from parties p
      join funds f on f.org_id = p.org_id
      join subsidiaries s on s.org_id = p.org_id
       where p.org_id = ${input.orgId} and p.id = ${input.donorPartyId}
         and f.id = ${input.fundId} and s.id = ${input.subsidiaryId}
         and exists (
           select 1 from segment_values sv
           join segment_definitions sd on sd.org_id = sv.org_id and sd.id = sv.segment_id
            where sv.org_id = f.org_id and sv.id = f.id and sv.is_active
              and sd.key = 'fund' and sd.source_kind = 'custom')`);
    if (refs.rows.length !== 1) throw fail({
      message: "The donor, fund, or subsidiary is not an active record in this organization.",
      code: "pledge_reference_not_found",
      remedy: "Choose an active donor, fund, and subsidiary from this organization.",
    });
    const pledgeNumber = await allocateDocumentNumber(db, input.orgId, "pledge", "PLG-");
    const inserted = await db.execute<{ id: string }>(sql`
      insert into pledges
        (org_id, subsidiary_id, pledge_number, donor_party_id, fund_id, total_amount,
         discount_rate, status, custom, created_by, updated_by)
      values (${input.orgId}, ${input.subsidiaryId}, ${pledgeNumber}, ${input.donorPartyId},
        ${input.fundId}, ${totalAmount}, ${discountRate}, 'draft',
        ${JSON.stringify(input.custom ?? {})}::jsonb, ${input.actorId ?? null}, ${input.actorId ?? null})
      returning id`);
    const id = inserted.rows[0]?.id;
    if (!id) throw fail({
      message: "The pledge record was not created.", status: 409, code: "pledge_write_missing",
      remedy: "Retry the pledge after checking the organization and accounting references.",
    });
    for (let index = 0; index < flows.length; index += 1) {
      const flow = flows[index]!;
      const row = await db.execute<{ id: string }>(sql`
        insert into pledge_installments
          (org_id, pledge_id, installment_number, due_on, amount, created_by)
        values (${input.orgId}, ${id}, ${index + 1}, ${flow.dueOn}, ${flow.amount}, ${input.actorId ?? null})
        returning id`);
      if (row.rows.length !== 1) throw fail({
        message: "Pledge installment " + (index + 1) + " was not created.",
        status: 409, code: "pledge_installment_write_missing",
        remedy: "Retry the pledge after checking the installment schedule.",
      });
    }
    await audit({
      orgId: input.orgId, id, action: "create", actorId: input.actorId,
      after: {
        pledgeNumber, subsidiaryId: input.subsidiaryId, donorPartyId: input.donorPartyId,
        fundId: input.fundId, totalAmount, discountRate, installmentCount: flows.length, status: "draft",
      },
      reason: why,
    });
    return { id, pledgeNumber, status: "draft", totalAmount, installmentCount: flows.length };
  });
}

export async function bookPledge(input: {
  orgId: string; pledgeId: string; postingDate: string; receivableAccountId: string;
  discountAccountId: string; contributionsAccountId: string; reason: string; actorId?: string | null;
}): Promise<{ entryId: string; presentValue: string; discount: string }> {
  uuid(input.pledgeId, "pledgeId");
  for (const [field, value] of Object.entries({
    receivableAccountId: input.receivableAccountId,
    discountAccountId: input.discountAccountId, contributionsAccountId: input.contributionsAccountId,
  })) uuid(value, field);
  date(input.postingDate, "postingDate");
  const why = reason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    await lockFeature(input.orgId);
    const pledge = await readPledge(input.orgId, input.pledgeId, true);
    if (!pledge) throw fail({
      message: "The pledge does not exist in this organization.", status: 409,
      code: "pledge_not_found", remedy: "Choose a pledge from this organization.",
    });
    if (pledge.status !== "draft") throw fail({
      message: "Pledge " + pledge.pledge_number + " is " + pledge.status + " and cannot be booked.",
      status: 409, code: "pledge_state_conflict",
      remedy: "Book only a draft pledge; use the journal correction workflow for posted history.",
    });
    const rows = await installments(input.orgId, pledge.id);
    const flows = validateFlows(rows.map((row) => ({ dueOn: row.due_on, amount: row.amount })), pledge.total_amount);
    const pv = presentValueOfPledgeStream({
      bookedOn: input.postingDate, discountRate: pledge.discount_rate, installments: flows,
    });
    if (toUnits(pv) <= 0n) throw fail({
      message: "The pledge present value rounds below the smallest supported ledger amount.",
      code: "pledge_present_value_below_precision",
      remedy: "Review the discount rate and installment amounts so the present value is at least 0.0001.",
    });
    const discountUnits = toUnits(pledge.total_amount) - toUnits(pv);
    if (discountUnits < 0n) throw fail({
      message: "The pledge present value exceeds its promised amount.",
      code: "pledge_present_value_exceeds_face",
      remedy: "Review the discount rate and promised installments before booking.",
    });
    const discount = fromUnits(discountUnits);
    const posted = await postPledge({
      orgId: input.orgId, pledge, postingDate: input.postingDate,
      preferred: pledge.pledge_number + "-BOOK", memo: "Book pledge " + pledge.pledge_number,
      actorId: input.actorId,
      auditChanges: { pledgeId: pledge.id, presentValue: pv, discount, reason: why },
      lines: [
        { accountId: input.receivableAccountId, amount: pledge.total_amount },
        ...(discountUnits === 0n ? [] : [{
          accountId: input.discountAccountId, amount: fromUnits(-discountUnits),
        }]),
        { accountId: input.contributionsAccountId, amount: fromUnits(-toUnits(pv)) },
      ],
    });
    const updated = (await db.execute<{ id: string }>(sql`
      update pledges set present_value = ${pv}, booked_on = ${input.postingDate},
        booking_entry_id = ${posted.entryId}, status = 'booked',
        updated_at = now(), updated_by = ${input.actorId ?? null}
       where org_id = ${input.orgId} and id = ${pledge.id} and status = 'draft'
      returning id`)).rows[0];
    if (!updated) throw fail({
      message: "Pledge " + pledge.pledge_number + " changed before booking could be recorded.",
      status: 409, code: "pledge_booking_write_missing", remedy: "Refresh the pledge and retry booking.",
    });
    await audit({
      orgId: input.orgId, id: pledge.id, action: "book", actorId: input.actorId,
      before: { status: "draft", presentValue: null, bookingEntryId: null },
      after: { status: "booked", presentValue: pv, bookingEntryId: posted.entryId }, reason: why,
    });
    return { entryId: posted.entryId, presentValue: pv, discount };
  });
}

export async function topUpPledgeAllowance(input: {
  orgId: string; pledgeId: string; amount: string; postingDate: string;
  contributionsAccountId: string; allowanceAccountId: string; reason: string; actorId?: string | null;
}): Promise<{ entryId: string; allowanceBalance: string }> {
  uuid(input.pledgeId, "pledgeId");
  uuid(input.contributionsAccountId, "contributionsAccountId");
  uuid(input.allowanceAccountId, "allowanceAccountId");
  date(input.postingDate, "postingDate");
  const amount = money(input.amount, "amount");
  if (toUnits(amount) <= 0n) throw fail({
    message: "An allowance top-up must be greater than zero.", code: "pledge_allowance_nonpositive",
    remedy: "Enter a positive allowance top-up amount.", field: "amount",
  });
  const why = reason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    await lockFeature(input.orgId);
    const pledge = await readPledge(input.orgId, input.pledgeId, true);
    if (!pledge || !pledge.booking_entry_id || !["booked", "collecting"].includes(pledge.status)) {
      throw fail({
        message: "Only a booked or collecting pledge can receive an allowance top-up.",
        status: 409, code: "pledge_state_conflict", remedy: "Book the pledge before topping up its allowance.",
      });
    }
    const current = await activity(input.orgId, pledge.id);
    const outstanding = toUnits(pledge.total_amount) - current.totalCollected - current.totalWrittenOff;
    const next = toUnits(pledge.allowance_amount) + toUnits(amount);
    if (next > outstanding) throw fail({
      message: "The allowance top-up exceeds the outstanding pledge balance of " + fromUnits(outstanding) + ".",
      code: "pledge_allowance_exceeds_outstanding",
      remedy: "Limit the allowance to the remaining uncollected pledge balance.", field: "amount",
    });
    const posted = await postPledge({
      orgId: input.orgId, pledge, postingDate: input.postingDate,
      preferred: pledge.pledge_number + "-ALLOWANCE", memo: "Allowance top-up for " + pledge.pledge_number,
      actorId: input.actorId,
      custom: { [MARKER]: { pledgeId: pledge.id, operation: "allowance_top_up", amount } },
      auditChanges: { pledgeId: pledge.id, amount, reason: why },
      lines: [
        { accountId: input.contributionsAccountId, amount },
        { accountId: input.allowanceAccountId, amount: fromUnits(-toUnits(amount)) },
      ],
    });
    const balance = fromUnits(next);
    const updated = (await db.execute<{ id: string }>(sql`
      update pledges set allowance_amount = ${balance}, updated_at = now(), updated_by = ${input.actorId ?? null}
       where org_id = ${input.orgId} and id = ${pledge.id} and allowance_amount = ${pledge.allowance_amount}
      returning id`)).rows[0];
    if (!updated) throw fail({
      message: "Pledge allowance changed before the top-up could be recorded.",
      status: 409, code: "pledge_allowance_write_missing",
      remedy: "Refresh the pledge and retry the allowance top-up.",
    });
    await audit({
      orgId: input.orgId, id: pledge.id, action: "allowance_top_up", actorId: input.actorId,
      before: { allowanceAmount: pledge.allowance_amount },
      after: { allowanceAmount: balance, entryId: posted.entryId }, reason: why,
    });
    return { entryId: posted.entryId, allowanceBalance: balance };
  });
}

export async function writeOffPledge(input: {
  orgId: string; pledgeId: string; amount: string; postingDate: string;
  receivableAccountId: string; allowanceAccountId: string; reason: string; actorId?: string | null;
}): Promise<{ entryId: string; allowanceBalance: string; status: string }> {
  uuid(input.pledgeId, "pledgeId");
  uuid(input.receivableAccountId, "receivableAccountId");
  uuid(input.allowanceAccountId, "allowanceAccountId");
  date(input.postingDate, "postingDate");
  const amount = money(input.amount, "amount");
  if (toUnits(amount) <= 0n) throw fail({
    message: "A pledge write-off must be greater than zero.", code: "pledge_writeoff_nonpositive",
    remedy: "Enter a positive amount to write off.", field: "amount",
  });
  const why = reason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    await lockFeature(input.orgId);
    const pledge = await readPledge(input.orgId, input.pledgeId, true);
    if (!pledge || !pledge.booking_entry_id || !["booked", "collecting"].includes(pledge.status)) {
      throw fail({
        message: "Only a booked or collecting pledge can be written off.",
        status: 409, code: "pledge_state_conflict", remedy: "Book the pledge before recording a write-off.",
      });
    }
    const current = await activity(input.orgId, pledge.id);
    const outstanding = toUnits(pledge.total_amount) - current.totalCollected - current.totalWrittenOff;
    if (toUnits(amount) > toUnits(pledge.allowance_amount)) throw fail({
      message: "Pledge " + pledge.pledge_number + " has an allowance balance of " +
        pledge.allowance_amount + ", below the requested write-off of " + amount + ".",
      code: "pledge_writeoff_exceeds_allowance",
      remedy: "Post an allowance top-up for the pledge before writing it off.",
    });
    if (toUnits(amount) > outstanding) throw fail({
      message: "The write-off exceeds the outstanding pledge balance of " + fromUnits(outstanding) + ".",
      code: "pledge_writeoff_exceeds_outstanding",
      remedy: "Reduce the write-off to the remaining uncollected pledge balance.",
    });
    let rest = toUnits(amount);
    const allocations: { installmentId: string; amount: string }[] = [];
    for (const row of await installments(input.orgId, pledge.id)) {
      const due = toUnits(row.amount) - (current.collected.get(row.id) ?? 0n) - (current.writtenOff.get(row.id) ?? 0n);
      if (due <= 0n || rest <= 0n) continue;
      const used = due < rest ? due : rest;
      allocations.push({ installmentId: row.id, amount: fromUnits(used) });
      rest -= used;
    }
    if (rest !== 0n) throw fail({
      message: "The pledge schedule does not contain enough remaining installments.",
      status: 409, code: "pledge_schedule_balance_mismatch",
      remedy: "Refresh the pledge schedule before recording the write-off.",
    });
    const nextAllowance = fromUnits(toUnits(pledge.allowance_amount) - toUnits(amount));
    const nextStatus = toUnits(amount) === outstanding ? "written_off" : pledge.status;
    const posted = await postPledge({
      orgId: input.orgId, pledge, postingDate: input.postingDate,
      preferred: pledge.pledge_number + "-WRITEOFF", memo: "Write off pledge " + pledge.pledge_number,
      actorId: input.actorId,
      custom: { [MARKER]: { pledgeId: pledge.id, operation: "write_off", amount, allocations } },
      auditChanges: { pledgeId: pledge.id, amount, allowanceBalance: nextAllowance, reason: why },
      lines: [
        { accountId: input.allowanceAccountId, amount },
        { accountId: input.receivableAccountId, amount: fromUnits(-toUnits(amount)) },
      ],
    });
    const updated = (await db.execute<{ id: string }>(sql`
      update pledges set allowance_amount = ${nextAllowance}, status = ${nextStatus},
        updated_at = now(), updated_by = ${input.actorId ?? null}
       where org_id = ${input.orgId} and id = ${pledge.id} and status = ${pledge.status}
         and allowance_amount = ${pledge.allowance_amount}
      returning id`)).rows[0];
    if (!updated) throw fail({
      message: "Pledge changed before its write-off could be recorded.",
      status: 409, code: "pledge_writeoff_write_missing", remedy: "Refresh the pledge and retry the write-off.",
    });
    await audit({
      orgId: input.orgId, id: pledge.id, action: "write_off", actorId: input.actorId,
      before: { status: pledge.status, allowanceAmount: pledge.allowance_amount },
      after: { status: nextStatus, allowanceAmount: nextAllowance, entryId: posted.entryId }, reason: why,
    });
    return { entryId: posted.entryId, allowanceBalance: nextAllowance, status: nextStatus };
  });
}

export async function collectPledgeInstallments(input: {
  orgId: string; pledgeId: string; allocations: readonly { installmentId: string; amount: string }[];
  postingDate: string; bankAccountId: string; receivableAccountId: string;
  idempotencyKey: string; reason: string; actorId?: string | null;
}): Promise<{ entryId: string; status: string; collectedAmount: string }> {
  uuid(input.pledgeId, "pledgeId");
  uuid(input.bankAccountId, "bankAccountId");
  uuid(input.receivableAccountId, "receivableAccountId");
  date(input.postingDate, "postingDate");
  if (!input.idempotencyKey.trim()) throw fail({
    message: "A collection idempotency key is required.", code: "pledge_collection_key_required",
    remedy: "Retry with the request's stable idempotency key.", field: "idempotencyKey",
  });
  if (!input.allocations.length) throw fail({
    message: "A pledge collection must allocate its amount to an installment.",
    code: "pledge_collection_allocations_required",
    remedy: "Select the installment amounts covered by this receipt.", field: "allocations",
  });
  const why = reason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    await lockFeature(input.orgId);
    const pledge = await readPledge(input.orgId, input.pledgeId, true);
    if (!pledge || !pledge.booking_entry_id || !["booked", "collecting"].includes(pledge.status)) {
      throw fail({
        message: "Only a booked or collecting pledge can receive a collection.",
        status: 409, code: "pledge_state_conflict", remedy: "Book the pledge before recording a collection.",
      });
    }
    const all = await installments(input.orgId, pledge.id);
    const byId = new Map(all.map((row) => [row.id, row]));
    const current = await activity(input.orgId, pledge.id);
    const used = new Set<string>();
    const allocations = input.allocations.map((allocation) => {
      uuid(allocation.installmentId, "installmentId");
      if (used.has(allocation.installmentId)) throw fail({
        message: "A collection cannot allocate twice to the same installment.",
        code: "pledge_duplicate_allocation", remedy: "Combine allocations for each installment.",
        field: "allocations",
      });
      used.add(allocation.installmentId);
      const row = byId.get(allocation.installmentId);
      if (!row) throw fail({
        message: "A collection installment does not belong to this pledge.",
        code: "pledge_installment_not_found", remedy: "Choose an installment from this pledge.",
        field: "allocations",
      });
      const amount = money(allocation.amount, "collection amount");
      const remaining = toUnits(row.amount) - (current.collected.get(row.id) ?? 0n) -
        (current.writtenOff.get(row.id) ?? 0n);
      if (toUnits(amount) <= 0n || toUnits(amount) > remaining) throw fail({
        message: "Collection exceeds installment " + row.installment_number +
          "'s outstanding amount of " + fromUnits(remaining) + ".",
        code: "pledge_collection_exceeds_installment",
        remedy: "Reduce the collection to the installment's remaining balance.", field: "allocations",
      });
      return { installmentId: row.id, amount };
    });
    const collectionTotal = allocations.reduce((sum, row) => sum + toUnits(row.amount), 0n);
    const afterCollected = current.totalCollected + collectionTotal;
    const closed = afterCollected + current.totalWrittenOff === toUnits(pledge.total_amount);
    const nextStatus = closed ? (current.totalWrittenOff > 0n ? "written_off" : "fulfilled") : "collecting";
    const total = fromUnits(collectionTotal);
    const posted = await postPledge({
      orgId: input.orgId, pledge, postingDate: input.postingDate,
      preferred: pledge.pledge_number + "-COLLECT", memo: "Collect pledge " + pledge.pledge_number,
      actorId: input.actorId, idempotencyKey: input.idempotencyKey,
      custom: { [MARKER]: { pledgeId: pledge.id, operation: "collection", amount: total, allocations } },
      auditChanges: { pledgeId: pledge.id, amount: total, reason: why },
      lines: [
        { accountId: input.bankAccountId, amount: total },
        { accountId: input.receivableAccountId, amount: fromUnits(-collectionTotal) },
      ],
    });
    const updated = (await db.execute<{ id: string }>(sql`
      update pledges set status = ${nextStatus}, updated_at = now(), updated_by = ${input.actorId ?? null}
       where org_id = ${input.orgId} and id = ${pledge.id} and status = ${pledge.status}
      returning id`)).rows[0];
    if (!updated) throw fail({
      message: "Pledge changed before its collection could be recorded.",
      status: 409, code: "pledge_collection_write_missing", remedy: "Refresh the pledge and retry collection.",
    });
    await audit({
      orgId: input.orgId, id: pledge.id, action: "collect", actorId: input.actorId,
      before: { status: pledge.status, collectedAmount: fromUnits(current.totalCollected) },
      after: { status: nextStatus, collectedAmount: fromUnits(afterCollected), entryId: posted.entryId },
      reason: why,
    });
    return { entryId: posted.entryId, status: nextStatus, collectedAmount: total };
  });
}

async function reverseBooking(input: {
  orgId: string; pledge: PledgeRow; entryId: string; reversalDate: string; reason: string; actorId?: string | null;
}): Promise<string> {
  const source = (await db.execute<{
    id: string; book_id: string; subsidiary_id: string; entry_number: string; status: string;
  }>(sql`
    select id, book_id, subsidiary_id, entry_number, status from journal_entries
     where org_id = ${input.orgId} and id = ${input.entryId} for update`)).rows[0];
  if (!source || source.status !== "posted") throw fail({
    message: "Pledge " + input.pledge.pledge_number + "'s booking entry is not posted.",
    status: 409, code: "pledge_booking_not_reversible", remedy: "Use the journal correction workflow.",
  });
  const period = await resolveCoveringPeriod(db, input.orgId, input.reversalDate);
  if (!period) throw fail({
    message: "No open accounting period covers " + input.reversalDate + ".",
    status: 409, code: "pledge_period_unavailable", remedy: "Open the GL period covering the cancellation date.",
  });
  const sourceLines = await db.select().from(schema.journalLines)
    .where(sql`org_id = ${input.orgId} and entry_id = ${source.id}`)
    .orderBy(schema.journalLines.lineNumber);
  if (!sourceLines.length) throw fail({
    message: "Pledge " + input.pledge.pledge_number + "'s booking entry has no journal lines.",
    status: 409, code: "pledge_booking_lines_missing", remedy: "Inspect the booking entry before cancellation.",
  });
  const mirror = reversalJournalLines(sourceLines, { entryId: "", orgId: input.orgId });
  const reversed = await postEntry(db, {
    orgId: input.orgId, bookId: source.book_id, subsidiaryId: source.subsidiary_id,
    entryNumber: await nextFreeEntryNumber(db as unknown as EntryNumberTx, input.orgId, source.entry_number + "-REV"),
    postingDate: input.reversalDate, periodId: period.id,
    memo: "Cancel pledge " + input.pledge.pledge_number + ": " + input.reason,
    origin: "pledge", reversesEntryId: source.id, actorId: input.actorId,
    auditAction: "reverse",
    auditChanges: { mode: "pledge_cancellation", pledgeId: input.pledge.id, reason: input.reason },
    lines: mirror.map((line) => ({
      accountId: line.accountId, subsidiaryId: line.subsidiaryId, amount: line.amount,
      currency: line.currency, txnAmount: line.txnAmount, fxRate: line.fxRate, memo: line.memo,
      partyId: line.partyId, departmentId: line.departmentId, projectId: line.projectId,
      locationId: line.locationId, classId: line.classId, extraDims: (line.extraDims ?? {}) as Record<string, unknown>,
      custom: (line.custom ?? {}) as Record<string, unknown>, lineNumber: line.lineNumber,
    })),
  });
  await markEntryReversed(db, { orgId: input.orgId, entryId: source.id, actorId: input.actorId });
  return reversed.entryId;
}

export async function cancelPledge(input: {
  orgId: string; pledgeId: string; reversalDate: string; reason: string; actorId?: string | null;
}): Promise<{ reversalEntryId: string; status: "cancelled" }> {
  uuid(input.pledgeId, "pledgeId");
  date(input.reversalDate, "reversalDate");
  const why = reason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    await lockFeature(input.orgId);
    const pledge = await readPledge(input.orgId, input.pledgeId, true);
    if (!pledge || !pledge.booking_entry_id) throw fail({
      message: "The pledge does not exist as a booked record in this organization.",
      status: 409, code: "pledge_state_conflict",
      remedy: "Choose a booked pledge from this organization.",
    });
    if (pledge.status !== "booked") throw fail({
      message: "Pledge " + pledge.pledge_number + " is " + pledge.status + " and cannot be cancelled.",
      status: 409, code: "pledge_state_conflict",
      remedy: "Continue the pledge through the collection and allowance workflows.",
    });
    const current = await activity(input.orgId, pledge.id);
    if (
      current.totalCollected > 0n || current.totalWrittenOff > 0n ||
      current.totalAllowanceTopUp > 0n || current.amortizedByMonth.size > 0
    ) throw fail({
      message: "Pledge " + pledge.pledge_number + " has posted activity and cannot be cancelled.",
      status: 409, code: "pledge_activity_prevents_cancellation",
      remedy: "Continue through the collection and allowance workflows, or reverse the posted entries through the journal correction workflow.",
    });
    const reversalEntryId = await reverseBooking({
      orgId: input.orgId, pledge, entryId: pledge.booking_entry_id,
      reversalDate: input.reversalDate, reason: why, actorId: input.actorId,
    });
    const updated = (await db.execute<{ id: string }>(sql`
      update pledges set status = 'cancelled', updated_at = now(), updated_by = ${input.actorId ?? null}
       where org_id = ${input.orgId} and id = ${pledge.id} and status = 'booked'
      returning id`)).rows[0];
    if (!updated) throw fail({
      message: "Pledge changed before cancellation could be recorded.",
      status: 409, code: "pledge_cancel_write_missing", remedy: "Refresh the pledge and retry cancellation.",
    });
    await audit({
      orgId: input.orgId, id: pledge.id, action: "cancel", actorId: input.actorId,
      before: { status: "booked", bookingEntryId: pledge.booking_entry_id },
      after: { status: "cancelled", reversalEntryId }, reason: why,
    });
    return { reversalEntryId, status: "cancelled" };
  });
}

export async function getPledgeSchedule(input: {
  orgId: string; pledgeId: string; asOfDate: string;
}): Promise<PledgeSchedule> {
  uuid(input.pledgeId, "pledgeId");
  date(input.asOfDate, "asOfDate");
  return withOrgContext(input.orgId, async () => {
    if (!(await orgFeatureEnabled(input.orgId, FEATURE, db))) throw featureOff();
    const pledge = await readPledge(input.orgId, input.pledgeId);
    if (!pledge?.present_value || !pledge.booked_on) throw fail({
      message: "A draft pledge has no booked amortization schedule.",
      status: 409, code: "pledge_schedule_not_booked", remedy: "Book the pledge before viewing its schedule.",
    });
    const rows = await installments(input.orgId, pledge.id);
    const current = await activity(input.orgId, pledge.id, input.asOfDate);
    const flows = rows.map((row) => ({ dueOn: row.due_on, amount: row.amount }));
    return {
      pledgeId: pledge.id, pledgeNumber: pledge.pledge_number, status: pledge.status,
      bookedOn: pledge.booked_on, totalAmount: pledge.total_amount, presentValue: pledge.present_value,
      discountRate: pledge.discount_rate,
      installments: rows.map((row): PledgeScheduleInstallment => {
        const collected = current.collected.get(row.id) ?? 0n;
        const writtenOff = current.writtenOff.get(row.id) ?? 0n;
        const remaining = toUnits(row.amount) - collected - writtenOff;
        const status = remaining === 0n && writtenOff > 0n ? "written_off" :
          writtenOff > 0n ? "partially_written_off" :
          collected >= toUnits(row.amount) ? "collected" :
          collected > 0n ? "partially_collected" : row.due_on < input.asOfDate ? "overdue" : "open";
        return {
          id: row.id, installmentNumber: row.installment_number, dueOn: row.due_on, amount: row.amount,
          collectedAmount: fromUnits(collected), writtenOffAmount: fromUnits(writtenOff),
          outstandingAmount: fromUnits(remaining), status,
        };
      }),
      amortization: buildPledgeDiscountSchedule({
        bookedOn: pledge.booked_on, presentValue: pledge.present_value,
        discountRate: pledge.discount_rate, installments: flows,
      }),
    };
  });
}

export async function runPledgeDiscountAmortization(input: {
  orgId: string; periodEnd: string; discountAccountId: string;
  contributionsAccountId: string; actorId?: string | null;
}): Promise<{ posted: number; skipped: number; reason?: string }> {
  date(input.periodEnd, "periodEnd");
  uuid(input.discountAccountId, "discountAccountId");
  uuid(input.contributionsAccountId, "contributionsAccountId");
  if (!(await orgFeatureEnabled(input.orgId, FEATURE, db))) {
    return { posted: 0, skipped: 0, reason: "pledges is disabled in Company Settings → Features" };
  }
  return withOrgTransaction(input.orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, input.orgId, FEATURE))) {
      return { posted: 0, skipped: 0, reason: "pledges is disabled in Company Settings → Features" };
    }
    const rows = (await db.execute<PledgeRow>(sql`
      select id, pledge_number, subsidiary_id, donor_party_id, fund_id,
        total_amount::text as total_amount, discount_rate::text as discount_rate,
        present_value::text as present_value, allowance_amount::text as allowance_amount,
        status, booked_on::text as booked_on, booking_entry_id
       from pledges where org_id = ${input.orgId}
         and status in ('booked', 'collecting', 'fulfilled', 'written_off')
         and booked_on < ${input.periodEnd}
       order by booked_on, id`)).rows;
    let posted = 0;
    let skipped = 0;
    const month = monthKey(input.periodEnd);
    for (const pledge of rows) {
      const current = await activity(input.orgId, pledge.id, input.periodEnd);
      if (current.amortizedMonths.has(month)) { skipped += 1; continue; }
      const months = monthIndex(input.periodEnd) - monthIndex(pledge.booked_on!);
      if (months < 1 || months > MAX_MONTHS) { skipped += 1; continue; }
      let carrying = toUnits(pledge.present_value ?? "0");
      for (const [key, amount] of current.amortizedByMonth) {
        if (key <= month) carrying += amount;
      }
      for (const [key, amount] of current.collectionsByMonth) {
        if (key < month) carrying -= amount;
      }
      if (carrying <= 0n) { skipped += 1; continue; }
      const rate = monthlyRate(pledge.discount_rate);
      let amount = periodInterest(carrying, rate);
      const installmentRows = await installments(input.orgId, pledge.id);
      const finalDueMonth = installmentRows.at(-1)?.due_on.slice(0, 7);
      if (
        finalDueMonth === month &&
        current.totalCollected + current.totalWrittenOff >= toUnits(pledge.total_amount)
      ) {
        const accruedBefore = [...current.amortizedByMonth.entries()]
          .filter(([key]) => key < month).reduce((sum, [, value]) => sum + value, 0n);
        const closing = current.totalCollected + current.totalWrittenOff -
          toUnits(pledge.present_value ?? "0") - accruedBefore;
        if (closing >= 0n) amount = closing;
      }
      if (amount <= 0n) { skipped += 1; continue; }
      const result = await postPledge({
        orgId: input.orgId, pledge, postingDate: input.periodEnd,
        preferred: pledge.pledge_number + "-AMORT-" + month.replace("-", ""),
        memo: "Pledge discount amortization " + pledge.pledge_number + " " + month,
        actorId: input.actorId, idempotencyKey: "pledge-discount:" + pledge.id + ":" + month,
        custom: { [MARKER]: {
          pledgeId: pledge.id, operation: "discount_amortization", month, amount: fromUnits(amount),
        } },
        auditChanges: { pledgeId: pledge.id, month, amount: fromUnits(amount) },
        lines: [
          { accountId: input.discountAccountId, amount: fromUnits(amount) },
          { accountId: input.contributionsAccountId, amount: fromUnits(-amount) },
        ],
      });
      if (!result.entryId) throw fail({
        message: "Pledge " + pledge.pledge_number + " discount amortization did not post.",
        status: 409, code: "pledge_amortization_write_missing",
        remedy: "Retry the amortization after checking the posting period.",
      });
      posted += 1;
    }
    return { posted, skipped };
  });
}
