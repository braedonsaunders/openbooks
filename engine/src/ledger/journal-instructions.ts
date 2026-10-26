import { sql } from "drizzle-orm";
import { ledgerSideTotals, toUnits } from "../money/money.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import type { SqlExecutor } from "../platform/db.ts";

export { JournalInstructionError } from "./journal-instruction-error.ts";
import { JournalInstructionError } from "./journal-instruction-error.ts";
import { normalizeJournalCurrencyLines } from "./journal-currency.ts";
import { parseMoney } from "../money/brands.ts";

export {
  validateJournalInstructionLines,
  type JournalInstructionLine,
} from "./journal-instruction-validation.ts";
import { validateJournalInstructionLines } from "./journal-instruction-validation.ts";

/** Persisted validation covers UI, API, imports and posting, including header-only edits. */
export async function validateJournalInstructions(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  posting = false,
): Promise<{ debits: string; credits: string }> {
  const doc = (
    await runner.execute<{
      subsidiary_id: string;
      document_date: string;
      posting_date: string;
      currency: string;
      fx_rate: string;
      journal_mode: string;
      journal_reverse_on: string | null;
      accounting_book_id: string | null;
      base_currency: string;
    }>(
      sql`
    select d.subsidiary_id,d.document_date::text,coalesce(d.posting_date,d.document_date)::text as posting_date,
      d.currency,d.fx_rate::text,d.journal_mode,d.journal_reverse_on::text,d.accounting_book_id,s.base_currency
    from documents d join subsidiaries s on s.org_id=d.org_id and s.id=d.subsidiary_id
    where d.org_id=${orgId} and d.id=${documentId} and d.kind='journal'`,
      "objects",
    )
  )[0];
  if (!doc)
    throw new JournalInstructionError(
      "The journal or its entity is unavailable.",
      "Choose an active subsidiary and reopen the journal.",
    );
  const lines = await runner.execute<{
    line_number: number;
    account_id: string;
    type: string;
    amount: string;
    quantity: string;
    unit: string | null;
    subsidiary_id: string;
    journal_currency: string | null;
    journal_fx_rate: string | null;
    journal_eliminate: boolean;
    template: string | null;
    has_party: boolean;
  }>(
    sql`
    select l.line_number,l.account_id,a.type,l.amount::text,l.quantity::text,l.unit,coalesce(l.subsidiary_id,d.subsidiary_id) as subsidiary_id,
      l.journal_currency,l.journal_fx_rate::text,l.journal_eliminate,l.amortization_template_id as template,coalesce(l.party_id,d.party_id) is not null as has_party
    from document_lines l join documents d on d.org_id=l.org_id and d.id=l.document_id
    join accounts a on a.org_id=l.org_id and a.id=l.account_id
    where l.org_id=${orgId} and l.document_id=${documentId} order by l.line_number`,
    "objects",
  );
  if (lines.length === 0)
    throw new JournalInstructionError(
      "A journal needs at least one line.",
      "Add its account and exact amount or statistical quantity.",
    );
  if (
    doc.journal_reverse_on &&
    (!isIsoCalendarDate(doc.journal_reverse_on) || doc.journal_reverse_on <= doc.posting_date)
  ) {
    throw new JournalInstructionError(
      "The automatic reversal date must be after the journal's posting date.",
      "Choose a later open-period date.",
    );
  }
  const storedCount = (
    await runner.execute<{ count: number }>(
      sql`select count(*)::int as count from document_lines where org_id=${orgId} and document_id=${documentId}`,
      "objects",
    )
  )[0]?.count;
  if (storedCount !== lines.length)
    throw new JournalInstructionError(
      "A journal line has no owned posting account.",
      "Assign an account on every line before saving or posting.",
    );
  const currencies = [
    ...new Set([doc.currency, ...lines.map((line) => line.journal_currency ?? doc.currency)]),
  ];
  const found = await runner.execute<{ code: string }>(
    sql`select code from currencies where code in ${currencies}`,
    "objects",
  );
  if (found.length !== currencies.length)
    throw new JournalInstructionError(
      "A journal currency is unavailable.",
      "Choose an ISO currency registered in this application.",
    );
  if (canonicalDecimal(doc.fx_rate, 10) === null || compareDecimal(doc.fx_rate, "0") <= 0)
    throw new JournalInstructionError(
      "The header exchange rate is invalid.",
      "Enter a positive exact decimal rate.",
    );
  const historicalReplay =
    posting &&
    (
      await runner.execute<{ allowed: boolean }>(
        sql`select public.connector_historical_replay_authorized(${orgId}) as allowed`,
        "objects",
      )
    )[0]?.allowed === true;
  const usesForeign =
    currencies.some((currency) => currency !== doc.base_currency) ||
    lines.some((line) => line.journal_currency);
  if (
    !historicalReplay &&
    doc.journal_mode !== "statistical" &&
    usesForeign &&
    !(await lockAndCheckOrgFeature(runner, orgId, "multiCurrency"))
  )
    throw new JournalInstructionError(
      "Multi-currency is off.",
      "Turn on Multi-currency in Company Settings → Features.",
    );
  const advanced = lines.some(
    (line) => line.journal_eliminate || line.subsidiary_id !== doc.subsidiary_id,
  );
  if (
    !historicalReplay &&
    advanced &&
    !(await lockAndCheckOrgFeature(runner, orgId, "multiSubsidiary"))
  )
    throw new JournalInstructionError(
      "Multi-subsidiary is off.",
      "Turn on Multi-subsidiary in Company Settings → Features.",
    );
  if (
    doc.journal_reverse_on &&
    lines.some(
      (line) => line.has_party && ["asset_receivable", "liability_payable"].includes(line.type),
    )
  )
    throw new JournalInstructionError(
      "An automatically reversing accrual cannot also create a customer or vendor open item.",
      "Use an accrual asset or liability account for the reversal; settle receivable/payable obligations through native payments and governed voids.",
    );
  validateJournalInstructionLines(
    doc.journal_mode,
    doc.journal_reverse_on,
    lines,
    // Imported documents retain zero-value source detail. Posting emits no
    // monetary leg for it; account and instruction compatibility still apply.
    posting,
  );
  const canonicalLines = await normalizeJournalCurrencyLines(
    runner,
    {
      id: documentId,
      orgId,
      kind: "journal",
      subsidiaryId: doc.subsidiary_id,
      currency: doc.currency,
      fxRate: doc.fx_rate,
      postingDate: doc.posting_date,
      documentDate: doc.document_date,
      journalMode: doc.journal_mode,
      accountingBookId: doc.accounting_book_id,
    },
    lines.map((line) => ({
      accountId: line.account_id,
      amount: parseMoney(line.amount),
      subsidiaryId: line.subsidiary_id,
      currency:
        doc.journal_mode === "currency_adjustment"
          ? doc.currency
          : (line.journal_currency ?? doc.currency),
      fxRate: line.journal_fx_rate ?? undefined,
    })),
  );
  if (
    canonicalLines.reduce(
      (sum, line) => sum + toUnits(line.balanceTxnAmount ?? line.amount),
      0n,
    ) !== 0n
  ) {
    throw new JournalInstructionError(
      "The journal does not balance in its header currency.",
      "Correct the debit/credit amounts or line rates; amounts in different transaction currencies must have equal header-currency values.",
    );
  }
  if (posting && doc.journal_mode === "currency_adjustment") {
    const bookId = doc.accounting_book_id ?? (await activePostingPrimaryBookId(orgId, runner));
    if (
      doc.currency !==
        (
          await runner.execute<{ currency: string }>(
            sql`select public.accounting_book_currency(${orgId},${bookId},${doc.subsidiary_id}) as currency`,
            "objects",
          )
        )[0]?.currency ||
      compareDecimal(doc.fx_rate, "1") !== 0
    ) {
      throw new JournalInstructionError(
        "Currency adjustment amounts must be denominated in the selected book's currency.",
        "Choose that book currency and a header exchange rate of 1.",
      );
    }
    const adjustedAccounts = new Set<string>();
    for (const line of lines) {
      if (line.subsidiary_id !== doc.subsidiary_id || line.template || line.journal_eliminate)
        throw new JournalInstructionError(
          "A currency adjustment uses one entity and cannot defer expense or eliminate balances.",
          "Create a separate adjustment for each entity.",
        );
      if (!line.journal_currency) {
        if (!["income", "income_other", "expense", "expense_other"].includes(line.type))
          throw new JournalInstructionError(
            "A currency adjustment's offset must be a gain/loss account.",
            "Choose an active income or expense account for the offset.",
          );
        continue;
      }
      if (line.journal_currency === doc.currency || adjustedAccounts.has(line.account_id))
        throw new JournalInstructionError(
          "Each residual-clearing account must identify a foreign currency once.",
          "Choose a foreign currency and retain one clearing line per account.",
        );
      adjustedAccounts.add(line.account_id);
      const residual = (
        await runner.execute<{
          foreign_open: boolean;
          has_currency: boolean;
          base_amount: string;
        }>(
          sql`
        select exists(select 1 from journal_lines f join journal_entries fe on fe.org_id=f.org_id and fe.id=f.entry_id
          where f.org_id=${orgId} and fe.book_id=${bookId} and fe.status in ('posted','reversed') and fe.posting_date<=${doc.posting_date}
          and f.subsidiary_id=${line.subsidiary_id} and f.account_id=${line.account_id} and f.currency<>${doc.currency}
          group by f.currency having sum(f.txn_amount)<>0) as foreign_open,exists(select 1 from journal_lines f join journal_entries fe on fe.org_id=f.org_id and fe.id=f.entry_id
          where f.org_id=${orgId} and fe.book_id=${bookId} and fe.status in ('posted','reversed') and fe.posting_date<=${doc.posting_date}
          and f.account_id=${line.account_id} and f.subsidiary_id=${line.subsidiary_id} and f.currency=${line.journal_currency}) as has_currency,
          coalesce(sum(l.amount),0)::text as base_amount
        from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id
        where l.org_id=${orgId} and e.book_id=${bookId} and e.status in ('posted','reversed') and e.posting_date<=${doc.posting_date}
          and l.subsidiary_id=${line.subsidiary_id} and l.account_id=${line.account_id}
`,
          "objects",
        )
      )[0]!;
      if (
        !residual.has_currency ||
        residual.foreign_open ||
        toUnits(residual.base_amount) + toUnits(line.amount) !== 0n
      ) {
        throw new JournalInstructionError(
          `Line ${line.line_number}: the currency adjustment must clear an exact base residual with zero foreign balance.`,
          "Reconcile the account's foreign balance, then enter the current opposite base-currency residual.",
        );
      }
    }
    if (!lines.some((line) => line.journal_currency))
      throw new JournalInstructionError(
        "A currency adjustment must identify the foreign currency whose zero balance has a base residual.",
        "Choose the foreign currency on the residual-clearing line and a gain/loss offset on another line.",
      );
  }
  return ledgerSideTotals(canonicalLines.map((line) => line.balanceTxnAmount ?? line.amount));
}
