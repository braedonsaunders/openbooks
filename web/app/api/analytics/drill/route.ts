import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { guardPermission } from "../../../../lib/authz";
import { statementBookExpr } from "../../../../lib/gl-summary";
import { flowRates, presentationCurrency } from "../../../../lib/fx-presentation";
import { isUuid } from "../../../../lib/list-params";
import { compareDecimal } from "../../../../lib/exact-decimal";
import { subsidiaryVisibleFilter } from "../../../../lib/subsidiaries";
import { add, mulDecimal } from "@openbooks/engine/src/money/money.ts";
import { serializeLedgerDecimal } from "./ledger-decimal";
import type { SQL } from "drizzle-orm";

export const runtime = "nodejs";

/**
 * Scope predicate for an optionally-joined subsidiary column: legs with no
 * joined record stay (scoped by their own entity filters); legs WITH a
 * record require it visible. The house helper cannot express "missing row"
 * (null id) versus "null column", and a null-subsidiary source document must
 * not read as org-wide the way a sourceless manual journal does.
 */
function joinedSubsidiaryScope(id: SQL, sub: SQL, allowed: ReadonlySet<string> | null): SQL {
  if (allowed === null) return sql``;
  const ids = [...allowed];
  if (ids.length === 0) return sql` and false`;
  return sql`and (${id} is null or ${sub} = any(${`{${ids.join(",")}}`}::uuid[]))`;
}

/**
 * Translate exact functional legs to the presentation basis at each leg's
 * own date through the flow path. A leg without rate coverage is a named
 * 422 refusal — amounts in different functionals must never be summed raw.
 */
async function translateLegs(
  orgId: string,
  legs: Array<{ func: unknown; date: unknown; amount: unknown }>,
): Promise<
  | { ok: true; amounts: string[]; currency: string }
  | { ok: false; response: NextResponse }
> {
  const asFunc = (func: unknown): string | null => (typeof func === "string" ? func : null);
  const asDate = (date: unknown): string => String(date ?? "").slice(0, 10);
  const ratesResult = await flowRates(orgId, legs.map((l) => ({ func: asFunc(l.func), date: asDate(l.date) }))).then(
    (rates) => ({ ok: true as const, rates }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!ratesResult.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "missing exchange rate", message: ratesResult.error instanceof Error ? ratesResult.error.message : String(ratesResult.error) },
        { status: 422 },
      ),
    };
  }
  const rates = ratesResult.rates;
  try {
    const amounts = legs.map((l) => mulDecimal(String(l.amount ?? "0"), rates.rateAt(asFunc(l.func), asDate(l.date))));
    const currency = rates.base || (await presentationCurrency(orgId));
    return { ok: true, amounts, currency };
  } catch (error) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "missing exchange rate", message: error instanceof Error ? error.message : String(error) },
        { status: 422 },
      ),
    };
  }
}

/**
 * Generic analytics drill-down, with one endpoint for every dashboard:
 *
 *   ?account=<id>&from&to  — GL activity on one account: transactions,
 *                            monthly trend, by-party breakdown.
 *   ?party=<id>&from&to    — documents for one party: transactions, monthly
 *                            trend, by-kind breakdown.
 *
 * Fetched on click (never preloaded windows), capped at 1000 detail rows with
 * the true total reported so the UI can say what was truncated.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  const user = gate.user;

  const url = new URL(req.url);
  const account = url.searchParams.get("account");
  const party = url.searchParams.get("party");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if ((!account && !party) || !isIsoCalendarDate(from) || !isIsoCalendarDate(to) || from > to) {
    return NextResponse.json({ error: "account or party, plus valid from/to calendar dates (from <= to) required" }, { status: 400 });
  }
  if ((account && !isUuid(account)) || (party && !isUuid(party))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // The same legal-entity scope as the parent aggregates (spend-velocity and
  // customer-intelligence narrow every query through the caller's subsidiary
  // list): journal legs by their line and entry subsidiary, document-sourced
  // legs additionally by a visible source document. Detail AND every summary
  // query carry the scope — a restricted caller with a known shared id sees
  // no hidden lines, names, memos, amounts or totals.
  const allowed = gate.allowedSubsidiaryIds;
  const lineScope = subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed);
  const entryScope = subsidiaryVisibleFilter(sql`e.subsidiary_id`, allowed);
  const docJoinScope = joinedSubsidiaryScope(sql`d.id`, sql`d.subsidiary_id`, allowed);
  const docScope = subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed);
  const srcEntryScope = joinedSubsidiaryScope(sql`e.id`, sql`e.subsidiary_id`, allowed);
  // The posted population every parent metric reads: spend-velocity resolves
  // GL activity in the statement book with posted/reversed entries and live
  // documents; customer data reads posted invoices. Drafts, secondary-book
  // mirrors and voided documents are not activity, whatever the caller knew.
  const book = statementBookExpr(user.orgId);
  const postedEntry = sql`and e.status in ('posted', 'reversed') and e.book_id = ${book}`;
  const liveDoc = sql`and (d.id is null or d.voided_at is null)`;
  const postedDoc = sql`and d.status = 'posted'`;

  // Journal legs are stamped in their subsidiary's functional currency and
  // translate to presentation at the posting date through the flow path, as
  // the spend-velocity aggregate does — the same never-mix rule as party mode.
  const lineJoins = sql`
    left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id`;
  if (account) {
    const [detail, monthly, byParty, agg] = await Promise.all([
      (db.execute(sql`
        select e.posting_date::text as date, e.id as entry_id, l.amount,
          sub.base_currency as func,
          d.id as doc_id, d.kind as doc_kind, d.document_number as doc_number,
          coalesce(p.display_name, '') as party_name,
          coalesce(l.memo, e.memo, '') as memo
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        left join documents d on d.id = e.source_document_id and d.org_id = l.org_id
        ${lineJoins}
        left join parties p on p.id = l.party_id and p.org_id = l.org_id
        where l.org_id = ${user.orgId} and l.account_id = ${account}
          and e.posting_date >= ${from} and e.posting_date <= ${to}
          ${lineScope}
          ${entryScope}
          ${docJoinScope}
          ${postedEntry}
          ${liveDoc}
        order by e.posting_date desc, abs(l.amount) desc
        limit 1000
      `)),
      (db.execute(sql`
        select to_char(e.posting_date, 'YYYY-MM') as month, sub.base_currency as func,
          sum(l.amount) as amount, max(e.posting_date)::text as late
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        left join documents d on d.id = e.source_document_id and d.org_id = l.org_id
        ${lineJoins}
        where l.org_id = ${user.orgId} and l.account_id = ${account}
          and e.posting_date >= ${from} and e.posting_date <= ${to}
          ${lineScope}
          ${entryScope}
          ${docJoinScope}
          ${postedEntry}
          ${liveDoc}
        group by 1, 2 order by 1, 2
      `)),
      (db.execute(sql`
        select coalesce(p.display_name, 'No party') as name, sub.base_currency as func,
          sum(l.amount) as amount, count(*) as n, max(e.posting_date)::text as late
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        left join documents d on d.id = e.source_document_id and d.org_id = l.org_id
        ${lineJoins}
        left join parties p on p.id = l.party_id and p.org_id = l.org_id
        where l.org_id = ${user.orgId} and l.account_id = ${account}
          and e.posting_date >= ${from} and e.posting_date <= ${to}
          ${lineScope}
          ${entryScope}
          ${docJoinScope}
          ${postedEntry}
          ${liveDoc}
        group by 1, 2 order by 1, 2
      `)),
      (db.execute(sql`
        select sub.base_currency as func, count(*) as n, coalesce(sum(l.amount), 0) as amount,
          max(e.posting_date)::text as late
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        left join documents d on d.id = e.source_document_id and d.org_id = l.org_id
        ${lineJoins}
        where l.org_id = ${user.orgId} and l.account_id = ${account}
          and e.posting_date >= ${from} and e.posting_date <= ${to}
          ${lineScope}
          ${entryScope}
          ${docJoinScope}
          ${postedEntry}
          ${liveDoc}
        group by 1 order by 1
      `)),
    ]);
    const translated = await translateLegs(
      user.orgId,
      [
        ...detail.rows.map((r) => ({ func: r.func, date: r.date, amount: r.amount })),
        ...monthly.rows.map((r) => ({ func: r.func, date: r.late, amount: r.amount })),
        ...byParty.rows.map((r) => ({ func: r.func, date: r.late, amount: r.amount })),
        ...agg.rows.map((r) => ({ func: r.func, date: r.late, amount: r.amount })),
      ],
    );
    if (!translated.ok) return translated.response;
    const { amounts, currency } = translated;
    let cursor = 0;
    const take = (n: number) => amounts.slice(cursor, (cursor += n));
    const detailAmounts = take(detail.rows.length);
    const monthlyTranslated = take(monthly.rows.length);
    const partyTranslated = take(byParty.rows.length);
    const aggTranslated = take(agg.rows.length);
    const monthlyMerged = new Map<string, string>();
    monthly.rows.forEach((r, i) => {
      const month = String(r.month);
      monthlyMerged.set(month, add(monthlyMerged.get(month) ?? "0", monthlyTranslated[i] ?? "0"));
    });
    const partyCounts = new Map<string, number>();
    const partyMerged = new Map<string, string>();
    byParty.rows.forEach((r, i) => {
      const name = String(r.name);
      partyCounts.set(name, (partyCounts.get(name) ?? 0) + Number(r.n ?? 0));
      partyMerged.set(name, add(partyMerged.get(name) ?? "0", partyTranslated[i] ?? "0"));
    });
    const partyBreakdown = [...partyMerged.entries()]
      .map(([name, amount]) => ({ name, amount, count: partyCounts.get(name) ?? 0 }))
      .sort((a, b) => compareDecimal(b.amount, a.amount))
      .slice(0, 15);
    let total = "0";
    let count = 0;
    agg.rows.forEach((r, i) => {
      total = add(total, aggTranslated[i] ?? "0");
      count += Number(r.n ?? 0);
    });
    return NextResponse.json({
      mode: "account",
      currency,
      total: serializeLedgerDecimal(total),
      count,
      entries: ((detail.rows)).map((r, i) => ({
        date: r.date,
        entryId: r.entry_id,
        docId: r.doc_id,
        docKind: r.doc_kind,
        docNumber: r.doc_number ?? "",
        label: r.party_name || r.doc_number || "Journal",
        memo: r.memo,
        amount: serializeLedgerDecimal(detailAmounts[i] ?? "0"),
      })),
      monthly: [...monthlyMerged.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([month, amount]) => ({ month, amount: serializeLedgerDecimal(amount) })),
      breakdown: partyBreakdown.map((p) => ({ name: p.name, amount: serializeLedgerDecimal(p.amount), count: p.count })),
    });
  }

  // Document money reaches the drill in its native currency and translates to
  // the presentation basis exactly as the customer aggregate does: first leg
  // abs(total) * fx_rate at the document's own rate, second leg through the
  // flow path at the document date. Summing native totals across currencies
  // reads CAD 100 + USD 100 as "CAD 200" — translated legs never mix.
  const docJoins = sql`
    left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
    join orgs o on o.id = d.org_id`;
  const docFunc = sql`coalesce(sub.base_currency, o.base_currency)`;
  const docLeg = sql`round(abs(d.total) * d.fx_rate, 4)`;
  const docDate = sql`coalesce(d.document_date, d.posting_date)`;
  const [detail, monthly, byKind, agg] = await Promise.all([
    (db.execute(sql`
      select ${docDate}::text as date,
        d.id as doc_id, d.kind as doc_kind, d.document_number as doc_number,
        e.id as entry_id, ${docLeg} as func_amount, ${docFunc} as func,
        coalesce(d.memo, '') as memo
      from documents d
      left join journal_entries e on e.source_document_id = d.id and e.org_id = d.org_id
      ${docJoins}
      where d.org_id = ${user.orgId} and d.party_id = ${party} and d.voided_at is null
        and ${docDate} >= ${from}
        and ${docDate} <= ${to}
        ${docScope}
        ${srcEntryScope}
        ${postedDoc}
      order by ${docDate} desc, ${docLeg} desc
      limit 1000
    `)),
    (db.execute(sql`
      select to_char(${docDate}, 'YYYY-MM') as month, ${docFunc} as func,
        sum(${docLeg}) as amount, max(${docDate})::text as late
      from documents d
      ${docJoins}
      where d.org_id = ${user.orgId} and d.party_id = ${party} and d.voided_at is null
        and ${docDate} >= ${from}
        and ${docDate} <= ${to}
        ${docScope}
        ${postedDoc}
      group by 1, 2 order by 1, 2
    `)),
    (db.execute(sql`
      select d.kind as name, ${docFunc} as func, sum(${docLeg}) as amount,
        count(*) as n, max(${docDate})::text as late
      from documents d
      ${docJoins}
      where d.org_id = ${user.orgId} and d.party_id = ${party} and d.voided_at is null
        and ${docDate} >= ${from}
        and ${docDate} <= ${to}
        ${docScope}
        ${postedDoc}
      group by 1, 2 order by 1, 2
    `)),
    (db.execute(sql`
      select ${docFunc} as func, count(*) as n, coalesce(sum(${docLeg}), 0) as amount,
        max(${docDate})::text as late
      from documents d
      ${docJoins}
      where d.org_id = ${user.orgId} and d.party_id = ${party} and d.voided_at is null
        and ${docDate} >= ${from}
        and ${docDate} <= ${to}
        ${docScope}
        ${postedDoc}
      group by 1 order by 1
    `)),
  ]);
  const translated = await translateLegs(
    user.orgId,
    [
      ...detail.rows.map((r) => ({ func: r.func, date: r.date, amount: r.func_amount })),
      ...monthly.rows.map((r) => ({ func: r.func, date: r.late, amount: r.amount })),
      ...byKind.rows.map((r) => ({ func: r.func, date: r.late, amount: r.amount })),
      ...agg.rows.map((r) => ({ func: r.func, date: r.late, amount: r.amount })),
    ],
  );
  if (!translated.ok) return translated.response;
  const { amounts, currency } = translated;
  let cursor = 0;
  const take = (n: number) => amounts.slice(cursor, (cursor += n));
  const detailAmounts = take(detail.rows.length);
  const monthlyTranslated = take(monthly.rows.length);
  const kindTranslated = take(byKind.rows.length);
  const aggTranslated = take(agg.rows.length);
  const mergeTranslated = (keys: string[], legs: string[]): Array<{ key: string; amount: string }> => {
    const merged = new Map<string, string>();
    keys.forEach((key, i) => merged.set(key, add(merged.get(key) ?? "0", legs[i] ?? "0")));
    return [...merged.entries()].map(([key, amount]) => ({ key, amount }));
  };
  const monthlyMerged = mergeTranslated(
    monthly.rows.map((r) => String(r.month)),
    monthlyTranslated,
  ).sort((a, b) => (a.key < b.key ? -1 : 1));
  const kindCounts = new Map<string, number>();
  byKind.rows.forEach((r) => kindCounts.set(String(r.name), (kindCounts.get(String(r.name)) ?? 0) + Number(r.n ?? 0)));
  const kindMerged = mergeTranslated(
    byKind.rows.map((r) => String(r.name)),
    kindTranslated,
  )
    .map(({ key, amount }) => ({ name: key, amount, count: kindCounts.get(key) ?? 0 }))
    .sort((a, b) => compareDecimal(b.amount, a.amount));
  let total = "0";
  let count = 0;
  agg.rows.forEach((r, i) => {
    total = add(total, aggTranslated[i] ?? "0");
    count += Number(r.n ?? 0);
  });
  return NextResponse.json({
    mode: "party",
    currency,
    total: serializeLedgerDecimal(total),
    count,
    entries: ((detail.rows)).map((r, i) => ({
      date: r.date,
      entryId: r.entry_id,
      docId: r.doc_id,
      docKind: r.doc_kind,
      docNumber: r.doc_number ?? "",
      label: r.doc_number || r.doc_kind,
      memo: r.memo,
      amount: serializeLedgerDecimal(detailAmounts[i] ?? "0"),
    })),
    monthly: monthlyMerged.map(({ key, amount }) => ({ month: key, amount: serializeLedgerDecimal(amount) })),
    breakdown: kindMerged.map((k) => ({ name: k.name, amount: serializeLedgerDecimal(k.amount), count: k.count })),
  });
}
