import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { mulRate, normalizeDecimal } from "../money/money.ts";
import { absorbFxRoundingResidual, intercompanyBalancingLegs, loadSubsidiaryContext, SubsidiaryError, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { type Doc, type KernelLine, PostingError } from "./posting-rules.ts";
/**
 * Application-layer proof for the storage trigger `jl_check_account`
 * (F-t06-002): every final line inserts in its line currency, so a target
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
  const rows = (await runner.execute<{
    id: string;
    number: string | null;
    name: string;
    restriction: string | null;
  }>(sql`
    select id, number, name, currency_restriction as restriction from accounts
     where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`)).rows;
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
    if (!origin)
      throw new SubsidiaryError(`subsidiary ${docSubId} does not exist`);
    const postingDate = doc.postingDate ?? doc.documentDate;
    const rateCache = new Map<string, string>();

    const functionalRate = async (targetCurrency: string): Promise<string> => {
      if (doc.currency === targetCurrency) return "1";
      // Honour a user-supplied header rate. The schema default is '1', which
      // on a foreign-currency document is "unset", not a 1:1 peg — look the
      // spot up so dunning, payment runs and the stamp are not all 1. The
      // column is numeric(19,10), so the default readback is the string
      // "1.0000000000": compare at the column's own ten-decimal scale,
      // rather than by string inequality, so every default-rate document
      // resolves its spot rate.
      if (
        targetCurrency === origin.baseCurrency &&
        doc.fxRate &&
        normalizeDecimal(doc.fxRate, 10) !== "1.0000000000"
      ) {
        return doc.fxRate;
      }
      const cached = rateCache.get(targetCurrency);
      if (cached) return cached;
      // When the direct pair and an inverted quote share the newest as_of,
      // the DIRECT row wins (priority 0 beats 1) — the same deterministic
      // rule as revaluation and labor-costing, so one pair/date always
      // converts alike. Provider syncs write every directed pair per date,
      // and double rounding can separate the candidates by a unit.
      const r = (await runner.execute<{ rate: string }>(sql`
        select rate::text from (
          select rate, as_of, 0 as priority from fx_rates
           where org_id = ${doc.orgId} and from_currency = ${doc.currency}
             and to_currency = ${targetCurrency} and rate_type = 'spot'
             and as_of <= ${postingDate}
          union all
          select (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority from fx_rates
           where org_id = ${doc.orgId} and from_currency = ${targetCurrency}
             and to_currency = ${doc.currency} and rate_type = 'spot'
             and as_of <= ${postingDate}
        ) candidates order by as_of desc, priority asc limit 1`));
      const rate = r.rows[0]?.rate;
      if (!rate) {
        throw new SubsidiaryError(
          `no spot rate for ${doc.currency}→${targetCurrency} on or before ${postingDate}`,
        );
      }
      rateCache.set(targetCurrency, rate);
      return rate;
    };

    // The runner can be a transaction-scoped database handle backed by one
    // PostgreSQL client. Resolve rates in a deterministic sequence instead of
    // issuing concurrent queries on that client. This also makes the cache
    // authoritative when several lines share a target currency.
    const stamped: (KernelLine & {
      subsidiaryId: string;
      currency: string;
      txnAmount: string;
      fxRate: string;
    })[] = [];
    for (const line of kernelLines) {
      const subsidiaryId = line.subsidiaryId ?? docSubId;
      const subsidiary = ctx.byId.get(subsidiaryId);
      if (!subsidiary)
        throw new SubsidiaryError(`subsidiary ${subsidiaryId} does not exist`);
      const fxRate = await functionalRate(subsidiary.baseCurrency);
      stamped.push({
        ...line,
        subsidiaryId,
        amount: mulRate(line.amount, fxRate),
        currency: doc.currency,
        txnAmount: line.amount,
        fxRate,
      });
    }
    // Every line converted independently above, so a foreign-currency
    // document's rounded lines can miss zero by a few ten-thousandths even
    // though its transaction amounts balance. Fold that per-subsidiary
    // rounding onto each group's final line before balancing: single-entity
    // documents get no intercompany legs at all, and the kernel asserts
    // exact balance.
    absorbFxRoundingResidual(stamped);
    const originFxRate = await functionalRate(origin.baseCurrency);
    const legs = await intercompanyBalancingLegs(runner, {
      orgId: doc.orgId,
      ctx,
      originSubId: docSubId,
      originFxRate,
      lines: stamped,
    });
    const all = [
      ...stamped,
      ...legs.map((leg) => ({
        accountId: leg.accountId,
        amount: leg.amount,
        currency: leg.currency,
        txnAmount: leg.txnAmount,
        fxRate: leg.fxRate,
        subsidiaryId: leg.subsidiaryId,
        memo: leg.memo,
      })),
    ];
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
      originBaseCurrency: origin.baseCurrency,
      originFxRate,
    };
  } catch (err) {
    if (err instanceof SubsidiaryError) throw new PostingError(err.message);
    throw err;
  }
}
