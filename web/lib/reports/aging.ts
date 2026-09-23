import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { statementBookExpr } from "../gl-summary";
import { mulDecimal } from "@openbooks/engine/src/money/money.ts";
// Relative (not the bare workspace specifier): worktree node_modules resolves
// bare @openbooks/* to the main checkout, so a new engine module would not
// resolve until merge; a relative import binds this checkout everywhere.
import { AP_OPEN_ITEM_KINDS, AR_OPEN_ITEM_KINDS } from "../../../engine/src/records/open-item-kinds.ts";
import { resolveOrgId } from "../org-scope";
import { presentationCurrency, presentationRates } from "../fx-presentation";
import { decimalAdd, decimalCmp, decimalNeg, type ExactDecimal } from "../statement-format";
import { ZERO, compareAbsoluteDescending, decimalSubtract } from "./decimals";
import { type DimFilter, dimWhere } from "./filters";
import { apOpenAccountScope, arOpenAccountScope, arResidualAccountScope } from "../ledger-scope";

// ---------------------------------------------------------------------------
// AR / AP Aging
// ---------------------------------------------------------------------------

export type AgingSide = "ar" | "ap";

/**
 * The single as-of rule shared by the aging screen and its CSV export
 * (F-t02-008, F-t07-011): an explicit as-of always wins; otherwise an
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
 * FX, which drifts from the posted ledger by dust (F-t08-004).
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
 * explain (F-t08-004: AR aging CA$0.01 over GL 1030).
 *
 * Documents are not the whole control account: unapplied receipts, direct
 * control journals, and legacy partyless opening balances post control lines
 * with no invoice/credit document behind them. Those balances are folded in
 * as an explicit per-party residual (the "(no party)" row when no party is
 * stamped), so the aging total always ties to the control (F-t08-006).
 */
/**
 * One open document as rebuilt from stored dual-recorded amounts: the signed
 * functional open AND the signed transaction-currency open, side by side.
 * Both readers (summary, detail) share this one rebuild — the basis toggle
 * only chooses which leg converts to the reporting currency.
 *
 * The rebuild admits only counterparty-side control lines (0171, F-p3-001):
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
  ageDays: number;
  docCurrency: string;
  txnCcy: string;
  funcCcy: string;
  openBase: string;
  openTxn: string;
}

async function openDocuments(
  side: AgingSide,
  asOf: string,
  dims: DimFilter | undefined,
  orgId: string,
  orgBase: string,
  kinds: readonly string[],
  creditKind: string,
  scope?: { partyId?: string; bucket?: AgingBucket; bookId?: string | null },
): Promise<OpenDocument[]> {
  // Account gate: the AP side admits liability_payable lines plus the
  // designated employee-payable control (preset-typed liability_current_other,
  // where OOP reports actually post); the AR side admits asset_receivable.
  // Same scope object the dashboard tile reads — one shared answer to which
  // open items are payables, not a second list.
  const accountScope = side === "ap"
    ? apOpenAccountScope(sql`a`, orgId)
    : arOpenAccountScope(sql`a`);
  const r = (await db.execute<{
    doc_id: string; kind: string; party_id: string | null; party_name: string | null;
    reference: string | null; due: string | null; age_days: number;
    doc_currency: string; txn_ccy: string; func_ccy: string;
    open_base: string; open_txn: string;
  }>(sql`
    -- The open is reconstructed AS OF the report date — gross open-item
    -- lines minus applications dated on/before it — never the live cached
    -- balance: a later settlement must not rewrite a past aging (or
    -- month-end history would never reproduce).
    -- Applications are a per-line LATERAL (indexed from/to line id), not a
    -- bulk CTE joined back onto every open-item line. RLS on applications
    -- hides cardinality from the planner; the bulk join was estimated at
    -- one row and became an 8-million-pair nested loop. MATERIALIZED
    -- doc_lines forces the posted/as-of/party/bucket filter first so the
    -- lateral only probes lines that can still be open.
    -- Both currency legs rebuild here: the functional leg (stored base
    -- amounts and base carrying amounts — never re-translated, so the aging
    -- ties its control by construction) and the transaction leg (stored txn
    -- amounts and txn application legs). Which leg converts is the basis
    -- toggle, decided in JS below — the SQL stays one rebuild.
    with doc_lines as materialized (
      select d.id as doc_id, d.kind, d.party_id, d.document_number,
             coalesce(d.due_date, d.posting_date, d.document_date)::text as due,
             (${asOf}::date - coalesce(d.due_date, d.posting_date, d.document_date))::int as age_days,
             d.currency as doc_currency,
             jl.id as line_id,
             abs(jl.amount) as base_gross, abs(jl.txn_amount) as txn_gross,
             jl.currency as txn_ccy,
             coalesce(sub.base_currency, ${orgBase}) as func_ccy
        from documents d
        join journal_lines jl on jl.entry_id = d.posted_entry_id and jl.is_open_item
        join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = ${orgId}
        left join subsidiaries sub on sub.id = jl.subsidiary_id and sub.org_id = ${orgId}
       where d.org_id = ${orgId}
         and d.status = 'posted' and d.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})
         and ${accountScope}
         and e.book_id = ${statementBookExpr(orgId, scope?.bookId)}
         and coalesce(d.posting_date, d.document_date) <= ${asOf}
         and ${dimWhere(dims, sql`d`)}
         ${scope?.partyId ? sql`and d.party_id = ${scope.partyId}` : sql``}
         and ${agingBucketSql(asOf, scope?.bucket)}
    ),
    open_docs as (
      select dl.doc_id, dl.kind, dl.party_id, dl.document_number, dl.due, dl.age_days,
             dl.doc_currency, dl.txn_ccy, dl.func_ccy,
             (case when dl.kind = ${creditKind} then -1 else 1 end)
               * (sum(dl.base_gross) - coalesce(sum(al.applied_base), 0)) as open_base,
             (case when dl.kind = ${creditKind} then -1 else 1 end)
               * (sum(dl.txn_gross) - coalesce(sum(al.applied_txn), 0)) as open_txn
        from doc_lines dl
        left join lateral (
          -- applications.amount is the base-currency carrying amount (the same
          -- denomination as the base leg above); the source/target transaction
          -- legs are the same denomination as the txn leg. No FX re-translation
          -- on either side. OR on from/to uses the existing line-id indexes.
          select
            coalesce(sum(a.amount), 0) as applied_base,
            coalesce(sum(case when a.from_line_id = dl.line_id
                              then a.source_transaction_amount
                              else a.target_transaction_amount end), 0) as applied_txn
          from applications a
          where a.org_id = ${orgId}
            and a.applied_on <= ${asOf}
            and (a.unapplied_at is null or a.unapplied_at::date > ${asOf}::date)
            and (a.from_line_id = dl.line_id or a.to_line_id = dl.line_id)
        ) al on true
       group by dl.doc_id, dl.kind, dl.party_id, dl.document_number, dl.due,
                dl.age_days, dl.doc_currency, dl.txn_ccy, dl.func_ccy
      -- Settlement completeness is a ledger (base-leg) question under both
      -- bases, so the population rule never moves with the toggle: the base
      -- report reads exactly the documents it always has.
      having (sum(dl.base_gross) - coalesce(sum(al.applied_base), 0)) > 0
    )
    select od.doc_id, od.kind, od.party_id, p.display_name as party_name,
           od.document_number as reference, od.due, od.age_days,
           od.doc_currency, od.txn_ccy, od.func_ccy,
           od.open_base, od.open_txn
      from open_docs od
      left join parties p on p.id = od.party_id and p.org_id = ${orgId}
     where abs(od.open_base) > 0
  `));
  return r.rows.map((x) => ({
    docId: x.doc_id,
    kind: x.kind,
    partyId: x.party_id,
    partyName: x.party_name,
    reference: x.reference,
    due: x.due,
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
     )`);
  return r.rows.map((x) => x.ccy);
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
  // reaching the total only through the control residual (F-u1-P5.1).
  const kinds = side === "ap" ? AP_OPEN_ITEM_KINDS : AR_OPEN_ITEM_KINDS;
  const creditKind = side === "ap" ? "vendor_credit" : "customer_credit";
  const basis: AgingCurrencyBasis = opts?.basis ?? "base";
  const orgBase = await presentationCurrency(resolvedOrgId);
  const target = opts?.reportingCurrency ?? orgBase;
  const docs = await openDocuments(side, asOf, dims, resolvedOrgId, orgBase, kinds, creditKind, {
    bookId: opts?.bookId,
  });
  const residuals = await controlResiduals(side, asOf, dims, resolvedOrgId, orgBase, opts?.bookId);
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
  await foldControlResidual(side, resolvedOrgId, rows, docs, residuals, convert);
  // The residual merge can change row totals: restore the
  // abs(total)-descending display order of the old grouped query.
  rows.sort((a, b) => compareAbsoluteDescending(a.total, b.total));
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
 * Fold control-account balances that no invoice/credit document explains into
 * the aging rows, per party (F-t08-006). Unapplied receipts, direct control
 * journals, and legacy partyless opening balances all post control lines
 * outside the document population above; without this the aging silently
 * understates the control (SIM AR CA$503,288 aged vs CA$687,038 on GL 1100).
 * The residual lands in `current` — an undated balance has no age to bucket
 * by — and a party with no stamped lines renders through the existing
 * "(no party)" row, exactly like the registers' unassigned section. Exact
 * ties produce no row at all, so a clean subledger reads exactly as before.
 *
 * Two deliberate scope boundaries. First, one book per read: the document
 * side above joins each line's entry and keeps the primary (or selected)
 * book, so the control side answers in that same scope — reading every
 * book on either side would double-count parallel-book mirrors. Second,
 * document dims attribute by document HEADER while control
 * lines attribute by LINE (one invoice, lines in many departments): under
 * department/project/location/class/segment filters the two populations
 * partition differently and control-minus-docs is not attributable per
 * party, so the residual stays out and the aging reads documents only, as
 * before. Subsidiary stamps ride on documents and lines together, so
 * subsidiary-scoped reads keep the residual. Third, the control side uses the
 * same account scope as the document side (0171): the AP control counts
 * liability_payable accounts plus the designated employee-payable control, so
 * newly aged OOP reports cancel out of the residual instead of being netted
 * back off it; the AR control excludes the designated employee-receivable
 * account, whose personal balances age nowhere by design (see
 * arResidualAccountScope) rather than landing as document-less AR rows.
 */
interface ControlResidual {
  partyId: string | null;
  funcCcy: string;
  bal: string;
}

async function controlResiduals(
  side: AgingSide,
  asOf: string,
  dims: DimFilter | undefined,
  orgId: string,
  orgBase: string,
  bookId?: string | null,
): Promise<ControlResidual[]> {
  if (
    dims?.departmentId || dims?.projectId || dims?.locationId || dims?.classId ||
    (dims?.segments && Object.keys(dims.segments).length > 0)
  ) {
    return [];
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
       and e.book_id = ${statementBookExpr(orgId, bookId)}
       and ${dimWhere(dims)}
     -- Ordinal, not a repeated expression: the SELECT's coalesce carries a
     -- different bind parameter per occurrence, which GROUP BY will not match.
     group by l.party_id, 2
  `);
  return control.rows.map((c) => ({ partyId: c.party_id, funcCcy: c.func_ccy, bal: c.bal }));
}

async function foldControlResidual(
  side: AgingSide,
  orgId: string,
  rows: AgingRow[],
  docs: OpenDocument[],
  residuals: ControlResidual[],
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
  const unnamed: string[] = [];
  for (const [partyId, residual] of residualByParty) {
    if (decimalCmp(residual, ZERO) === 0) continue;
    const existing = rows.find((row) => row.partyId === partyId);
    if (existing) {
      existing.current = decimalAdd(existing.current, residual);
      existing.total = decimalAdd(existing.total, residual);
    } else {
      rows.push({
        partyId,
        partyName: null,
        current: residual,
        b1: ZERO,
        b2: ZERO,
        b3: ZERO,
        b4: ZERO,
        total: residual,
      });
      if (partyId !== null) unnamed.push(partyId);
    }
  }
  if (unnamed.length > 0) {
    const named = await db.execute<{ id: string; display_name: string | null }>(sql`
      select p.id, p.display_name from parties p
       where p.org_id = ${orgId} and p.id = any(${`{${unnamed.join(",")}}`}::uuid[])
    `);
    const names = new Map(named.rows.map((n) => [n.id, n.display_name]));
    for (const row of rows) {
      if (row.partyId !== null && row.partyName === null) row.partyName = names.get(row.partyId) ?? null;
    }
  }
  // The merge nets a row to zero exactly when its control balance is zero —
  // nothing outstanding, so it reads as no row (the grouped query's own
  // abs(total) > 0 rule).
  for (let i = rows.length - 1; i >= 0; i--) {
    if (decimalCmp(rows[i]!.total, ZERO) === 0) rows.splice(i, 1);
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

export function bucketOf(age: number): AgingBucket {
  if (age <= 0) return "current"
  if (age <= 30) return "b1"
  if (age <= 60) return "b2"
  if (age < 90) return "b3"
  return "b4"
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
 * Credits are negative open items so the detail and summary always tie.
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
  const kinds = side === "ap" ? AP_OPEN_ITEM_KINDS : AR_OPEN_ITEM_KINDS
  const creditKind = side === "ap" ? "vendor_credit" : "customer_credit"
  const basis: AgingCurrencyBasis = opts?.basis ?? "base";
  const orgBase = await presentationCurrency(resolvedOrgId);
  const target = opts?.reportingCurrency ?? orgBase;
  // The same shared rebuild as the summary — detail rows can never disagree
  // with the summary buckets per document. Deliberately documents-only:
  // control balances with no open item behind them (unapplied receipts,
  // direct control journals) surface on the summary residual row, never here.
  const docs = await openDocuments(side, asOf, dims, resolvedOrgId, orgBase, kinds, creditKind, {
    partyId: opts?.partyId,
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
      reference: d.reference, dueDate: d.due, ageDays: d.ageDays, bucket, open,
      docCurrency: d.docCurrency, txnOpen: d.openTxn as ExactDecimal,
    })
  }
  // The old grouped query ordered by party name with nulls last, oldest first.
  rows.sort((a, b) =>
    (a.partyName ?? "\uffff").localeCompare(b.partyName ?? "\uffff") || b.ageDays - a.ageDays,
  )
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
  const kinds = side === "ap" ? AP_OPEN_ITEM_KINDS : AR_OPEN_ITEM_KINDS;
  const creditKind = side === "ap" ? "vendor_credit" : "customer_credit";
  const basis: AgingCurrencyBasis = opts?.basis ?? "base";
  const orgBase = await presentationCurrency(resolvedOrgId);
  const target = opts?.reportingCurrency ?? orgBase;
  const docs = await openDocuments(side, asOf, dims, resolvedOrgId, orgBase, kinds, creditKind, {
    bookId: opts?.bookId,
  });
  const residuals = await controlResiduals(side, asOf, dims, resolvedOrgId, orgBase, opts?.bookId);
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
  await foldControlResidual(side, resolvedOrgId, rows, docs, residuals, convert);
  rows.sort((a, b) => compareAbsoluteDescending(a.total, b.total));
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
  // currency the customer actually owes.
  const kinds = side === "ap" ? AP_OPEN_ITEM_KINDS : AR_OPEN_ITEM_KINDS;
  const baseCurrency = await presentationCurrency(resolvedOrgId);
  const r = await db.execute<{ ccy: string }>(sql`
    select distinct d.currency as ccy
      from documents d
      join journal_lines jl on jl.entry_id = d.posted_entry_id and jl.is_open_item
     where d.org_id = ${resolvedOrgId}
       and d.status = 'posted' and d.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})
       and coalesce(d.posting_date, d.document_date) <= ${asOf}
       and ${dimWhere(dims, sql`d`)}
  `);
  const inScope = [...new Set(r.rows.map((x) => x.ccy))].sort();
  return {
    baseCurrency,
    currencies: [baseCurrency, ...inScope.filter((c) => c !== baseCurrency)],
  };
}
