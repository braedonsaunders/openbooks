import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { statementBookIdsExpr } from "../gl-summary";
import { mulDecimal } from "@openbooks/engine/money/money";
// Relative (not the bare workspace specifier): worktree node_modules resolves
// bare @openbooks/* to the main checkout, so a new engine module would not
// resolve until merge; a relative import binds this checkout everywhere.
import { AP_OPEN_ITEM_KINDS, AR_OPEN_ITEM_KINDS } from "@openbooks/engine/records/open-item-kinds";
import { appliedLegAmountExpr, datedAppliedAmountSql } from "@openbooks/engine/records/balance-due";
import { asOfPostedEntryLateral, openItemCandidateDocumentsSql, openItemCandidateLinesSql } from "@openbooks/engine/records/open-item-scopes";
import { resolveOrgId } from "../org-scope";
import { presentationCurrency, presentationRates, presentationSpotRatesSql, presentationAmountSql } from "../fx-presentation";
import { decimalAdd, decimalCmp, decimalNeg, type ExactDecimal } from "../statement-format";
import { ZERO, compareAbsoluteDescending, decimalSubtract } from "./decimals";
import { type DimFilter, dimWhere } from "./filters";
import { apOpenAccountScope, arOpenAccountScope, arResidualAccountScope } from "../ledger-scope";
// Age basis precedence (due, else posting, else document date) is the shared
// rule in ../aging-basis; the SQL below applies it as a coalesce.
import { agingBucketIndex } from "../aging-basis";

// ---------------------------------------------------------------------------
// AR / AP Aging
// ---------------------------------------------------------------------------

export type AgingSide = "ar" | "ap";

/**
 * The single as-of rule shared by the aging screen and its CSV export
 * An explicit as-of always wins; otherwise an
 * explicit period preset resolves to its own end date; a bare call with
 * neither defaults to today — the screen's default — never to the fiscal
 * year end. The export once fell through to the fiscal year end, so every
 * balance landed in 90+ or the totals disagreed with the screen by the
 * postings between the two dates.
 */
export function resolveAgingAsOf(args: {
  asOf: string | null;
  periodParam: string | null;
  periodTo: string;
  today: string;
}): string {
  return args.asOf ?? (args.periodParam ? args.periodTo : args.today);
}

/** The five aging buckets, oldest last. `age` is days past due (or since posting). */
export interface AgingRow {
  partyId: string | null;
  partyName: string | null;
  current: ExactDecimal; // not yet due (age <= 0)
  b1: ExactDecimal; // 1–30
  b2: ExactDecimal; // 31–60
  b3: ExactDecimal; // 61–90
  b4: ExactDecimal; // 90+
  total: ExactDecimal;
  /**
   * The reconciling line: control-account balance that no open document
   * explains (a manual journal credited to AR or debited to AP without an
   * invoice or bill behind it). Its total is part of the control tie, never
   * part of any document's open.
   */
  reconciling?: boolean;
  /** Reconciling rows only: the journal entries behind the balance, in the row's sign. */
  entries?: UnopenedControlEntry[];
}

/** One journal entry making up a reconciling line, presented in the reporting currency. */
export interface UnopenedControlEntry {
  entryId: string;
  entryNumber: string | null;
  postingDate: string;
  memo: string | null;
  partyName: string | null;
  amount: ExactDecimal;
}

export interface AgingResult {
  rows: AgingRow[];
  totals: Omit<AgingRow, "partyId" | "partyName">;
  asOf: string;
  basis: AgingCurrencyBasis;
  reportingCurrency: string;
}

/**
 * Currency basis for aging conversion (Intacct model: a REPORTING CURRENCY
 * selector plus a "convert from" basis toggle).
 *
 * - `base`: convert each line's FUNCTIONAL (stored base) open at the as-of
 *   spot. Ties to the GL control; the default — finance teams may have filed
 *   against these numbers, so nothing moves silently.
 * - `transaction`: rebuild the open in each document's own TRANSACTION
 *   currency (gross txn lines minus applied txn legs, as of the report date)
 *   and convert at the as-of spot. Answers "what the customer owes in their
 *   own money, expressed in mine".
 *
 * Both bases rebuild as of the report date from stored dual-recorded amounts
 * (`jl.amount` / `jl.txn_amount`, `applications.amount` /
 * `source/target_transaction_amount`) — never by re-translating at document
 * FX, which drifts from the posted ledger by dust.
 */
export type AgingCurrencyBasis = "base" | "transaction";

export type AgingBucket = "current" | "b1" | "b2" | "b3" | "b4"

export interface AgingOptions {
  /** Default "base": the numbers booked to date, unchanged. */
  basis?: AgingCurrencyBasis;
  /** Default the org base currency. Must be base or an in-scope txn currency. */
  reportingCurrency?: string;
  /** Drill scope: rebuild only this party's open documents. */
  partyId?: string;
  /** Drill scope: rebuild only party-less open documents (the "(no party)"
   * row). Kept separate from an absent filter, which rebuilds everything. */
  partyIsNull?: boolean;
  /** Drill scope: rebuild only this age bucket. Matches `bucketOf`. */
  bucket?: AgingBucket;
  /**
   * One accounting book per read (primary when omitted) — the same one-book
   * contract as every other journal reader. Without this a parallel book's
   * mirror entries fuse into the aging while the sibling statement readers
   * stay primary-only.
   */
  bookId?: string | null;
}

/** A needed spot rate has no coverage on or before the as-of date. The
 * caller maps this to the rates-blocked banner instead of throwing numbers. */
export class AgingRatesUnavailableError extends Error {
  readonly missing: string[];
  readonly reportingCurrency: string;
  readonly asOf: string;
  constructor(missing: string[], reportingCurrency: string, asOf: string) {
    super(`no spot rate for ${missing.join(", ")}→${reportingCurrency} on or before ${asOf}`);
    this.name = "AgingRatesUnavailableError";
    this.missing = missing;
    this.reportingCurrency = reportingCurrency;
    this.asOf = asOf;
  }
}

/**
 * Per-party document aging rebuilt from posted open-item journal lines, never
 * from the live `documents.open_balance` cache: a later settlement must not
 * rewrite a past aging, so gross lines minus applications dated on/before
 * the report date is the only reconstruction that reproduces history.
 * Imported cutover AR/AP is safe under this rebuild because a cache-only
 * posted document cannot exist: the schema requires every posted document to
 * carry a posted entry (`documents_posted_period_required`), `open_balance`
 * itself is derived from that entry's lines (never imported as a bare
 * value), and the sync mirror posts native documents through the same
 * posting kernel. Credits reduce the party balance.
 *
 * Opens derive from STORED base amounts — the journal line's own `amount`
 * and the application's base carrying amount (`applications.amount`) — never
 * by re-translating transaction amounts at document FX. A recomputed
 * txn × fx open drifts from the posted ledger whenever settlement and
 * document rates differ (or per-line posting rounding accumulates), so the
 * aging would disagree with its own control account by dust no reader can
 * explain (AR aging CA$0.01 over GL 1030).
 *
 * Documents are not the whole control account: unapplied receipts, direct
 * control journals, and legacy partyless opening balances post control lines
 * with no invoice/credit document behind them. Those balances appear as an
 * explicit reconciling line per party (see controlResiduals), so the aging
 * total always ties to the control.
 */
/**
 * One open document as rebuilt from stored dual-recorded amounts: the signed
 * functional open AND the signed transaction-currency open, side by side.
 * Both readers (summary, detail) share this one rebuild — the basis toggle
 * only chooses which leg converts to the reporting currency.
 *
 * The rebuild admits only counterparty-side control lines (0171):
 * personal expense lines post open employee-receivable debits that still
 * carry the expense_report kind, and the legs below enter through abs() — so
 * without the account gate a personal balance would age on the AP side as
 * money owed TO the employee. Company-paid card legs stay out one layer
 * down, through the posting invariant (never stamped is_open_item).
 */
interface OpenDocument {
  docId: string;
  kind: string;
  partyId: string | null;
  partyName: string | null;
  reference: string | null;
  due: string | null;
  ageBasisDate: string;
  ageBasisSource: 'due_date' | 'posting_date' | 'document_date';
  ageDays: number;
  docCurrency: string;
  txnCcy: string;
  funcCcy: string;
  openBase: string;
  openTxn: string;
}

/**
 * Document kinds that age as NEGATIVE opens against the side's control: credit
 * memos plus the settlement documents that relieve them. A payment applied to
 * a bill must net against it inside this one rebuild, and its unapplied
 * remainder ages here as its own negative document — never as an unattributed
 * Current lump through the control residual (which sees only the net) and
 * never omitted from the detail (which reads documents only). Without this a
 * settled bill drops out while its payment survives only in the residual, so
 * the summary shows a negative Current bucket and the detail header reads
 * bills gross against a smaller closing balance.
 *
 * Aging-only scope, deliberately NOT in the shared open-item kinds const: the
 * operational tiles forecast cash need from collectible/payable lines, and
 * paid cash is already out the door — a payment remainder there would
 * double-count the outflow. Aging ties to the CONTROL account, so it must
 * carry every control leg, including settlement remainders.
 */
const AP_NEGATIVE_KINDS = ["vendor_credit", "vendor_payment", "check"] as const;
const AR_NEGATIVE_KINDS = ["customer_credit", "customer_payment"] as const;

function agingKinds(side: AgingSide): { kinds: readonly string[]; negativeKinds: readonly string[] } {
  // Population is the shared open-item kinds const (the same doorway as the
  // tiles/cockpits) plus this side's settlement documents, which post
  // open-item control legs when they relieve the balances above.
  const base = side === "ap" ? AP_OPEN_ITEM_KINDS : AR_OPEN_ITEM_KINDS;
  const negativeKinds = side === "ap" ? AP_NEGATIVE_KINDS : AR_NEGATIVE_KINDS;
  const extra = negativeKinds.filter((kind) => !(base as readonly string[]).includes(kind));
  return { kinds: [...base, ...extra], negativeKinds };
}

function openDocumentsSql(
  side: AgingSide,
  asOf: string,
  dims: DimFilter | undefined,
  orgId: string,
  orgBase: string,
  kinds: readonly string[],
  negativeKinds: readonly string[],
  scope?: { partyId?: string; partyIsNull?: boolean; bucket?: AgingBucket; bookId?: string | null },
): SQL {
  // Account gate: the AP side admits liability_payable lines plus the
  // designated employee-payable control (preset-typed liability_current_other,
  // where OOP reports actually post); the AR side admits asset_receivable.
  // Same scope object the dashboard tile reads — one shared answer to which
  // open items are payables, not a second list.
  const accountScope = side === "ap"
    ? apOpenAccountScope(sql`a`, orgId)
    : arOpenAccountScope(sql`a`);
  return sql`
    -- The open is reconstructed AS OF the report date — gross open-item
    -- lines minus applications dated on/before it — never the live cached
    -- balance: a later settlement must not rewrite a past aging (or
    -- month-end history would never reproduce).
    -- Applications are a per-line LATERAL (indexed from/to line id), not a
    -- bulk CTE joined back onto every open-item line. RLS on applications
    -- hides cardinality from the planner; the bulk join was estimated at
    -- one row and became an 8-million-pair nested loop. MATERIALIZED
    -- doc_lines forces the posted/as-of/party/bucket filter first so the
    -- lateral only probes lines that can still be open. Only documents the
    -- open-item index holds open on the date (or touched by a later
    -- application) are rebuilt: every other document nets to zero there.
    -- Both currency legs rebuild here: the functional leg (stored base
    -- amounts and base carrying amounts — never re-translated, so the aging
    -- ties its control by construction) and the transaction leg (stored txn
    -- amounts and txn application legs). Which leg converts is the basis
    -- toggle, decided in JS below — the SQL stays one rebuild.
    with doc_lines as materialized (
      select d.id as doc_id, d.kind, d.party_id, d.document_number,
             d.due_date::text as due,
             coalesce(d.due_date, d.posting_date, d.document_date)::text as age_basis_date,
             case when d.due_date is not null then 'due_date'
                  when d.posting_date is not null then 'posting_date' else 'document_date' end as age_basis_source,
             (${asOf}::date - coalesce(d.due_date, d.posting_date, d.document_date))::int as age_days,
             d.currency as doc_currency,
             jl.id as line_id,
             abs(jl.amount) as base_gross, abs(jl.txn_amount) as txn_gross,
             jl.currency as txn_ccy,
             coalesce(sub.base_currency, ${orgBase}) as func_ccy
        from documents d
        -- The entry that carried the document on the report date, not the live
        -- posted entry: a reversal dated on or before the date removes it
        -- (including a void recorded later but dated back), the same rule the
        -- control residual and the cash open items read, so the document rows
        -- and the control account always describe the same ledger.
        ${asOfPostedEntryLateral(orgId, asOf)}
        -- Each document's own lines, looked up by its entry: joining the
        -- control accounts' lines as a set reads every line they ever held.
        -- OFFSET 0 keeps the planner from flattening the lookup back into
        -- that set join.
        join lateral (
          select jl.* from journal_lines jl
           where jl.entry_id = je.id and jl.org_id = ${orgId} and jl.is_open_item
          offset 0
        ) jl on true
        join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = ${orgId}
        left join subsidiaries sub on sub.id = jl.subsidiary_id and sub.org_id = ${orgId}
       where d.org_id = ${orgId}
         and d.id in (${openItemCandidateDocumentsSql({ orgId, asOf, accounts: accountScope })})
         and (d.status = 'posted' or (d.voided_at is not null and d.voided_at::date > ${asOf}::date))
         and d.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})
         and ${accountScope}
         and e.book_id in ${statementBookIdsExpr(orgId, scope?.bookId)}
         and coalesce(d.posting_date, d.document_date) <= ${asOf}
         and ${dimWhere(dims, sql`d`)}
         ${scope?.partyId ? sql`and d.party_id = ${scope.partyId}` : scope?.partyIsNull ? sql`and d.party_id is null` : sql``}
         and ${agingBucketSql(asOf, scope?.bucket)}
    ),
    open_docs as (
      select dl.doc_id, dl.kind, dl.party_id, dl.document_number, dl.due, dl.age_basis_date, dl.age_basis_source, dl.age_days,
             dl.doc_currency, dl.txn_ccy, dl.func_ccy,
             -- Credits and settlement remainders present negative: a payment's
             -- open is its UNAPPLIED remainder (gross control leg minus dated
             -- applications), so a fully applied payment nets to zero and drops
             -- out alongside the bill it relieved.
             (case when dl.kind in (${sql.join(negativeKinds.map((kind) => sql`${kind}`), sql`, `)}) then -1 else 1 end)
               * (sum(dl.base_gross) - coalesce(sum(al.applied_base), 0)) as open_base,
             (case when dl.kind in (${sql.join(negativeKinds.map((kind) => sql`${kind}`), sql`, `)}) then -1 else 1 end)
               * (sum(dl.txn_gross) - coalesce(sum(al.applied_txn), 0)) as open_txn
        from doc_lines dl
        left join lateral (
          -- Each leg consumes its own carrying columns (the shared engine
          -- helper, the same caps app_check_open enforces): the to-leg settles
          -- the target line in amount / target_transaction_amount, the from-leg
          -- consumes the source line in source_amount / source_transaction_amount.
          -- No FX re-translation on either side. OR on from/to uses the existing
          -- line-id indexes.
          select
            coalesce(sum(${appliedLegAmountExpr("a", sql`dl.line_id`, "base")}), 0) as applied_base,
            coalesce(sum(${appliedLegAmountExpr("a", sql`dl.line_id`, "transaction")}), 0) as applied_txn
          from applications a
          where a.org_id = ${orgId}
            and a.applied_on <= ${asOf}
            and (a.unapplied_at is null or a.unapplied_at::date > ${asOf}::date)
            and (a.from_line_id = dl.line_id or a.to_line_id = dl.line_id)
        ) al on true
       group by dl.doc_id, dl.kind, dl.party_id, dl.document_number, dl.due, dl.age_basis_date, dl.age_basis_source,
                dl.age_days, dl.doc_currency, dl.txn_ccy, dl.func_ccy
      -- Settlement completeness is a ledger (base-leg) question under both
      -- bases, so the population rule never moves with the toggle: the base
      -- report reads exactly the documents it always has.
      having (sum(dl.base_gross) - coalesce(sum(al.applied_base), 0)) > 0
    )
    select od.doc_id, od.kind, od.party_id, p.display_name as party_name,
           od.document_number as reference, od.due, od.age_basis_date, od.age_basis_source, od.age_days,
           od.doc_currency, od.txn_ccy, od.func_ccy,
           od.open_base, od.open_txn
      from open_docs od
      left join parties p on p.id = od.party_id and p.org_id = ${orgId}
     where abs(od.open_base) > 0
  `;
}

interface OpenDocumentSource extends Record<string, unknown> {
  doc_id: string; kind: string; party_id: string | null; party_name: string | null;
  reference: string | null; due: string | null; age_days: number;
  age_basis_date: string; age_basis_source: OpenDocument['ageBasisSource'];
  doc_currency: string; txn_ccy: string; func_ccy: string;
  open_base: string; open_txn: string;
}

async function openDocuments(...args: Parameters<typeof openDocumentsSql>): Promise<OpenDocument[]> {
  const r = await db.execute<OpenDocumentSource>(sql`select * from (${openDocumentsSql(...args)}) document_rows
    order by party_name nulls last, age_days desc, doc_id`, "objects");
  return r.map((x) => ({
    docId: x.doc_id,
    kind: x.kind,
    partyId: x.party_id,
    partyName: x.party_name,
    reference: x.reference,
    due: x.due,
    ageBasisDate: x.age_basis_date,
    ageBasisSource: x.age_basis_source,
    ageDays: x.age_days,
    docCurrency: x.doc_currency,
    txnCcy: x.txn_ccy,
    funcCcy: x.func_ccy,
    openBase: x.open_base,
    openTxn: x.open_txn,
  }));
}

/** Translate one native open to the reporting currency at the as-of spot.
 * Same-currency legs resolve 1:1 with no rate row — the landed single-currency
 * path stays exactly correct. `mulDecimal` reads 10dp rates exactly and
 * rounds half-away to ledger scale, the same conversion the cash readers use. */
function convertOpen(
  native: string,
  from: string,
  target: string,
  rates: Map<string, string>,
): ExactDecimal {
  if (from === target) return native as ExactDecimal;
  return mulDecimal(native, rates.get(from)!) as ExactDecimal;
}

async function missingSpotCoverage(
  orgId: string,
  target: string,
  needed: Set<string>,
  asOf: string,
): Promise<string[]> {
  const list = [...needed].filter((c) => c !== target);
  if (list.length === 0) return [];
  const r = await db.execute<{ ccy: string }>(sql`
    select c as ccy from unnest(${"{" + list.join(",") + "}"}::text[]) as c
     where not exists (
       select 1 from fx_rates
        where org_id = ${orgId} and rate_type = 'spot' and as_of <= ${asOf}::date
          and ((from_currency = c and to_currency = ${target})
            or (from_currency = ${target} and to_currency = c))
     )`, "objects");
  return r.map((x) => x.ccy);
}

export async function agingByParty(
  side: AgingSide,
  asOf: string,
  dims?: DimFilter,
  orgId?: string,
  opts?: AgingOptions,
): Promise<AgingResult> {
  const resolvedOrgId = await resolveOrgId(orgId);
  // Population is the shared open-item kinds const — the same doorway as the
  // tiles/cockpits, so an outstanding expense report ages here instead of
  // reaching the total only through the control residual (F-u1-P5.1) — plus
  // this side's settlement documents, whose unapplied remainders age as
  // negative documents in this same rebuild.
  const { kinds, negativeKinds } = agingKinds(side);
  const basis: AgingCurrencyBasis = opts?.basis ?? "base";
  const orgBase = await presentationCurrency(resolvedOrgId);
  const target = opts?.reportingCurrency ?? orgBase;
  const docs = await openDocuments(side, asOf, dims, resolvedOrgId, orgBase, kinds, negativeKinds, {
    bookId: opts?.bookId,
  });
  const { residuals, unopenedLines } = await controlResiduals(side, asOf, dims, resolvedOrgId, orgBase, opts?.bookId);
  // A document currency with no spot must never block the BASE report (it
  // converts nothing through it): only request the legs this basis reads,
  // plus the functional legs the residual always needs.
  const needed = new Set<string>();
  for (const d of docs) needed.add(basis === "transaction" ? d.txnCcy : d.funcCcy);
  for (const res of residuals) needed.add(res.funcCcy);
  needed.delete(target);
  let rates = new Map<string, string>();
  if (needed.size > 0) {
    try {
      rates = await presentationRates(resolvedOrgId, target, needed, asOf);
    } catch {
      throw new AgingRatesUnavailableError(
        await missingSpotCoverage(resolvedOrgId, target, needed, asOf),
        target,
        asOf,
      );
    }
  }
  const convert = (native: string, from: string): ExactDecimal => convertOpen(native, from, target, rates);
  const byParty = new Map<string | null, AgingRow>();
  for (const d of docs) {
    const open = convert(basis === "transaction" ? d.openTxn : d.openBase, basis === "transaction" ? d.txnCcy : d.funcCcy);
    if (decimalCmp(open, ZERO) === 0) continue;
    const bucket = bucketOf(d.ageDays);
    let row = byParty.get(d.partyId);
    if (!row) {
      row = { partyId: d.partyId, partyName: d.partyName, current: ZERO, b1: ZERO, b2: ZERO, b3: ZERO, b4: ZERO, total: ZERO };
      byParty.set(d.partyId, row);
    }
    row[bucket] = decimalAdd(row[bucket], open);
    row.total = decimalAdd(row.total, open);
  }
  const rows: AgingRow[] = [...byParty.values()];
  await foldControlResidual(side, resolvedOrgId, rows, docs, residuals, unopenedLines, convert);
  // Reconciling lines sort after the document rows; within each group the
  // rows read in abs(total)-descending order.
  rows.sort((x, y) => Number(x.reconciling === true) - Number(y.reconciling === true) || compareAbsoluteDescending(x.total, y.total));
  const totals = rows.reduce(
    (a, r) => ({
      current: decimalAdd(a.current, r.current),
      b1: decimalAdd(a.b1, r.b1),
      b2: decimalAdd(a.b2, r.b2),
      b3: decimalAdd(a.b3, r.b3),
      b4: decimalAdd(a.b4, r.b4),
      total: decimalAdd(a.total, r.total),
    }),
    { current: ZERO, b1: ZERO, b2: ZERO, b3: ZERO, b4: ZERO, total: ZERO },
  );
  return { rows, totals, asOf, basis, reportingCurrency: target };
}

/**
 * Control-account balance that no open document explains becomes a reconciling
 * line, never part of a party's document row. Unapplied receipts, direct
 * control journals, and legacy partyless opening balances post control lines
 * outside the document population above; without this the aging silently
 * understates the control (SIM AR CA$503,288 aged vs CA$687,038 on GL 1100).
 * Each residual is one "Control-account entries without an open item" row per
 * party (the partyless row when no party is stamped). The row lists the
 * journal entries behind it, so the bookkeeper can see the entry that breaks
 * the subledger tie. Keeping the residual out of party rows means a
 * customer's document total always equals that customer's open invoices.
 * The residual lands in `current` — an undated balance has no age to bucket
 * by. Exact ties produce no row at all, so a clean subledger reads exactly as
 * before.
 *
 * Scope boundaries. First, one book per read: the document side above joins
 * each line's entry and keeps the primary (or selected) book, so the control
 * side answers in that same scope — reading every book on either side would
 * double-count parallel-book mirrors. Second, document dims attribute by
 * document HEADER while control lines attribute by LINE (one invoice, lines in
 * many departments): under department/project/location/class/segment filters
 * the two populations partition differently and control-minus-docs is not
 * attributable per party, so the reconciling line stays out and the aging
 * reads documents only. Subsidiary stamps ride on documents and lines
 * together, so subsidiary-scoped reads keep the reconciling line. Third, the
 * control side uses the same account scope as the document side (0171): the
 * AP control counts liability_payable accounts plus the designated
 * employee-payable control, so newly aged OOP reports cancel out of the
 * residual instead of being netted back off it; the AR control excludes the
 * designated employee-receivable account, whose personal balances age nowhere
 * by design (see arResidualAccountScope).
 */
interface ControlResidual {
  partyId: string | null;
  funcCcy: string;
  bal: string;
}

/**
 * One control journal line that no open document carries as of the report
 * date, with the part of it still unapplied (`remainder`, signed as the
 * control balance). The remainders of a party's lines sum to that party's
 * reconciling balance; lines fully applied by a document or a receipt drop
 * out, so an applied receipt never appears as an unexplained entry.
 */
interface UnopenedControlLine {
  partyId: string | null;
  partyName: string | null;
  entryId: string;
  entryNumber: string | null;
  postingDate: string;
  memo: string | null;
  funcCcy: string;
  remainder: string;
}

async function controlResiduals(
  side: AgingSide,
  asOf: string,
  dims: DimFilter | undefined,
  orgId: string,
  orgBase: string,
  bookId?: string | null,
): Promise<{ residuals: ControlResidual[]; unopenedLines: () => Promise<UnopenedControlLine[]> }> {
  const noLines = async (): Promise<UnopenedControlLine[]> => [];
  if (
    dims?.departmentId || dims?.projectId || dims?.locationId || dims?.classId ||
    (dims?.segments && Object.keys(dims.segments).length > 0)
  ) {
    return { residuals: [], unopenedLines: noLines };
  }
  // The control side reads the SAME account scope as the document side above:
  // the AP control counts liability_payable plus the designated
  // employee-payable control, so newly aged OOP reports cancel out of the
  // residual instead of being netted back off it; the AR control excludes
  // the designated employee-receivable account, whose personal balances age
  // nowhere by design and must not land as document-less AR rows.
  const controlScope = side === "ap"
    ? apOpenAccountScope(sql`a`, orgId)
    : arResidualAccountScope(sql`a`, orgId);
  const control = await db.execute<{ party_id: string | null; func_ccy: string; bal: string }>(sql`
    select l.party_id, coalesce(sub.base_currency, ${orgBase}) as func_ccy, coalesce(sum(l.amount), 0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
     where l.org_id = ${orgId} and ${controlScope} and e.posting_date <= ${asOf}
       and e.book_id in ${statementBookIdsExpr(orgId, bookId)}
       and ${dimWhere(dims)}
     -- Ordinal, not a repeated expression: the SELECT's coalesce carries a
     -- different bind parameter per occurrence, which GROUP BY will not match.
     group by l.party_id, 2
  `, "objects");
  const residuals = control.map((c) => ({ partyId: c.party_id, funcCcy: c.func_ccy, bal: c.bal }));
  // The journal-entry listing is read only once a reconciling balance is
  // known to exist (see foldControlResidual), so a tied subledger pays nothing.
  return {
    residuals,
    unopenedLines: () => unopenedControlLines(side, asOf, dims, orgId, orgBase, bookId),
  };
}

/**
 * The journal entries behind the reconciling line: control lines the
 * open-item rebuild does not carry as of the report date, each reduced by
 * the amount applied to it as of that date. Carried lines are the same
 * population the document side reads (a document of a side kind, posted or
 * voided after the date, whose as-of entry holds the open-item line), so the
 * two sides partition the control with no line counted twice.
 */
async function unopenedControlLines(
  side: AgingSide,
  asOf: string,
  dims: DimFilter | undefined,
  orgId: string,
  orgBase: string,
  bookId?: string | null,
): Promise<UnopenedControlLine[]> {
  const controlScope = side === "ap"
    ? apOpenAccountScope(sql`a`, orgId)
    : arResidualAccountScope(sql`a`, orgId);
  const { kinds } = agingKinds(side);
  const r = await db.execute<{
    party_id: string | null; party_name: string | null; entry_id: string; entry_number: string | null;
    posting_date: string; memo: string | null; func_ccy: string; remainder: string;
  }>(sql`
    with control_lines as (
      select l.id as line_id, l.amount, l.party_id, e.id as entry_id, e.entry_number,
             e.posting_date::text as posting_date, e.memo,
             coalesce(sub.base_currency, ${orgBase}) as func_ccy
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
        left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
       where l.org_id = ${orgId} and ${controlScope} and e.posting_date <= ${asOf}
         and e.book_id in ${statementBookIdsExpr(orgId, bookId)}
         and ${dimWhere(dims)}
         -- An open-item line settled on the date leaves no remainder, so
         -- only the open-item lines the index holds open (or a later
         -- application touched) can reconcile; other control lines always
         -- can.
         and (not l.is_open_item
              or l.id in (${openItemCandidateLinesSql({ orgId, asOf, accounts: controlScope })}))
         -- Carried: the line's entry is the one carrying a document of this
         -- side on the date, which can only be a document that entry posts.
         and not (l.is_open_item and exists (
           select 1 from documents d
           ${asOfPostedEntryLateral(orgId, asOf)}
          where d.org_id = ${orgId}
            and (d.id = e.source_document_id or d.posted_entry_id = e.id)
            and je.id = e.id
            and d.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})
            and (d.status = 'posted' or (d.voided_at is not null and d.voided_at::date > ${asOf}::date))
            and coalesce(d.posting_date, d.document_date) <= ${asOf}
            and ${dimWhere(dims, sql`d`)}
         ))
    ), remainders as (
      select cl.*, ${datedAppliedAmountSql(orgId, sql`cl.line_id`, asOf)} as consumed
        from control_lines cl
    )
    select rm.party_id, p.display_name as party_name, rm.entry_id, rm.entry_number, rm.posting_date,
           rm.memo, rm.func_ccy,
           sum(rm.amount - (case when rm.amount < 0 then -1 else 1 end) * rm.consumed)::text as remainder
      from remainders rm
      left join parties p on p.id = rm.party_id and p.org_id = ${orgId}
     group by rm.party_id, p.display_name, rm.entry_id, rm.entry_number, rm.posting_date, rm.memo, rm.func_ccy
    having sum(rm.amount - (case when rm.amount < 0 then -1 else 1 end) * rm.consumed) <> 0
     order by rm.posting_date, rm.entry_number nulls last, rm.entry_id
  `, "objects");
  return r.map((x) => ({
    partyId: x.party_id,
    partyName: x.party_name,
    entryId: x.entry_id,
    entryNumber: x.entry_number,
    postingDate: x.posting_date,
    memo: x.memo,
    funcCcy: x.func_ccy,
    remainder: x.remainder,
  }));
}

async function foldControlResidual(
  side: AgingSide,
  orgId: string,
  rows: AgingRow[],
  docs: OpenDocument[],
  residuals: ControlResidual[],
  unopenedLines: () => Promise<UnopenedControlLine[]>,
  convert: (native: string, from: string) => ExactDecimal,
): Promise<void> {
  if (residuals.length === 0) return;
  // Document opens net per (party, functional): the residual is a
  // functional-space concept (control minus document BASE opens) under both
  // bases — undocumented balances have no transaction currency, so they
  // translate at the as-of spot like every other functional leg.
  const docBase = new Map<string, ExactDecimal>();
  for (const d of docs) {
    const key = `${d.partyId ?? "\0"}‖${d.funcCcy}`;
    docBase.set(key, decimalAdd(docBase.get(key) ?? ZERO, d.openBase as ExactDecimal));
  }
  const residualByParty = new Map<string | null, ExactDecimal>();
  for (const c of residuals) {
    // AP control is credit-normal; present it positive like the document opens.
    const presented = (side === "ap" ? decimalNeg(c.bal) : c.bal) as ExactDecimal;
    const residual = decimalSubtract(presented, docBase.get(`${c.partyId ?? "\0"}‖${c.funcCcy}`) ?? ZERO);
    if (decimalCmp(residual, ZERO) === 0) continue;
    const key = c.partyId;
    residualByParty.set(key, decimalAdd(residualByParty.get(key) ?? ZERO, convert(residual, c.funcCcy)));
  }
  if (residualByParty.size === 0) return;
  const entriesByParty = new Map<string | null, UnopenedControlEntry[]>();
  for (const line of await unopenedLines()) {
    const presented = (side === "ap" ? decimalNeg(line.remainder) : line.remainder) as ExactDecimal;
    const list = entriesByParty.get(line.partyId) ?? [];
    list.push({
      entryId: line.entryId,
      entryNumber: line.entryNumber,
      postingDate: line.postingDate,
      memo: line.memo,
      partyName: line.partyName,
      amount: convert(presented, line.funcCcy),
    });
    entriesByParty.set(line.partyId, list);
  }
  const partyIds = [...residualByParty.keys()].filter((id): id is string => id !== null);
  const names = new Map<string, string | null>();
  if (partyIds.length > 0) {
    const named = await db.execute<{ id: string; display_name: string | null }>(sql`
      select p.id, p.display_name from parties p
       where p.org_id = ${orgId} and p.id = any(${`{${partyIds.join(",")}}`}::uuid[])
    `, "objects");
    for (const n of named) names.set(n.id, n.display_name);
  }
  for (const [partyId, residual] of residualByParty) {
    if (decimalCmp(residual, ZERO) === 0) continue;
    rows.push({
      partyId,
      partyName: partyId === null ? null : names.get(partyId) ?? null,
      current: residual,
      b1: ZERO,
      b2: ZERO,
      b3: ZERO,
      b4: ZERO,
      total: residual,
      reconciling: true,
      entries: entriesByParty.get(partyId) ?? [],
    });
  }
}

// ---------------------------------------------------------------------------
// AR / AP Aging Detail — one row per open item (invoice/bill), bucketed
// ---------------------------------------------------------------------------

export interface AgingDetailRow {
  docId: string
  docKind: string
  partyId: string | null
  partyName: string | null
  reference: string | null
  dueDate: string | null
  ageBasisDate: string
  ageBasisSource: OpenDocument['ageBasisSource']
  ageDays: number
  bucket: AgingBucket
  open: ExactDecimal
  /** The document's own currency, always shown whatever basis is selected. */
  docCurrency: string
  /** The open rebuilt in the document's own currency (unconverted) — the
   * "what the customer actually owes" leg, always shown alongside `open`. */
  txnOpen: ExactDecimal
}
export interface AgingDetailResult {
  rows: AgingDetailRow[]
  totals: Record<AgingBucket, ExactDecimal> & { total: ExactDecimal }
  asOf: string
  basis: AgingCurrencyBasis
  reportingCurrency: string
}

const AGING_BUCKET_KEYS = ["current", "b1", "b2", "b3", "b4"] as const satisfies readonly AgingBucket[]

export function bucketOf(age: number): AgingBucket {
  return AGING_BUCKET_KEYS[agingBucketIndex(age)]
}

/** SQL predicate that matches `bucketOf` exactly — including `b3` as age < 90. */
function agingBucketSql(asOf: string, bucket?: AgingBucket) {
  if (!bucket) return sql`true`
  const age = sql`(${asOf}::date - coalesce(d.due_date, d.posting_date, d.document_date))`
  if (bucket === "current") return sql`${age} <= 0`
  if (bucket === "b1") return sql`${age} > 0 and ${age} <= 30`
  if (bucket === "b2") return sql`${age} > 30 and ${age} <= 60`
  if (bucket === "b3") return sql`${age} > 60 and ${age} < 90`
  return sql`${age} >= 90`
}

/**
 * Per-open-item aging: the same canonical document-balance logic as
 * `agingByParty`, but one row per document rather than aggregated per party.
 * Credits and settlement remainders are negative open items so the detail
 * and summary always tie.
 */
export async function agingDetail(
  side: AgingSide,
  asOf: string,
  dims?: DimFilter,
  orgId?: string,
  opts?: AgingOptions,
): Promise<AgingDetailResult> {
  const resolvedOrgId = await resolveOrgId(orgId);
  // Same shared population as the summary above — detail and summary always tie.
  // The account gate rides inside the shared rebuild, so detail rows inherit
  // it: personal lines never surface here either.
  const { kinds, negativeKinds } = agingKinds(side)
  const basis: AgingCurrencyBasis = opts?.basis ?? "base";
  const orgBase = await presentationCurrency(resolvedOrgId);
  const target = opts?.reportingCurrency ?? orgBase;
  // The same shared rebuild as the summary — detail rows can never disagree
  // with the summary buckets per document. Deliberately documents-only:
  // control balances with no open item behind them (direct control journals)
  // surface on the summary residual row, never here. Settlement remainders
  // are documents, so they read here as their own negative lines.
  const docs = await openDocuments(side, asOf, dims, resolvedOrgId, orgBase, kinds, negativeKinds, {
    partyId: opts?.partyId,
    partyIsNull: opts?.partyIsNull,
    bucket: opts?.bucket,
    bookId: opts?.bookId,
  });
  const needed = new Set<string>();
  for (const d of docs) needed.add(basis === "transaction" ? d.txnCcy : d.funcCcy);
  needed.delete(target);
  let rates = new Map<string, string>();
  if (needed.size > 0) {
    try {
      rates = await presentationRates(resolvedOrgId, target, needed, asOf);
    } catch {
      throw new AgingRatesUnavailableError(
        await missingSpotCoverage(resolvedOrgId, target, needed, asOf),
        target,
        asOf,
      );
    }
  }
  return presentAgingDetail(docs, basis, target, asOf, rates)
}

export interface AgingDetailPageResult extends AgingDetailResult {
  total: number
  page: number
  perPage: number
}

/** Rebuild once in SQL, retain exact full-scope totals, and transfer only the
 * requested page. Conversion still occurs per document before summation. */
export async function agingDetailPage(
  side: AgingSide,
  asOf: string,
  dims: DimFilter | undefined,
  orgId: string,
  opts: AgingOptions,
  window: { page: number; perPage: number },
): Promise<AgingDetailPageResult> {
  if (!Number.isSafeInteger(window.page) || window.page < 1
    || !Number.isSafeInteger(window.perPage) || window.perPage < 1 || window.perPage > 500
    || !Number.isSafeInteger((window.page - 1) * window.perPage)) {
    throw new RangeError('Aging pages require a positive page and a page size from 1 to 500.')
  }
  const resolvedOrgId = await resolveOrgId(orgId)
  const orgBase = await presentationCurrency(resolvedOrgId)
  const basis = opts.basis ?? 'base'
  const target = opts.reportingCurrency ?? orgBase
  const currency = basis === 'transaction' ? sql`od.txn_ccy` : sql`od.func_ccy`
  const amount = basis === 'transaction' ? sql`od.open_txn` : sql`od.open_base`
  // The same shared population as every other aging reader — a paged detail
  // row can never disagree with the summary buckets per document.
  const { kinds: pageKinds, negativeKinds: pageNegativeKinds } = agingKinds(side)
  const result = await db.execute<{
    rows: AgingDetailRow[] | null; total: string; totals: Record<string, string>; missing: string[] | null
  }>(sql`
    with open_document_rows as materialized (
      ${openDocumentsSql(side, asOf, dims, resolvedOrgId, orgBase,
        pageKinds, pageNegativeKinds, opts)}
    ), currencies as (
      select distinct ${currency} as ccy from open_document_rows od where ${currency} <> ${target}
    ), rates as (
      ${presentationSpotRatesSql(resolvedOrgId, target, sql`select ccy from currencies`, asOf)}
    ), presented as materialized (
      select od.*, ${currency} as source_currency,
        ${presentationAmountSql(amount, currency, target, sql`r.rate::numeric`)} as presented_open,
        case when od.age_days <= 0 then 'current' when od.age_days <= 30 then 'b1'
             when od.age_days <= 60 then 'b2' when od.age_days < 90 then 'b3' else 'b4' end as bucket
      from open_document_rows od left join rates r on r.from_currency = ${currency}
    ), visible as materialized (
      select * from presented where presented_open <> 0
    )
    select (select jsonb_agg(jsonb_build_object(
        'docId', selected.doc_id, 'docKind', selected.kind,
        'partyId', selected.party_id, 'partyName', selected.party_name,
        'reference', selected.reference, 'dueDate', selected.due,
        'ageBasisDate', selected.age_basis_date, 'ageBasisSource', selected.age_basis_source,
        'ageDays', selected.age_days, 'bucket', selected.bucket,
        'open', selected.presented_open::text, 'docCurrency', selected.doc_currency,
        'txnOpen', selected.open_txn::text
      ) order by selected.party_name nulls last, selected.age_days desc, selected.doc_id)
      from (select * from visible order by party_name nulls last, age_days desc, doc_id
        limit ${window.perPage} offset ${(window.page - 1) * window.perPage}) selected) as rows,
      count(*)::text as total,
      jsonb_build_object(
        'current', coalesce(sum(presented_open) filter (where bucket='current'),0)::text,
        'b1', coalesce(sum(presented_open) filter (where bucket='b1'),0)::text,
        'b2', coalesce(sum(presented_open) filter (where bucket='b2'),0)::text,
        'b3', coalesce(sum(presented_open) filter (where bucket='b3'),0)::text,
        'b4', coalesce(sum(presented_open) filter (where bucket='b4'),0)::text,
        'total', coalesce(sum(presented_open),0)::text
      ) as totals,
      (select array_agg(distinct source_currency order by source_currency)
        from presented where source_currency <> ${target} and presented_open is null) as missing
    from visible
  `, "objects")
  const data = result[0]
  if (!data) throw new Error('The aging query did not return its totals.')
  if (data.missing?.length) throw new AgingRatesUnavailableError(data.missing, target, asOf)
  const totals = Object.fromEntries(['current', 'b1', 'b2', 'b3', 'b4', 'total'].map((key) => [key, decimalAdd(ZERO, data.totals[key]!)])) as AgingDetailResult['totals']
  return { rows: data.rows ?? [], total: Number(data.total), totals, asOf, basis, reportingCurrency: target, ...window }
}

function presentAgingDetail(
  docs: OpenDocument[],
  basis: AgingCurrencyBasis,
  target: string,
  asOf: string,
  rates: Map<string, string>,
): AgingDetailResult {
  const totals: Record<AgingBucket, ExactDecimal> & { total: ExactDecimal } = { current: ZERO, b1: ZERO, b2: ZERO, b3: ZERO, b4: ZERO, total: ZERO }
  const rows: AgingDetailRow[] = []
  for (const d of docs) {
    const open = convertOpen(basis === "transaction" ? d.openTxn : d.openBase, basis === "transaction" ? d.txnCcy : d.funcCcy, target, rates)
    if (decimalCmp(open, ZERO) === 0) continue;
    const bucket = bucketOf(d.ageDays)
    totals[bucket] = decimalAdd(totals[bucket], open)
    totals.total = decimalAdd(totals.total, open)
    rows.push({
      docId: d.docId, docKind: d.kind, partyId: d.partyId, partyName: d.partyName,
      reference: d.reference, dueDate: d.due, ageBasisDate: d.ageBasisDate, ageBasisSource: d.ageBasisSource,
      ageDays: d.ageDays, bucket, open,
      docCurrency: d.docCurrency, txnOpen: d.openTxn as ExactDecimal,
    })
  }
  return { rows, totals, asOf, basis, reportingCurrency: target }
}

/**
 * One rebuild, two presentations — the detail page must not scan applications
 * twice. Summary still folds the control residual; detail stays documents-only.
 */
export async function agingSummaryAndDetail(
  side: AgingSide,
  asOf: string,
  dims?: DimFilter,
  orgId?: string,
  opts?: AgingOptions,
): Promise<{ summary: AgingResult; detail: AgingDetailResult }> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const { kinds, negativeKinds } = agingKinds(side);
  const basis: AgingCurrencyBasis = opts?.basis ?? "base";
  const orgBase = await presentationCurrency(resolvedOrgId);
  const target = opts?.reportingCurrency ?? orgBase;
  const docs = await openDocuments(side, asOf, dims, resolvedOrgId, orgBase, kinds, negativeKinds, {
    bookId: opts?.bookId,
  });
  const { residuals, unopenedLines } = await controlResiduals(side, asOf, dims, resolvedOrgId, orgBase, opts?.bookId);
  const needed = new Set<string>();
  for (const d of docs) needed.add(basis === "transaction" ? d.txnCcy : d.funcCcy);
  for (const res of residuals) needed.add(res.funcCcy);
  needed.delete(target);
  let rates = new Map<string, string>();
  if (needed.size > 0) {
    try {
      rates = await presentationRates(resolvedOrgId, target, needed, asOf);
    } catch {
      throw new AgingRatesUnavailableError(
        await missingSpotCoverage(resolvedOrgId, target, needed, asOf),
        target,
        asOf,
      );
    }
  }
  const convert = (native: string, from: string): ExactDecimal => convertOpen(native, from, target, rates);
  const byParty = new Map<string | null, AgingRow>();
  for (const d of docs) {
    const open = convert(basis === "transaction" ? d.openTxn : d.openBase, basis === "transaction" ? d.txnCcy : d.funcCcy);
    if (decimalCmp(open, ZERO) === 0) continue;
    const bucket = bucketOf(d.ageDays);
    let row = byParty.get(d.partyId);
    if (!row) {
      row = { partyId: d.partyId, partyName: d.partyName, current: ZERO, b1: ZERO, b2: ZERO, b3: ZERO, b4: ZERO, total: ZERO };
      byParty.set(d.partyId, row);
    }
    row[bucket] = decimalAdd(row[bucket], open);
    row.total = decimalAdd(row.total, open);
  }
  const rows: AgingRow[] = [...byParty.values()];
  await foldControlResidual(side, resolvedOrgId, rows, docs, residuals, unopenedLines, convert);
  rows.sort((x, y) => Number(x.reconciling === true) - Number(y.reconciling === true) || compareAbsoluteDescending(x.total, y.total));
  const totals = rows.reduce(
    (a, r) => ({
      current: decimalAdd(a.current, r.current),
      b1: decimalAdd(a.b1, r.b1),
      b2: decimalAdd(a.b2, r.b2),
      b3: decimalAdd(a.b3, r.b3),
      b4: decimalAdd(a.b4, r.b4),
      total: decimalAdd(a.total, r.total),
    }),
    { current: ZERO, b1: ZERO, b2: ZERO, b3: ZERO, b4: ZERO, total: ZERO },
  );
  return {
    summary: { rows, totals, asOf, basis, reportingCurrency: target },
    detail: presentAgingDetail(docs, basis, target, asOf, rates),
  };
}

/**
 * Reporting-currency options for the selector: the org base plus the
 * transaction currencies actually in scope for the report (posted documents
 * of the side's kinds as of the date with open-item lines) — never the full
 * registry, which would offer currencies no document uses.
 */
export async function agingCurrenciesInScope(
  side: AgingSide,
  asOf: string,
  dims?: DimFilter,
  orgId?: string,
): Promise<{ baseCurrency: string; currencies: string[] }> {
  const resolvedOrgId = await resolveOrgId(orgId);
  // Same shared population: an expense-report-only transaction currency must
  // still be offered by the selector, or the report cannot be read in the
  // currency the customer actually owes. Settlement documents ride along, so
  // a payment-only currency is offered too.
  const { kinds } = agingKinds(side);
  const baseCurrency = await presentationCurrency(resolvedOrgId);
  // A currency is offered when a document in it can still be open on the
  // date: the report in any other currency has no rows to show.
  const accountScope = side === "ap" ? apOpenAccountScope(sql`a`, resolvedOrgId) : arOpenAccountScope(sql`a`);
  const r = await db.execute<{ ccy: string }>(sql`
    select distinct d.currency as ccy
      from documents d
      join journal_lines jl on jl.entry_id = d.posted_entry_id and jl.is_open_item
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted', 'reversed')
     where d.org_id = ${resolvedOrgId}
       and d.id in (${openItemCandidateDocumentsSql({ orgId: resolvedOrgId, asOf, accounts: accountScope })})
       and (d.status = 'posted' or (d.voided_at is not null and d.voided_at::date > ${asOf}::date))
       and d.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})
       and coalesce(d.posting_date, d.document_date) <= ${asOf}
       and je.book_id in ${statementBookIdsExpr(resolvedOrgId)}
       and ${dimWhere(dims, sql`d`)}
  `, "objects");
  const inScope = [...new Set(r.map((x) => x.ccy))].sort();
  return {
    baseCurrency,
    currencies: [baseCurrency, ...inScope.filter((c) => c !== baseCurrency)],
  };
}
