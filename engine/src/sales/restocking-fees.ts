import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { fromUnits, roundDiv, toUnits } from "../money/money.ts";
import { assertReturnAuthorizationsFeature } from "./returns.ts";

export type RestockingFeeRefusalCode =
  | "feature_disabled"
  | "not_found"
  | "invalid_input"
  | "currency_mismatch"
  | "waive_forbidden"
  | "waive_not_allowed"
  | "waive_reason_required";

/** A restocking fee refusal with the stable detail returned by API routes. */
export class RestockingFeeRefusal extends Error {
  readonly name = "RestockingFeeRefusal";

  constructor(
    message: string,
    readonly code: RestockingFeeRefusalCode,
    readonly status: 404 | 409 | 422,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

function refusal(message: string, code: RestockingFeeRefusalCode, status: 404 | 409 | 422, remedy?: string): RestockingFeeRefusal {
  return new RestockingFeeRefusal(message, code, status, remedy);
}

export type RestockingFeePolicyInput = {
  itemCategory?: string | null;
  itemId?: string | null;
  kind: "percent" | "fixed";
  feePercent?: string | null;
  feeAmountMinor?: bigint | number | string | null;
  currency?: string | null;
  incomeAccountId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  waivable?: boolean | null;
};

/**
 * Pure field validation shared by the setup write hook, so the form refuses
 * the same shapes with the same words as the engine.
 */
export function validateRestockingFeePolicy(input: RestockingFeePolicyInput): void {
  if (input.itemCategory && input.itemId) {
    throw refusal("A fee policy covers an item or a category, not both", "invalid_input", 422, "Clear the item or the category so the scope is one thing");
  }
  if (input.kind !== "percent" && input.kind !== "fixed") {
    throw refusal(`Fee kind ${String(input.kind)} is unknown`, "invalid_input", 422, "Choose a percent or a fixed fee");
  }
  if (input.kind === "percent") {
    const percent = canonicalDecimal(input.feePercent, 4);
    const units = percent === null ? null : toUnits(percent);
    if (units === null || units <= 0n || units > 100_0000n) {
      throw refusal(`Fee percent ${String(input.feePercent)} is not a usable rate`, "invalid_input", 422, "Enter a percent above zero up to 100");
    }
  } else {
    parseMinor(input.feeAmountMinor, "Fee amount");
    if (input.currency !== undefined && input.currency !== null) parseCurrency(input.currency);
  }
  if (typeof input.incomeAccountId !== "string" || input.incomeAccountId.trim() === "") {
    throw refusal("A restocking income account is required", "invalid_input", 422, "Pick the income account that carries restocking fees");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom ?? "")) {
    throw refusal(`Effective date ${String(input.effectiveFrom)} is not a calendar date`, "invalid_input", 422, "Enter the first date the policy charges fees as YYYY-MM-DD");
  }
  if (input.effectiveTo !== undefined && input.effectiveTo !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveTo)) {
      throw refusal(`End date ${String(input.effectiveTo)} is not a calendar date`, "invalid_input", 422, "Enter the last date the policy charges fees as YYYY-MM-DD");
    }
    if (input.effectiveTo < input.effectiveFrom) {
      throw refusal("The policy ends before it starts", "invalid_input", 422, "Set the end date on or after the effective date");
    }
  }
}

function parseMinor(value: unknown, label: string): bigint {
  // Storage minors arrive as bigint, safe-integer JSON numbers, or plain
  // decimal text judged by the shared scale-zero grammar. Fractions and
  // unsafe numbers are refused, never truncated: truncating 1.5 stored 1,
  // a fee nobody typed.
  const text = typeof value === "bigint"
    ? value.toString()
    : typeof value === "number"
      ? (Number.isSafeInteger(value) ? String(value) : "")
      : typeof value === "string"
        ? value.trim()
        : "";
  const exact = text === "" ? null : canonicalDecimal(text, 0);
  if (exact === null || !/^-?\d+$/.test(exact)) {
    throw refusal(`${label} must be a whole number of minor units`, "invalid_input", 422, `Enter ${label.toLowerCase()} as whole minor units`);
  }
  const minor = BigInt(exact);
  if (minor <= 0n) {
    throw refusal(`${label} must be greater than zero`, "invalid_input", 422, `Enter a positive ${label.toLowerCase()}`);
  }
  return minor;
}

function parseCurrency(value: unknown): string {
  const currency = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw refusal(`Currency ${String(value)} is not an ISO code`, "invalid_input", 422, "Enter the three-letter currency code, for example USD");
  }
  return currency;
}

function scopeKey(input: { itemCategory?: string | null; itemId?: string | null }): string {
  if (input.itemId) return `item:${input.itemId}`;
  if (input.itemCategory) return `category:${input.itemCategory}`;
  return "default";
}

function scopeLockKey(orgId: string, scope: string, from: string): string {
  return `openbooks:restocking-policy:${orgId}:${scope}:${from}`;
}

/**
 * Refuse an overlapping open policy in the same scope. Runs on the setup
 * write transaction behind an advisory lock, so two operators cannot open
 * competing policies for the same scope together.
 */
export async function checkRestockingPolicyOverlap(
  runner: SqlExecutor,
  orgId: string,
  input: { itemCategory?: string | null; itemId?: string | null; effectiveFrom: string; effectiveTo?: string | null; ignoreId?: string | null },
): Promise<void> {
  await runner.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scopeLockKey(orgId, scopeKey(input), input.effectiveFrom)}, 0))`);
  const clash = (await runner.execute<{ id: string; effective_from: string; effective_to: string | null }>(sql`
    select id, effective_from::text, effective_to::text
      from restocking_fee_policies
     where org_id = ${orgId}
       and item_id is not distinct from ${input.itemId ?? null}
       and item_category is not distinct from ${input.itemCategory ?? null}
       and (cast(${input.ignoreId ?? null} as uuid) is null or id <> cast(${input.ignoreId ?? null} as uuid))
       and effective_from <= coalesce(${input.effectiveTo ?? null}::date, '9999-12-31'::date)
       and coalesce(effective_to, '9999-12-31'::date) >= ${input.effectiveFrom}::date
     limit 1`)).rows[0];
  if (clash) {
    const until = clash.effective_to ?? "open ended";
    throw refusal(
      `Another fee policy already covers this scope from ${clash.effective_from} to ${until}`,
      "invalid_input",
      422,
      "End the existing policy before this one starts, or edit it instead",
    );
  }
}

type PolicyRow = {
  id: string;
  kind: string;
  fee_percent: string | null;
  fee_amount_minor: string | null;
  currency: string | null;
  income_account_id: string;
  waivable: boolean;
  item_id: string | null;
  item_category: string | null;
};

export type RestockingFeeLineInput = {
  /** Caller key echoed back so credit lines match their fee. */
  key: string;
  itemId: string | null;
  itemCategory: string | null;
  /** Credited line value in minor units of currency. */
  lineTotalMinor: bigint;
};

export type ResolvedRestockingFeeLine = {
  key: string;
  /** Null when the organization has no fee policies: nothing is owed. */
  policyId: string | null;
  policyName: string | null;
  /** item, category, default, or none — the scope that produced the fee. */
  scope: string;
  /** Fee in minor units of currency. Zero when waived or unconfigured. */
  feeMinor: string;
  /** True when a fixed fee exceeded the credited value and was capped. */
  capped: boolean;
  incomeAccountId: string | null;
};

export type ResolveRestockingFeeResult = {
  lines: ResolvedRestockingFeeLine[];
  totalMinor: string;
  /** Fee before any waiver, so the waiver audit records what was forgiven. */
  unwaivedTotalMinor: string;
  currency: string;
  waived: boolean;
};

/**
 * Resolve the restocking fee for inspected return lines. Policies are read
 * effective on the return date; the most specific scope wins
 * (item, then category, then default). A waived return still resolves its
 * policies so the operator sees what was forgiven and why.
 */
export async function resolveRestockingFee(
  runner: SqlExecutor,
  orgId: string,
  input: {
    /** Return date as YYYY-MM-DD: the policy effective that day governs. */
    returnDate: string;
    currency: string;
    lines: RestockingFeeLineInput[];
    waived: boolean;
    waiveReason?: string | null;
    /** True when the operator holds the fee-waiver grant; the route wires
     *  real authorization here. */
    canWaive: boolean;
  },
): Promise<ResolveRestockingFeeResult> {
  await assertReturnAuthorizationsFeature(runner, orgId);
  if (input.waived && !input.canWaive) {
    throw refusal("Waiving a restocking fee needs the fee-waiver grant", "waive_forbidden", 409, "Ask a user with restocking fee waiver authority to waive it, or charge the fee");
  }
  if (input.waived && (input.waiveReason ?? "").trim() === "") {
    throw refusal("A waived restocking fee needs a reason", "waive_reason_required", 422, "Record why the fee is waived");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.returnDate)) {
    throw refusal(`Return date ${input.returnDate} is not a calendar date`, "invalid_input", 422, "Resolve the fee against the return date as YYYY-MM-DD");
  }
  const currency = parseCurrency(input.currency);
  // An organization that never configured fee policies owes no fee: returns
  // keep working. One that did but lapsed every policy fails closed below.
  const configured = await hasAnyPolicy(runner, orgId);
  const lines: ResolvedRestockingFeeLine[] = [];
  let unwaived = 0n;
  for (const line of input.lines) {
    const policy = await findPolicy(runner, orgId, input.returnDate, line);
    if (!policy) {
      if (!configured) {
        lines.push({ key: line.key, policyId: null, policyName: null, scope: "none", feeMinor: "0", capped: false, incomeAccountId: null });
        continue;
      }
      throw refusal("No restocking fee policy covers this return date", "not_found", 404, "Extend a restocking fee policy over the return date, create a default policy in Setup → Inventory → Restocking fees, or waive the fee with a reason");
    }
    // A policy marked not waivable binds even holders of the waiver grant:
    // the grant authorizes waiving a waivable fee, not overriding the policy.
    if (input.waived && !policy.waivable) {
      const scope = policy.item_id !== null ? "item" : policy.item_category !== null ? "category" : "default";
      throw refusal(
        `The ${policyName(policy, scope)} policy does not allow its fee to be waived`,
        "waive_not_allowed",
        409,
        "Charge the fee, or have an administrator allow waivers on the policy in Setup → Inventory → Restocking fees",
      );
    }
    const fee = feeForLine(policy, line, currency, false);
    unwaived += BigInt(fee.feeMinor);
    lines.push(input.waived ? { ...fee, feeMinor: "0", capped: false } : fee);
  }
  const total = lines.reduce((sum, line) => sum + BigInt(line.feeMinor), 0n);
  return { lines, totalMinor: total.toString(), unwaivedTotalMinor: unwaived.toString(), currency, waived: input.waived };
}

async function hasAnyPolicy(runner: SqlExecutor, orgId: string): Promise<boolean> {
  const row = (await runner.execute<{ exists: boolean }>(sql`
    select exists(select 1 from restocking_fee_policies where org_id = ${orgId}) as exists`)).rows[0];
  return row?.exists ?? false;
}

async function findPolicy(
  runner: SqlExecutor,
  orgId: string,
  returnDate: string,
  line: RestockingFeeLineInput,
): Promise<PolicyRow | undefined> {
  // One query, most specific scope first: item, then category, then the
  // default policy. Latest effective start wins within a scope.
  return (await runner.execute<PolicyRow>(sql`
    select id, kind, fee_percent::text, fee_amount_minor::text,
           currency, income_account_id, waivable, item_id, item_category
      from restocking_fee_policies
     where org_id = ${orgId}
       and effective_from <= ${returnDate}::date
       and (effective_to is null or effective_to >= ${returnDate}::date)
       and ((item_id is not null and item_id = ${line.itemId})
            or (item_id is null and item_category is not null and item_category = ${line.itemCategory})
            or (item_id is null and item_category is null))
     order by case when item_id is not null then 0 when item_category is not null then 1 else 2 end,
              effective_from desc
     limit 1`)).rows[0];
}

function feeForLine(policy: PolicyRow, line: RestockingFeeLineInput, currency: string, waived: boolean): ResolvedRestockingFeeLine {
  const scope = policy.item_id !== null ? "item" : policy.item_category !== null ? "category" : "default";
  if (waived) {
    return { key: line.key, policyId: policy.id, policyName: policyName(policy, scope), scope, feeMinor: "0", capped: false, incomeAccountId: policy.income_account_id };
  }
  if (policy.kind === "percent") {
    const fee = roundDiv(line.lineTotalMinor * toUnits(policy.fee_percent!), MICRO_PER_UNIT);
    return { key: line.key, policyId: policy.id, policyName: policyName(policy, scope), scope, feeMinor: fee.toString(), capped: false, incomeAccountId: policy.income_account_id };
  }
  if (policy.currency && policy.currency !== currency) {
    throw refusal(
      `The fee policy is priced in ${policy.currency} but the credit is in ${currency}`,
      "currency_mismatch",
      422,
      "Price the fee policy in the credit currency, or waive the fee with a reason",
    );
  }
  const fixed = BigInt(policy.fee_amount_minor!);
  const capped = fixed > line.lineTotalMinor;
  return {
    key: line.key,
    policyId: policy.id,
    policyName: policyName(policy, scope),
    scope,
    feeMinor: (capped ? line.lineTotalMinor : fixed).toString(),
    capped,
    incomeAccountId: policy.income_account_id,
  };
}

const MICRO_PER_UNIT = 1_000_000n;

function policyName(policy: PolicyRow, scope: string): string {
  const value = policy.kind === "percent" ? `${policy.fee_percent}%` : `fixed ${policy.fee_amount_minor}`;
  return `${value} restocking fee (${scope})`;
}

/**
 * The fee as customer-credit lines: one negative line per fee-bearing return
 * line against the policy's income account. Structurally a document line
 * input (the sales module takes no ledger edge); the caller files these
 * alongside the credit lines it already builds.
 */
export type RestockingFeeCreditLine = {
  accountId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxCodeId: null;
  taxGroupId: null;
  taxOverridden: boolean;
  taxAmount: string;
};

export function restockingFeeCreditLines(resolution: ResolveRestockingFeeResult): RestockingFeeCreditLine[] {
  return resolution.lines
    .filter((line) => BigInt(line.feeMinor) > 0n && line.incomeAccountId)
    .map((line) => {
      // Minor units are cents (the engine prices 2dp currencies); money
      // columns carry four decimals, so a cent share scales up exactly.
      const amount = fromUnits(-BigInt(line.feeMinor) * 100n);
      return {
        accountId: line.incomeAccountId!,
        description: `Restocking fee (${line.policyName})`,
        quantity: "1",
        unitPrice: amount,
        amount,
        taxCodeId: null,
        taxGroupId: null,
        taxOverridden: true,
        taxAmount: "0",
      };
    });
}

/** Audit a fee waiver on the return authorization: actor, timestamp, reason. */
export async function recordRestockingFeeWaiver(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  rmaDocumentId: string,
  input: { totalMinor: string; currency: string; reason: string },
): Promise<void> {
  const result = await runner.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'rma_documents', ${rmaDocumentId}, 'update',
            ${JSON.stringify({ event: "restocking_fee_waived", totalMinor: input.totalMinor, currency: input.currency, reason: input.reason })}::jsonb,
            ${actorId})
    returning id`);
  if (result.rows.length !== 1) throw new Error("restocking fee waiver was not audited");
}
