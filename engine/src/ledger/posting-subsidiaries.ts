import { parseMoney } from "../money/brands.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { accountingPreferences } from "../organization/accounting-preferences.ts";
import { applyBookAccountMaps } from "../journal/book-account-maps.ts";
import { lookupExchangeRate } from "../fx/spot-rate.ts";
import { normalizeDecimal } from "../money/money.ts";
import { mulMoneyRate, type Money } from "../money/brands.ts";
import {
  absorbFxRoundingResidual,
  intercompanyBalancingLegs,
  loadSubsidiaryContext,
  SubsidiaryError,
  validateSubsidiaryRestrictions,
} from "../organization/subsidiaries.ts";
import {
  type Doc,
  type KernelLine,
  PostingError,
  effectivePostingDate,
} from "../journal/posting-contracts.ts";
import { collectBalancingLegs } from "../journal/balancing-hooks.ts";
import {
  applyWithholdingCarrying,
  stampPaymentWithholdingCurrency,
} from "../contractor-withholding/remittance-carrying.ts";
import { ContractorWithholdingError } from "../contractor-withholding/scheme.ts";
import { loadBookProfile, resolveBookBases, resolveBookRates } from "../journal/book-basis.ts";
import {
  BookTranslationError,
  isIdentityBasis,
  rateKey,
  type BookSubsidiaryBasis,
} from "../journal/book-translation.ts";
import {
  DocumentFxError,
  documentFxPostingRefusal,
  readDocumentFxRateEvidence,
} from "./document-fx.ts";
/**
 * Application-layer proof for the storage trigger `jl_check_account`:
 * every final line inserts in its line currency, so a target
 * account carrying a currency restriction must name exactly that currency.
 * Refusing here — naming the account and its allowed currency, never an
 * id — turns a 500 raw-SQL escape into a typed refusal before any journal
 * row is inserted. Runs inside `applySubsidiaries`, so first posting,
 * regeneration, and secondary-book sets all pass through it, with no
 * migration exemption (the trigger enforces currency on replay too).
 */
export async function assertAccountCurrencyRestrictions(
  runner: Pick<typeof db, "execute">,
  orgId: string,
  lines: readonly { accountId: string; currency: string }[],
): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.accountId))];
  if (ids.length === 0) return;
  const rows = await runner.execute<{
    id: string;
    number: string | null;
    name: string;
    restriction: string | null;
  }>(
    sql`
    select id, number, name, currency_restriction as restriction from accounts
     where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`,
    "objects",
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const line of lines) {
    const acct = byId.get(line.accountId);
    if (acct && acct.restriction && line.currency !== acct.restriction) {
      const label = [acct.number, acct.name].filter(Boolean).join(" ");
      throw new PostingError(
        `${label} only accepts ${acct.restriction} postings, not ${line.currency}`,
      );
    }
  }
}

/**
 * Resolve every kernel line to a legal entity and make the entry balance per
 * subsidiary: stamp doc-default subsidiaries, inject intercompany due-to/
 * due-from legs when lines span entities, and validate account / dimension /
 * party subsidiary restrictions. Shared by first posting and regeneration.
 */
export async function applySubsidiaries(
  runner: Pick<typeof db, "execute">,
  doc: Doc,
  kernelLines: KernelLine[],
  options: { bookId: string | null; regeneration: boolean; withholdingCarrying?: boolean },
): Promise<{
  lines: (KernelLine & {
    subsidiaryId: string;
    currency: string;
    txnAmount: string;
    fxRate: string;
  })[];
  docSubId: string;
  multi: boolean;
  /** The origin subsidiary's functional currency. */
  originBaseCurrency: string;
  /**
   * The txn→origin-functional rate this run resolved and applied to every
   * origin-subsidiary leg (the document's stored rate when it carries one,
   * "1" when the document is already in the origin's base currency).
   */
  originFxRate: string;
}> {
  try {
    const ctx = await loadSubsidiaryContext(runner, doc.orgId);
    const docSubId = doc.subsidiaryId ?? ctx.rootId;
    const origin = ctx.byId.get(docSubId);
    if (!origin) throw new SubsidiaryError(`subsidiary ${docSubId} does not exist`);
    const postingDate = effectivePostingDate(doc);
    // Recorded rate evidence measures this document only while it still
    // describes the posting: its currency, owning entity and that entity's
    // functional currency, effective posting date and stored rate.
    const fxEvidence = readDocumentFxRateEvidence(doc.documentFxRateEvidence);
    if (fxEvidence) {
      const refusal = documentFxPostingRefusal(
        doc.kind,
        fxEvidence,
        {
          currency: doc.currency,
          functionalCurrency: origin.baseCurrency,
          rateDate: postingDate,
          subsidiaryId: docSubId,
        },
        doc.fxRate,
      );
      if (refusal) throw new PostingError(refusal);
    }
    const rateCache = new Map<string, string>();
    // A posting into a non-primary book measures each subsidiary in the
    // book's currency for it (its functional currency unless the book is
    // configured otherwise) at the book's rate type.
    const bookBases = await documentBookBases(
      runner,
      doc,
      options.bookId,
      [docSubId, ...kernelLines.map((line) => line.subsidiaryId ?? docSubId)],
      postingDate,
    );
    const measurementCurrency = (subsidiaryId: string, baseCurrency: string): string =>
      bookBases?.get(subsidiaryId)?.bookCurrency ?? baseCurrency;
    const bookRate = async (
      subsidiaryId: string,
      transactionCurrency = doc.currency,
      statedRate?: string,
    ): Promise<string | null> => {
      const basis = bookBases?.get(subsidiaryId);
      if (!basis || isIdentityBasis(basis)) return null;
      if (transactionCurrency === basis.bookCurrency) return "1";
      if (statedRate) return statedRate;
      if (
        doc.kind === "journal" &&
        doc.journalFxRateExplicit &&
        transactionCurrency === doc.currency &&
        subsidiaryId === docSubId
      )
        return doc.fxRate;
      const key = rateKey(subsidiaryId, transactionCurrency);
      const cached = rateCache.get(`book:${key}`);
      if (cached) return cached;
      const { rates } = await resolveBookRates(runner, {
        orgId: doc.orgId,
        bookCode: bookBases!.code,
        postingDate,
        bases: new Map([[subsidiaryId, basis]]),
        lines: [{ subsidiaryId, currency: transactionCurrency }],
      });
      const rate = rates.get(key)!;
      rateCache.set(`book:${key}`, rate);
      return rate;
    };

    const functionalRate = async (
      targetCurrency: string,
      transactionCurrency = doc.currency,
      statedRate?: string,
      subsidiaryId = docSubId,
    ): Promise<string> => {
      if (transactionCurrency === targetCurrency) return "1";
      if (statedRate) return statedRate;
      // An explicit rate converts the document currency into its owning
      // entity's functional currency and nothing else: another entity on the
      // same currency, or any other conversion, uses the exchange rates.
      if (
        fxEvidence &&
        transactionCurrency === doc.currency &&
        targetCurrency === origin.baseCurrency &&
        subsidiaryId === docSubId
      ) {
        return fxEvidence.rate;
      }
      // Honour a user-supplied header rate. The schema default is '1', which
      // on a foreign-currency document is "unset", not a 1:1 peg — look the
      // spot up so dunning, payment runs and the stamp are not all 1. The
      // column is numeric(19,10), so the default readback is the string
      // "1.0000000000": compare at the column's own ten-decimal scale,
      // rather than by string inequality, so every default-rate document
      // resolves its spot rate.
      if (
        !fxEvidence &&
        transactionCurrency === doc.currency &&
        targetCurrency === origin.baseCurrency &&
        doc.fxRate &&
        (doc.journalFxRateExplicit ||
          normalizeDecimal(doc.fxRate, 10) !== "1.0000000000" ||
          !!(doc.custom as { withholdingDeposit?: unknown; withholdingRemittance?: unknown } | null)
            ?.withholdingDeposit ||
          !!(doc.custom as { withholdingRemittance?: unknown } | null)?.withholdingRemittance)
      ) {
        return doc.fxRate;
      }
      const cached = rateCache.get(`${subsidiaryId}:${transactionCurrency}:${targetCurrency}`);
      if (cached) return cached;
      // Direct-or-inverse through the shared FX lookup (direct wins
      // same-date ties) — the same conversion consolidation derivation and
      // statement translation apply, so one pair/date converts alike
      // everywhere.
      const policy = await accountingPreferences(runner, doc.orgId, subsidiaryId, postingDate);
      const rate = await lookupExchangeRate(
        runner,
        doc.orgId,
        transactionCurrency,
        targetCurrency,
        postingDate,
        policy.postingRateType,
      );
      if (!rate) {
        throw new SubsidiaryError(
          `no ${policy.postingRateType} rate for ${transactionCurrency}→${targetCurrency} on or before ${postingDate}`,
        );
      }
      rateCache.set(`${subsidiaryId}:${transactionCurrency}:${targetCurrency}`, rate);
      return rate;
    };

    // The runner can be a transaction-scoped database handle backed by one
    // PostgreSQL client. Resolve rates in a deterministic sequence instead of
    // issuing concurrent queries on that client. This also makes the cache
    // authoritative when several lines share a target currency.
    // txnAmount re-states the kernel amount as canonical Money. KernelLine
    // itself carries Money now (parsed once at the DocLine boundary, fail
    // closed), so each stamp carries it directly — the type is the assert,
    // no re-parse. fxRate stays plain string on purpose: it
    // preserves source text shape (header rate or spot lookup) for the
    // stored fx_rate column; the math goes through mulMoneyRate, which reads
    // any rate-scale decimal exactly.
    const stamped: (KernelLine & {
      subsidiaryId: string;
      currency: string;
      txnAmount: Money;
      fxRate: string;
    })[] = [];
    for (const line of kernelLines) {
      const subsidiaryId = line.subsidiaryId ?? docSubId;
      const subsidiary = ctx.byId.get(subsidiaryId);
      if (!subsidiary) throw new SubsidiaryError(`subsidiary ${subsidiaryId} does not exist`);
      const transactionCurrency =
        doc.journalMode === "statistical"
          ? measurementCurrency(subsidiaryId, subsidiary.baseCurrency)
          : (line.currency ?? doc.currency);
      const fxRate =
        line.isCurrencyAdjustment || doc.journalMode === "statistical"
          ? "1"
          : ((await bookRate(subsidiaryId, transactionCurrency, line.fxRate)) ??
            (await functionalRate(
              subsidiary.baseCurrency,
              transactionCurrency,
              line.fxRate,
              subsidiaryId,
            )));
      stamped.push({
        ...line,
        subsidiaryId,
        amount: line.isCurrencyAdjustment ? line.amount : mulMoneyRate(line.amount, fxRate),
        currency: transactionCurrency,
        txnAmount: line.isCurrencyAdjustment ? parseMoney("0") : line.amount,
        fxRate,
      });
    }
    // Every line converted independently above, so a foreign-currency
    // document's rounded lines can miss zero by a few ten-thousandths even
    // though its transaction amounts balance. Fold that per-subsidiary
    // rounding onto each group's final line before balancing: single-entity
    // documents get no intercompany legs at all, and the kernel asserts
    // exact balance.
    if (doc.journalMode !== "currency_adjustment") absorbFxRoundingResidual(stamped);
    const originFxRate = (await bookRate(docSubId)) ?? (await functionalRate(origin.baseCurrency));
    const legs = await intercompanyBalancingLegs(runner, {
      orgId: doc.orgId,
      ctx,
      originSubId: docSubId,
      originFxRate,
      balanceCurrency: doc.kind === "journal" ? doc.currency : undefined,
      lines: stamped,
    });
    const nativeTranslated = [
      ...stamped,
      ...legs.map((leg) => ({
        accountId: leg.accountId,
        amount: leg.amount,
        currency: leg.currency,
        // Balancing legs are kernel-built Money (IntercompanyLeg), so the
        // stamp carries the amount directly like the kernel lines above.
        txnAmount: leg.txnAmount,
        fxRate: leg.fxRate,
        subsidiaryId: leg.subsidiaryId,
        memo: leg.memo,
      })),
    ];
    let translated = stampPaymentWithholdingCurrency(doc, nativeTranslated);
    if (options.regeneration && doc.kind === "vendor_payment" && doc.postedEntryId) {
      // Live entries only: regeneration compares against the payment's standing posting
      const existing = await runner.execute<{ accountId: string; currency: string }>(
        sql`select l.account_id as "accountId",l.currency from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id where l.org_id=${doc.orgId} and e.source_document_id=${doc.id} and e.status='posted' and ${options.bookId ? sql`e.book_id=${options.bookId}` : sql`e.id=${doc.postedEntryId}`} and l.memo='Contractor withholding' and l.contributor_kind is null`,
        "objects",
      );
      translated = translated.map((line, index) =>
        existing.some(
          (row) =>
            row.accountId === line.accountId &&
            row.currency === doc.currency &&
            row.currency !== line.currency,
        )
          ? nativeTranslated[index]!
          : line,
      );
    }
    let all =
      options.withholdingCarrying === false
        ? translated
        : await applyWithholdingCarrying(
            runner,
            doc,
            translated,
            docSubId,
            origin.baseCurrency,
            options.bookId,
          );
    if (options.bookId && doc.kind === "journal" && doc.journalMode !== "currency_adjustment") {
      const profile = await loadBookProfile(runner, doc.orgId, options.bookId);
      if (profile && !profile.isPrimary)
        all = (
          await applyBookAccountMaps(runner, {
            orgId: doc.orgId,
            bookId: profile.id,
            bookLabel: profile.code,
            postingDate,
            entryLabel: doc.documentNumber ?? doc.id,
            lines: all,
          })
        ).lines;
    }
    // Balancing-segment legs (interfund due-to/due-from for a balancing fund
    // segment, for example) come from registered providers. They are
    // appended before the restriction checks below so every leg is
    // validated exactly like a kernel line; a provider can only add legs.
    const segmentLegs = await collectBalancingLegs(
      runner,
      {
        orgId: doc.orgId,
        postingDate,
        bookId: options.bookId,
        sourceDocumentId: doc.id,
        regeneration: options.regeneration,
      },
      all,
    );
    for (const leg of segmentLegs) {
      all.push({
        accountId: leg.accountId,
        amount: leg.amount,
        currency: leg.currency,
        txnAmount: leg.txnAmount,
        fxRate: leg.fxRate,
        subsidiaryId: leg.subsidiaryId,
        memo: leg.memo,
        extraDims: leg.extraDims,
        departmentId: leg.departmentId,
        projectId: leg.projectId,
        locationId: leg.locationId,
        classId: leg.classId,
      });
    }
    await validateSubsidiaryRestrictions(runner, {
      orgId: doc.orgId,
      ctx,
      lines: all,
      partyId: doc.partyId,
      docSubsidiaryId: docSubId,
    });
    await assertAccountCurrencyRestrictions(runner, doc.orgId, all);
    return {
      lines: all,
      docSubId,
      multi: new Set(all.map((l) => l.subsidiaryId)).size > 1,
      originBaseCurrency: measurementCurrency(docSubId, origin.baseCurrency),
      originFxRate,
    };
  } catch (err) {
    if (err instanceof SubsidiaryError) throw new PostingError(err.message);
    if (err instanceof BookTranslationError) throw new PostingError(err.message);
    if (err instanceof DocumentFxError) throw new PostingError(err.message);
    if (err instanceof ContractorWithholdingError)
      throw new PostingError(err.remedy ? `${err.message} ${err.remedy}` : err.message);
    throw err;
  }
}

/**
 * Each subsidiary's basis in a non-primary target book, or null for the
 * primary book (and when no book is named), where every subsidiary is
 * measured in its functional currency.
 */
async function documentBookBases(
  runner: Pick<typeof db, "execute">,
  doc: Doc,
  bookId: string | null,
  subsidiaryIds: string[],
  postingDate: string,
): Promise<(Map<string, BookSubsidiaryBasis> & { code: string }) | null> {
  if (!bookId) return null;
  const book = await loadBookProfile(runner, doc.orgId, bookId);
  if (!book)
    throw new PostingError(`accounting book ${bookId} does not exist in this organization`);
  if (book.isPrimary) return null;
  const bases = await resolveBookBases(runner, {
    orgId: doc.orgId,
    book,
    subsidiaryIds,
    postingDate,
  });
  return Object.assign(bases, { code: book.code });
}
