import { sql } from "drizzle-orm";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { mulRate } from "../money/money.ts";
import { parseMoney } from "../money/brands.ts";
import { divideDecimal } from "../money/exact-decimal.ts";
import { lookupExchangeRate } from "../fx/spot-rate.ts";
import { accountingPreferences } from "../organization/accounting-preferences.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { effectivePostingDate, type Doc, type KernelLine } from "../journal/posting-contracts.ts";
import { JournalInstructionError } from "./journal-instruction-error.ts";

/** Canonical header-currency equivalents balance an advanced journal without discarding the original line currencies. */
export async function normalizeJournalCurrencyLines(
  runner: SqlExecutor,
  doc: Pick<
    Doc,
    | "id"
    | "orgId"
    | "kind"
    | "subsidiaryId"
    | "currency"
    | "fxRate"
    | "postingDate"
    | "documentDate"
  > & { journalMode?: string; accountingBookId?: string | null },
  lines: KernelLine[],
): Promise<KernelLine[]> {
  if (
    doc.kind !== "journal" ||
    doc.journalMode === "statistical" ||
    doc.journalMode === "currency_adjustment"
  )
    return lines;
  if (!doc.subsidiaryId)
    throw new JournalInstructionError(
      "The journal has no accounting entity.",
      "Choose its active entity and accounting book.",
    );
  const normalized: KernelLine[] = [];
  const bookId = doc.accountingBookId ?? (await activePostingPrimaryBookId(doc.orgId, runner));
  const bases = await runner.execute<{ id: string; currency: string }>(
    sql`select id,public.accounting_book_currency(${doc.orgId},${bookId},id) as currency
    from subsidiaries where org_id=${doc.orgId} and id in ${[...new Set([doc.subsidiaryId, ...lines.map((line) => line.subsidiaryId ?? doc.subsidiaryId)].filter((id): id is string => !!id))]}`,
    "objects",
  );
  const currencies = new Map(bases.map((row) => [row.id, row.currency]));
  const homeCurrency = doc.subsidiaryId ? currencies.get(doc.subsidiaryId) : undefined;
  if (!homeCurrency)
    throw new JournalInstructionError(
      "The journal has no accounting currency.",
      "Choose its active entity and accounting book.",
    );
  for (const line of lines) {
    const currency = line.currency ?? doc.currency;
    let headerAmount = line.amount;
    if (currency !== doc.currency) {
      if (line.fxRate) {
        const entityId = line.subsidiaryId ?? doc.subsidiaryId;
        const lineBase = entityId ? currencies.get(entityId) : undefined;
        if (!lineBase || !entityId)
          throw new JournalInstructionError(
            "The journal line has no accounting currency.",
            "Choose its active entity.",
          );
        let baseAmount = mulRate(line.amount, line.fxRate);
        if (lineBase !== homeCurrency) {
          const policy = await accountingPreferences(
            runner,
            doc.orgId,
            entityId,
            effectivePostingDate(doc),
          );
          const crossRate = await lookupExchangeRate(
            runner,
            doc.orgId,
            lineBase,
            homeCurrency,
            effectivePostingDate(doc),
            policy.postingRateType,
          );
          if (!crossRate)
            throw new JournalInstructionError(
              `No ${policy.postingRateType} rate converts ${lineBase} to ${homeCurrency}.`,
              "Record the entity-to-header accounting-currency quote in Setup → Exchange rates.",
            );
          baseAmount = mulRate(baseAmount, crossRate);
        }
        headerAmount = parseMoney(divideDecimal(baseAmount, doc.fxRate, 4));
      } else {
        const subsidiaryId = line.subsidiaryId ?? doc.subsidiaryId;
        if (!subsidiaryId)
          throw new JournalInstructionError(
            "The journal line has no entity.",
            "Choose its subsidiary.",
          );
        const policy = await accountingPreferences(
          runner,
          doc.orgId,
          subsidiaryId,
          effectivePostingDate(doc),
        );
        const rate = await lookupExchangeRate(
          runner,
          doc.orgId,
          currency,
          doc.currency,
          effectivePostingDate(doc),
          policy.postingRateType,
        );
        if (!rate)
          throw new JournalInstructionError(
            `No ${policy.postingRateType} exchange rate converts ${currency} to ${doc.currency}.`,
            "Enter the dated quote in Setup → Exchange rates before saving or posting this journal.",
          );
        headerAmount = parseMoney(mulRate(line.amount, rate));
      }
    }
    normalized.push({ ...line, currency, balanceTxnAmount: headerAmount });
  }
  return normalized;
}
