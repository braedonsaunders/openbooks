import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { normalizeDecimal, roundDiv } from "../money/money.ts";
import { lookupSpotRate } from "../fx/spot-rate.ts";
import { storedValueRefusal } from "./errors.ts";

/**
 * Foreign-currency pricing for stored value. Every stored-value movement
 * records its card-currency amount alongside the functional-currency
 * equivalent and the rate behind it, using the same rate source the
 * document posting kernel uses: a document's own exchange rate for
 * document-driven events, the business-date spot rate for everything else.
 * A missing rate refuses by name — history is never priced at 1.0 silently.
 */

/** Ten decimal places: the storage scale of every fx_rate column. */
const RATE_SCALE = 10n ** 10n;

/** Parse a decimal rate string into exact ten-decimal units. No floats. */
export function parseRateToUnits(rate: string): bigint {
  const raw = String(rate).trim();
  const match = /^\+?(\d+)(?:\.(\d*))?$/.exec(raw);
  if (!match) {
    throw storedValueRefusal({
      message: `Exchange rate ${JSON.stringify(rate)} is not a positive decimal rate.`,
      code: "stored_value_rate_invalid",
      remedy: "Record the rate as a positive decimal (for example 1.36).",
    });
  }
  const fraction = (match[2] ?? "").slice(0, 10).padEnd(10, "0");
  if ((match[2] ?? "").length > 10 && /[1-9]/.test((match[2] ?? "").slice(10))) {
    throw storedValueRefusal({
      message: `Exchange rate ${JSON.stringify(rate)} carries precision beyond ten decimal places.`,
      code: "stored_value_rate_invalid",
      remedy: "Round the rate to ten decimal places.",
    });
  }
  const units = BigInt(match[1]!) * RATE_SCALE + BigInt(fraction);
  if (units <= 0n) {
    throw storedValueRefusal({
      message: "An exchange rate must be greater than zero.",
      code: "stored_value_rate_invalid",
      remedy: "Record the rate as a positive decimal (for example 1.36).",
    });
  }
  return units;
}

/** Render exact ten-decimal rate units back to a decimal rate string. */
export function formatRateUnits(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / RATE_SCALE;
  const fraction = (absolute % RATE_SCALE).toString().padStart(10, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

/** Price card-currency minor units into functional minor units at the rate. Halves away from zero, like the ledger. */
export function functionalMinor(amountMinor: bigint, rateUnits: bigint): bigint {
  return roundDiv(amountMinor * rateUnits, RATE_SCALE);
}

export type DocumentFxContext = {
  id: string;
  currency: string;
  fxRate: string;
  /** The posting entity: the document's own, else the hierarchy root like the kernel. */
  subsidiaryId: string;
  subsidiaryName: string;
  postingDate: string;
};

/**
 * Load one document's currency evidence for a stored-value movement. The
 * row-count check turns an unscoped or raced read into a refusal naming the
 * document instead of silent success.
 */
export async function loadDocumentFxContext(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<DocumentFxContext> {
  const rows = (await runner.execute<{
    id: string;
    currency: string;
    fxRate: string;
    subsidiaryId: string | null;
    subsidiaryName: string | null;
    postingDate: string | null;
    documentDate: string;
    rootId: string | null;
    rootName: string | null;
  }>(sql`
    select d.id, d.currency, d.fx_rate::text as "fxRate",
           d.subsidiary_id as "subsidiaryId", sub.name as "subsidiaryName",
           d.posting_date::text as "postingDate", d.document_date::text as "documentDate",
           root.id as "rootId", root.name as "rootName"
      from documents d
      left join subsidiaries sub on sub.org_id = d.org_id and sub.id = d.subsidiary_id
      left join subsidiaries root on root.org_id = d.org_id and root.parent_id is null
     where d.org_id = ${orgId} and d.id = ${documentId}
  `)).rows;
  const row = rows[0];
  if (!row) {
    const count = (await runner.execute<{ n: number }>(sql`
      select count(*)::int as n from documents where org_id = ${orgId} and id = ${documentId}`)).rows[0];
    if (count?.n === 0) {
      throw storedValueRefusal({
        message: "The stored-value movement names a document that does not exist in this organization.",
        code: "stored_value_document_missing",
        remedy: "Post the movement against a document in this organization.",
        status: 409,
      });
    }
    throw storedValueRefusal({
      message: "The stored-value movement cannot read its document in this organization.",
      code: "stored_value_document_unreadable",
      remedy: "Retry the operation.",
    });
  }
  const subsidiaryId = row.subsidiaryId ?? row.rootId;
  const subsidiaryName = row.subsidiaryName ?? row.rootName;
  if (!subsidiaryId || !subsidiaryName) {
    throw storedValueRefusal({
      message: "The document's organization has no legal entity to post the stored-value movement to.",
      code: "stored_value_subsidiary_missing",
      remedy: "Give the organization a root subsidiary, then repost the document.",
    });
  }
  return {
    id: row.id,
    currency: row.currency,
    fxRate: row.fxRate,
    subsidiaryId,
    subsidiaryName,
    postingDate: row.postingDate ?? row.documentDate,
  };
}

export type EventRate = {
  /** Decimal rate string for the fx_rate evidence columns. */
  rate: string;
  units: bigint;
};

/**
 * Resolve the card→functional rate for one movement. Document movements use
 * the document's own rate when it carries one (a default 1.0 on a
 * foreign-currency document means "unset", exactly as the posting kernel
 * reads it) and the business-date spot otherwise; off-document movements
 * always use the spot. Same-currency pairs are exact par by definition.
 */
export async function resolveEventRate(
  runner: SqlExecutor,
  orgId: string,
  cardCurrency: string,
  functionalCurrency: string,
  postingDate: string,
  doc: Pick<DocumentFxContext, "currency" | "fxRate"> | null,
): Promise<EventRate> {
  if (cardCurrency === functionalCurrency) {
    return { rate: "1", units: RATE_SCALE };
  }
  if (doc) {
    if (doc.currency !== cardCurrency) {
      throw storedValueRefusal({
        message: `The movement is in ${cardCurrency}, but its document is in ${doc.currency}.`,
        code: "stored_value_document_currency_mismatch",
        remedy: `Move ${cardCurrency} stored value on a ${cardCurrency} document.`,
      });
    }
    if (doc.fxRate && normalizeDecimal(doc.fxRate, 10) !== "1.0000000000") {
      const units = parseRateToUnits(doc.fxRate);
      return { rate: formatRateUnits(units), units };
    }
  }
  const spot = await lookupSpotRate(runner, orgId, cardCurrency, functionalCurrency, postingDate);
  if (!spot) {
    throw storedValueRefusal({
      message: `No ${cardCurrency}→${functionalCurrency} rate exists on or before ${postingDate}, so the ${cardCurrency} movement cannot be priced.`,
      code: "stored_value_rate_missing",
      remedy: doc
        ? "Set the exchange rate on the document, or record the spot rate for the posting date, then retry."
        : "Record the spot rate for the posting date in Company Settings → Currencies, then retry.",
    });
  }
  const units = parseRateToUnits(spot);
  return { rate: formatRateUnits(units), units };
}

/** Functional carrying total behind an account: every entry priced alike sums to the ledger balance. */
export async function accountFunctionalTotal(
  runner: SqlExecutor,
  orgId: string,
  accountId: string,
): Promise<bigint> {
  const rows = (await runner.execute<{ total: string }>(sql`
    select coalesce(sum(functional_amount_minor), 0)::text as total
      from stored_value_entries
     where org_id = ${orgId} and account_id = ${accountId}
  `)).rows;
  return BigInt(rows[0]?.total ?? "0");
}

export type CarryingShare = {
  /** The slice's functional minor units: exact for a full relief, average-rated otherwise. */
  functional: bigint;
  rate: string;
  units: bigint;
};

/**
 * The historical functional value of a relieved slice. A full-balance
 * relief carries its exact remainder; a partial slice carries its average
 * share, rounded once. The one-unit remainder of that rounding stays in
 * the account, exactly like the posting kernel's own rounding residual.
 */
export function carryingShare(
  functionalPrior: bigint,
  balancePrior: bigint,
  amountMinor: bigint,
): CarryingShare {
  if (amountMinor === balancePrior) {
    const units = balancePrior === 0n ? RATE_SCALE : roundDiv(functionalPrior * RATE_SCALE, balancePrior);
    return { functional: functionalPrior, rate: formatRateUnits(units), units };
  }
  const units = roundDiv(functionalPrior * RATE_SCALE, balancePrior);
  return { functional: functionalMinor(amountMinor, units), rate: formatRateUnits(units), units };
}

/**
 * A stored-value liability is a monetary item: a fixed foreign-currency
 * obligation the period-end revaluation must restate. Flag the account the
 * moment it is designated, so the revaluation run discovers the balance
 * through the same monetary predicate as every other foreign balance. An
 * explicit operator opt-out (false) is never overridden.
 */
export async function ensureMonetaryLiability(
  runner: SqlExecutor,
  orgId: string,
  accountId: string,
): Promise<void> {
  await runner.execute(sql`
    update accounts set monetary = true
     where org_id = ${orgId} and id = ${accountId} and monetary is null
       and type in ('liability_payable', 'liability_current_other')
  `);
}

/** Base currency of one subsidiary, refused by name when it is not ours. */
export async function subsidiaryBaseCurrency(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
): Promise<string> {
  const rows = (await runner.execute<{ currency: string }>(sql`
    select nullif(trim(base_currency), '') as currency from subsidiaries
     where org_id = ${orgId} and id = ${subsidiaryId}
  `)).rows;
  if (!rows[0]?.currency) {
    throw storedValueRefusal({
      message: "The stored-value movement names a legal entity that does not exist in this organization.",
      code: "stored_value_subsidiary_missing",
      remedy: "Post the movement to a subsidiary of this organization.",
    });
  }
  return rows[0].currency;
}
