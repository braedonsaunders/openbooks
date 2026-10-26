import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { calendarDaysBetween } from "../platform/civil-date.ts";
import { accountingPreferences } from "../organization/accounting-preferences.ts";
import { lookupSpotRateWithEvidence } from "../fx/spot-rate.ts";
import { resolveFxRateAgeLimit } from "../fx/rate-age-policy.ts";
import {
  convertExpenseAtRate,
  convertExpenseFromBilled,
  currencyMinorUnits,
  expenseFxRate,
  type ExpenseLineForeignInput,
  type ExpenseLineFxEvidence,
} from "./expense-line-currency.ts";

/** Where an administrator adds exchange rates; refusals name it as their remedy. */
export const EXCHANGE_RATES_SETUP = "Setup → Exchange rates";
/** Where an administrator records the expense FX policy. */
export const EXPENSE_FX_POLICY_SETUP = "Setup → Expense FX Policies";

export class ExpenseFxRefusal extends Error {
  readonly name = "ExpenseFxRefusal";
  constructor(
    readonly status: 409 | 422,
    readonly code: string,
    message: string,
    readonly remedy: string,
  ) {
    super(message);
  }
}

export type ExpenseFxPolicy = { allowRateOverride: boolean; effectiveFrom: string | null };

/**
 * The expense FX policy version in force on a date. With no version an
 * operator rate is refused: the dated exchange rate or the billed amount
 * converts every line.
 */
export async function expenseFxPolicy(
  runner: SqlExecutor,
  orgId: string,
  onDate: string,
): Promise<ExpenseFxPolicy> {
  const row = (
    await runner.execute<{ allowRateOverride: boolean; effectiveFrom: string }>(
      sql`
    select allow_rate_override as "allowRateOverride", effective_from::text as "effectiveFrom"
      from expense_fx_policies
     where org_id = ${orgId} and effective_from <= ${onDate}::date
     order by effective_from desc
     limit 1
  `,
      "objects",
    )
  )[0];
  return row
    ? { allowRateOverride: row.allowRateOverride === true, effectiveFrom: row.effectiveFrom }
    : { allowRateOverride: false, effectiveFrom: null };
}

async function entityRateType(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string | null,
  onDate: string,
): Promise<string> {
  const entity =
    subsidiaryId ??
    (
      await runner.execute<{ id: string }>(
        sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null order by created_at limit 1
  `,
        "objects",
      )
    )[0]?.id ??
    null;
  if (!entity) {
    throw new ExpenseFxRefusal(
      422,
      "expense_fx_entity_missing",
      "The organization has no legal entity whose rate type converts expense lines.",
      "Create the organization's root subsidiary before converting foreign-currency expenses.",
    );
  }
  return (await accountingPreferences(runner, orgId, entity, onDate)).postingRateType;
}

export type ExpenseFxQuote = {
  from: string;
  to: string;
  rateDate: string;
  rate: string;
  rateType: string;
  source: string;
  observationId: string;
  observationDate: string;
  digest: string;
};

/**
 * The dated exchange rate that converts `from` into the report currency on
 * the expense date: the newest quote of the entity's posting rate type on or
 * before the date, within the organization's rate age limit. A missing or
 * stale rate refuses with where to add one; nothing falls back to par.
 */
export async function quoteExpenseFxRate(
  runner: SqlExecutor,
  input: { orgId: string; subsidiaryId: string | null; from: string; to: string; rateDate: string },
): Promise<ExpenseFxQuote> {
  const rateType = await entityRateType(runner, input.orgId, input.subsidiaryId, input.rateDate);
  const evidence = await lookupSpotRateWithEvidence(
    runner,
    input.orgId,
    input.from,
    input.to,
    input.rateDate,
    rateType,
  );
  const observation = evidence.observations[0];
  const rate = evidence.rate === null ? null : expenseFxRate(evidence.rate);
  if (rate === null || !observation) {
    throw new ExpenseFxRefusal(
      422,
      "expense_fx_rate_missing",
      `No ${rateType} exchange rate converts ${input.from} to ${input.to} on or before ${input.rateDate}.`,
      `Add the ${input.from}→${input.to} rate for ${input.rateDate} in ${EXCHANGE_RATES_SETUP}, or enter the amount billed in ${input.to}.`,
    );
  }
  const limit = await resolveFxRateAgeLimit(runner, input.orgId, "closing", input.rateDate);
  const age = calendarDaysBetween(observation.asOf, input.rateDate);
  if (age > limit.maxAgeDays) {
    throw new ExpenseFxRefusal(
      422,
      "expense_fx_rate_stale",
      `The newest ${input.from}→${input.to} rate on or before ${input.rateDate} is dated ${observation.asOf}, ${age} days old, beyond the ${limit.maxAgeDays}-day rate age limit.`,
      `Add the ${input.from}→${input.to} rate for ${input.rateDate} in ${EXCHANGE_RATES_SETUP}, or enter the amount billed in ${input.to}.`,
    );
  }
  return {
    from: input.from,
    to: input.to,
    rateDate: input.rateDate,
    rate,
    rateType,
    source: observation.source.slice(0, 120) || "fx_rates",
    observationId: observation.id,
    observationDate: observation.asOf,
    digest: evidence.digest,
  };
}

export type ResolvedExpenseLineCurrency = {
  currency: string;
  originalAmount: string;
  originalTaxAmount: string | null;
  rate: string;
  /** Converted line amount in the report currency. */
  amount: string;
  /** Converted tax in the report currency, when the receipt states its tax. */
  taxAmount: string | null;
  evidence: ExpenseLineFxEvidence;
};

/**
 * Convert one foreign-currency expense line into the report currency and
 * build its evidence. Refuses an operator rate the policy does not allow, a
 * dated rate that changed since the operator saw it, and a billed amount
 * that cannot carry an unstated computed tax.
 */
export async function resolveExpenseLineCurrency(
  runner: SqlExecutor,
  input: {
    orgId: string;
    subsidiaryId: string | null;
    reportCurrency: string;
    lineNumber: number;
    foreign: ExpenseLineForeignInput;
    /** The line computes its tax from a tax code in the report currency. */
    computedTax: boolean;
  },
): Promise<ResolvedExpenseLineCurrency> {
  const { foreign } = input;
  const line = `Line ${input.lineNumber}`;
  const minorUnits = currencyMinorUnits(input.reportCurrency);
  if (minorUnits === null) {
    throw new ExpenseFxRefusal(
      422,
      "expense_fx_report_currency",
      `${line}: the report currency ${input.reportCurrency} has no registered minor unit.`,
      "Record the report in an ISO 4217 currency.",
    );
  }
  const base = {
    version: 1 as const,
    fromCurrency: foreign.currency,
    toCurrency: input.reportCurrency,
    rateDate: foreign.rateDate,
    reason: null,
    rateType: null,
    observationId: null,
    observationDate: null,
    digest: null,
    billedAmount: null,
  };
  const original = {
    currency: foreign.currency,
    originalAmount: foreign.amount,
    originalTaxAmount: foreign.taxAmount,
  };

  if (foreign.method === "rate_table") {
    const quote = await quoteExpenseFxRate(runner, {
      orgId: input.orgId,
      subsidiaryId: input.subsidiaryId,
      from: foreign.currency,
      to: input.reportCurrency,
      rateDate: foreign.rateDate,
    });
    if (foreign.rate !== null && foreign.rate !== quote.rate) {
      throw new ExpenseFxRefusal(
        409,
        "expense_fx_rate_changed",
        `${line}: the ${foreign.currency}→${input.reportCurrency} rate for ${foreign.rateDate} is now ${quote.rate}, not the ${foreign.rate} shown when the line was entered.`,
        "Review the converted amount at the current rate and save again.",
      );
    }
    return {
      ...original,
      rate: quote.rate,
      ...convertExpenseAtRate({
        amount: foreign.amount,
        taxAmount: foreign.taxAmount,
        rate: quote.rate,
        minorUnits,
      }),
      evidence: {
        ...base,
        method: "rate_table",
        rate: quote.rate,
        source: quote.source,
        rateType: quote.rateType,
        observationId: quote.observationId,
        observationDate: quote.observationDate,
        digest: quote.digest,
      },
    };
  }

  if (foreign.method === "override") {
    const policy = await expenseFxPolicy(runner, input.orgId, foreign.rateDate);
    if (!policy.allowRateOverride) {
      throw new ExpenseFxRefusal(
        422,
        "expense_fx_override_not_allowed",
        `${line}: the expense FX policy in force on ${foreign.rateDate} does not allow an explicit exchange rate.`,
        `Use the dated exchange rate or the amount billed in ${input.reportCurrency}; an administrator can allow explicit rates in ${EXPENSE_FX_POLICY_SETUP}.`,
      );
    }
    const rate = foreign.rate!;
    return {
      ...original,
      rate,
      ...convertExpenseAtRate({
        amount: foreign.amount,
        taxAmount: foreign.taxAmount,
        rate,
        minorUnits,
      }),
      evidence: { ...base, method: "override", rate, source: "operator", reason: foreign.reason },
    };
  }

  if (input.computedTax && foreign.taxAmount === null) {
    throw new ExpenseFxRefusal(
      422,
      "expense_fx_billed_tax_unstated",
      `${line}: a billed amount converts the whole charge, so the tax inside it must be the tax shown on the receipt.`,
      `Enter the receipt's ${foreign.currency} tax, or remove the line's tax code.`,
    );
  }
  const billed = convertExpenseFromBilled({
    amount: foreign.amount,
    taxAmount: foreign.taxAmount,
    billedAmount: foreign.billedAmount!,
    minorUnits,
  });
  if (!billed) {
    throw new ExpenseFxRefusal(
      422,
      "expense_fx_billed_invalid",
      `${line}: ${foreign.billedAmount} ${input.reportCurrency} billed for ${foreign.amount} ${foreign.currency} does not give a usable exchange rate.`,
      `Enter the ${input.reportCurrency} amount billed for this expense, with the same sign as the ${foreign.currency} amount.`,
    );
  }
  return {
    ...original,
    rate: billed.rate,
    amount: billed.amount,
    taxAmount: billed.taxAmount,
    evidence: {
      ...base,
      method: "billed_amount",
      rate: billed.rate,
      source: "billed_amount",
      billedAmount: foreign.billedAmount,
    },
  };
}
