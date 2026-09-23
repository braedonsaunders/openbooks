import { sql } from "drizzle-orm";
import { add, cmp, mulDecimal, neg, normalizeMoney, sum } from "../money/money.ts";
import { AP_OPEN_ITEM_KINDS, AR_OPEN_ITEM_KINDS } from "../records/open-item-kinds.ts";
import { appliedLegAmountExpr } from "../records/balance-due.ts";
import { apOpenAccountScope, asOfPostedEntryLateral } from "../records/open-item-scopes.ts";
import { addCalendarDays, businessToday } from "../platform/business-date.ts";
import {
  effectiveDetectorMateriality,
  type ContinuousCloseDetectorPolicy,
} from "./continuous-close-config.ts";
import { db } from "../platform/db.ts";
import { classifyForensicItem, moneyAbs } from "./measure.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Cash-alerts pack: the Banking cash page's own liquidity read
 * (web/lib/cash/cash-position.ts `cashPosition` with the analytics forecast's
 * shared timeline), rebuilt on the engine side because web/lib is
 * server-only. Every primitive below is transcribed from the cockpit source
 * it names — bank inception-to-date balances, as-of open items with
 * application netting, settlement stats, predicted dates, the week grid, and
 * the oldest-due-first capacity scheduling — translated to the org base
 * through the same fail-closed closing-spot doctrine. One documented
 * boundary: category recurrers (the formula engine behind `categories`) are
 * excluded, so the detector rolls open-item cash only — a conservative subset
 * of the cockpit timeline, never a second forecast. Findings link the Banking
 * cash cockpit for review. Proposes nothing executable; never writes.
 */
export const CASH_DETECTOR_KEYS = [
  "cash_low_balance",
  "cash_bill_crunch",
  "cash_forecast_shortfall",
] as const;

const CASH_HREF = "/banking/cash";

const MS_DAY = 86_400_000;
const parseISO = (s: string): Date => new Date(`${s}T00:00:00Z`);
const toISO = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * MS_DAY);
const daysBetween = (a: Date, b: Date): number => Math.round((b.getTime() - a.getTime()) / MS_DAY);
/** Sunday of the week (date − getDay()). */
const weekStart = (d: Date): Date => addDays(d, -d.getUTCDay());
/** Weekend → next business day (Sat +2, Sun +1). */
const businessDay = (d: Date): Date => {
  const day = d.getUTCDay();
  if (day === 6) return addDays(d, 2);
  if (day === 0) return addDays(d, 1);
  return d;
};

/** The org's base (functional) currency — the consolidated presentation currency. */
async function cashBaseCurrency(orgId: string): Promise<string> {
  const res = await db.execute<{ baseCurrency: string | null }>(sql`
    select base_currency as "baseCurrency" from orgs where id = ${orgId}
  `);
  const base = res.rows[0]?.baseCurrency;
  if (typeof base !== "string" || !base) throw new Error(`organization ${orgId} has no base currency`);
  return base;
}

/**
 * Latest dated spot rate per requested functional currency → presentation
 * base, on or before `refDate` — direct-or-inverse spot, direct wins ties.
 * Same-currency legs resolve to "1" with no rate row. Missing coverage fails
 * closed (a clear error), never a silent mix.
 */
async function closingSpotRates(
  orgId: string,
  base: string,
  froms: (string | null)[],
  refDate: string,
): Promise<Map<string, string>> {
  const needed = [...new Set(froms.map((c) => c ?? base))].filter((c) => c !== base);
  const rates = new Map<string, string>([[base, "1"]]);
  if (needed.length === 0) return rates;
  const list = `{${needed.join(",")}}`;
  const res = await db.execute<{ from_currency: string; rate: string }>(sql`
    select distinct on (s.from_currency) s.from_currency, s.rate::text as rate
      from (
        select from_currency, rate, as_of, 0 as priority from fx_rates
         where org_id = ${orgId} and from_currency = any(${list}::text[])
           and to_currency = ${base} and rate_type = 'spot'
           and as_of <= ${refDate}::date
        union all
        select to_currency as from_currency, (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority from fx_rates
         where org_id = ${orgId} and to_currency = any(${list}::text[])
           and from_currency = ${base} and rate_type = 'spot'
           and as_of <= ${refDate}::date
      ) s
     order by s.from_currency, s.as_of desc, s.priority asc
  `);
  for (const row of res.rows) rates.set(row.from_currency, row.rate);
  const missing = needed.filter((c) => !rates.has(c));
  if (missing.length > 0) {
    throw new Error(`no spot rate for ${missing.join(",")}→${base} on or before ${refDate}`);
  }
  return rates;
}

/** Functional currency of a journal line's entity; null (root-owned) lines read the org base. */
function lineFunctional(subsidiaryBase: string | null, orgBase: string): string {
  return subsidiaryBase ?? orgBase;
}

/**
 * Inception-to-date cash per bank account: whole months from the
 * gl_month_activity summary, the as-of month from the lines. The org
 * predicates are explicit and the movement legs are restricted to bank
 * accounts (an unqualified leg degrades to a full scan of every journal
 * line). Translated at the closing spot per the balance doctrine.
 */
async function bankAccountBalances(
  orgId: string,
  base: string,
  asOf: string,
): Promise<{ id: string; name: string; number: string | null; balance: string }[]> {
  const res = await db.execute<Record<string, unknown>>(sql`
    with bank_accounts as (
      select id from accounts
       where org_id = ${orgId} and type = 'asset_bank' and is_summary = false and is_active
    ),
    sliver_entries as materialized (
      select id from journal_entries
       where org_id = ${orgId} and status in ('posted', 'reversed')
         and book_id = (select b.id from accounting_books b where b.org_id = ${orgId} and b.is_primary order by b.created_at limit 1)
         and posting_date >= date_trunc('month', ${asOf}::date)::date
         and posting_date <= ${asOf}
    ),
    movement as (
      select g.account_id, (g.debit_total - g.credit_total) as amt, sub.base_currency as func
        from gl_month_activity g
        left join subsidiaries sub on sub.id = g.subsidiary_id and sub.org_id = ${orgId}
       where g.org_id = ${orgId}
         and g.book_id = (select b.id from accounting_books b where b.org_id = ${orgId} and b.is_primary order by b.created_at limit 1)
         and g.account_id in (select id from bank_accounts)
         and g.month < date_trunc('month', ${asOf}::date)::date
      union all
      select l.account_id, l.amount, sub.base_currency as func
        from sliver_entries se
        join journal_lines l on l.entry_id = se.id and l.org_id = ${orgId}
        left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = ${orgId}
       where l.account_id in (select id from bank_accounts)
    )
    select a.id::text as id, a.name, a.number, m.func, coalesce(sum(m.amt), 0)::text as balance
      from accounts a
      left join movement m on m.account_id = a.id
     where a.org_id = ${orgId} and a.type = 'asset_bank' and a.is_summary = false and a.is_active
     group by a.id, a.name, a.number, m.func
  `);
  const legs = res.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    number: (row.number as string | null) ?? null,
    func: (row.func as string | null) ?? null,
    balance: String(row.balance),
  }));
  const rates = await closingSpotRates(
    orgId,
    base,
    legs.map((leg) => leg.func),
    asOf,
  );
  const byAccount = new Map<string, { id: string; name: string; number: string | null; legs: string[] }>();
  for (const leg of legs) {
    const cur = byAccount.get(leg.id) ?? { id: leg.id, name: leg.name, number: leg.number, legs: [] };
    cur.legs.push(mulDecimal(leg.balance, rates.get(lineFunctional(leg.func, base))!));
    byAccount.set(leg.id, cur);
  }
  return [...byAccount.values()]
    .map((account) => ({ ...account, balance: normalizeMoney(sum(account.legs)) }))
    .sort((x, y) => cmp(y.balance, x.balance));
}

type OpenItem = {
  id: string;
  docKind: string | null;
  docNumber: string | null;
  partyId: string | null;
  partyName: string;
  tranDate: Date;
  dueDate: Date | null;
  remaining: string;
};

/**
 * What was still collectible AS OF the forecast date — gross line minus
 * applications dated on/before it. Bills/invoices carry the side's normal
 * sign; credit memos carry the opposite sign on the same control account, so
 * an unapplied credit nets against the party's bills (or scheduled outflow
 * overstates cash need). Each leg nets through its own carrying column via
 * the shared balance-due helper, never a bare sum for both legs. The
 * document's posting is reconstructed as of the date from journal history
 * (shared helper) — a later correction or void never rewrites it. Translated
 * at the closing spot — raw functionals would mix subsidiary currencies.
 */
async function sideOpenItems(
  orgId: string,
  base: string,
  side: "ar" | "ap",
  asOf: string,
): Promise<OpenItem[]> {
  const creditKind = side === "ap" ? "vendor_credit" : "customer_credit";
  const lineFilter =
    side === "ap"
      ? sql`((d.kind = ${creditKind} and jl.amount > 0) or (d.kind <> ${creditKind} and jl.amount < 0))`
      : sql`((d.kind = ${creditKind} and jl.amount < 0) or (d.kind <> ${creditKind} and jl.amount > 0))`;
  // Population is the shared open-item kinds const — the transcription must
  // name the same doorway as the cockpit, never re-list it (P5.1).
  const kinds = side === "ap" ? AP_OPEN_ITEM_KINDS : AR_OPEN_ITEM_KINDS;
  const kindFilter = sql`d.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})`;
  const res = await db.execute<Record<string, unknown>>(sql`
    with oi as (
      select jl.id, jl.party_id, je.posting_date as tran_date, jl.due_date,
             d.kind as doc_kind, d.document_number as doc_number,
             sub.base_currency as func,
             (case when d.kind = ${creditKind} then -1 else 1 end) * (abs(jl.amount) - coalesce((
               select sum(${appliedLegAmountExpr("x", sql`jl.id`, "base")}) from applications x
                where x.org_id = ${orgId}
                  and (x.to_line_id = jl.id or x.from_line_id = jl.id)
                  and x.applied_on <= ${asOf}
                  and (x.unapplied_at is null or x.unapplied_at::date > ${asOf}::date)
             ), 0)) as remaining
        from documents d
        ${asOfPostedEntryLateral(orgId, asOf)}
        join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id and jl.is_open_item and ${lineFilter}
        join accounts a on a.id = jl.account_id and a.org_id = ${orgId}
         and ${side === "ap" ? apOpenAccountScope(sql`a`, orgId) : sql`a.type = 'asset_receivable'`}
        left join subsidiaries sub on sub.id = jl.subsidiary_id and sub.org_id = ${orgId}
       where d.org_id = ${orgId}
         and (d.status = 'posted' or (d.voided_at is not null and d.voided_at::date > ${asOf}::date))
         and ${kindFilter}
    )
    select oi.id::text as id, oi.party_id::text as party_id,
           coalesce(p.display_name, 'Unspecified') as party_name,
           oi.tran_date::text as tran_date, oi.due_date::text as due_date,
           oi.doc_kind as doc_kind, oi.doc_number as doc_number,
           oi.remaining::text as remaining, oi.func as func
      from oi
      left join parties p on p.id = oi.party_id and p.org_id = ${orgId}
     where oi.remaining <> 0
  `);
  const rows = res.rows.map((row) => ({
    id: String(row.id),
    partyId: (row.party_id as string | null) ?? null,
    partyName: String(row.party_name),
    tranDate: parseISO(String(row.tran_date)),
    dueDate: row.due_date ? parseISO(String(row.due_date)) : null,
    docKind: (row.doc_kind as string | null) ?? null,
    docNumber: (row.doc_number as string | null) ?? null,
    remaining: String(row.remaining),
    func: (row.func as string | null) ?? null,
  }));
  const rates = await closingSpotRates(
    orgId,
    base,
    rows.map((row) => row.func),
    asOf,
  );
  return rows.map((row) => ({
    id: row.id,
    docKind: row.docKind,
    docNumber: row.docNumber,
    partyId: row.partyId,
    partyName: row.partyName,
    tranDate: row.tranDate,
    dueDate: row.dueDate,
    remaining: normalizeMoney(mulDecimal(row.remaining, rates.get(lineFunctional(row.func, base))!)),
  }));
}

type SettlementStats = { map: Map<string, { avg: number; sd: number }>; globalAvg: number };

/**
 * Per-party avg days (+ σ) from invoice/bill date to the applied payment,
 * from party_payment_stats — the rollup maintained at the settlement event,
 * holding sufficient statistics per (party, settlement day) so the trailing
 * 365-day window is an exact range scan. Global average weighted by data
 * point (not an average of per-party averages); 45-day default with no
 * history.
 */
async function settlementStats(
  orgId: string,
  side: "ar" | "ap",
  asOf: string,
): Promise<SettlementStats> {
  const acctType = side === "ar" ? "asset_receivable" : "liability_payable";
  const res = await db.execute<{ id: string; avg_days: string; sd_days: string; n: string }>(sql`
    with stats as (
      select party_id, settled_on, n, sum_days, sum_days_sq
        from party_payment_stats
       where org_id = ${orgId} and account_type = ${acctType}
         and settled_on >= ${asOf}::date - 365
         and settled_on <= ${asOf}::date
    )
    select party_id as id,
           sum(sum_days) / sum(n) as avg_days,
           sqrt(greatest(
             sum(sum_days_sq) / sum(n) - (sum(sum_days) / sum(n)) * (sum(sum_days) / sum(n)),
             0)) as sd_days,
           sum(n) as n
      from stats
     group by party_id
    having sum(n) > 0
  `);
  const map = new Map<string, { avg: number; sd: number }>();
  let total = 0;
  let count = 0;
  for (const row of res.rows) {
    const avg = Number(row.avg_days);
    const n = Number(row.n);
    map.set(row.id, { avg, sd: Number(row.sd_days) });
    total += avg * n;
    count += n;
  }
  return { map, globalAvg: count > 0 ? Math.round(total / count) : 45 };
}

type ForecastEntry = {
  amount: string;
  dueDate: string | null;
  predictedDate: string;
  weekStart: string;
  method: string;
  docKind: string | null;
  docNumber: string | null;
  partyName: string;
};

/** Predict collection/payment date for one open item. */
function predictItem(
  item: OpenItem,
  asOf: Date,
  stats: SettlementStats,
): { date: Date; method: string } {
  let date: Date;
  let method = "Global avg";
  const s = item.partyId ? stats.map.get(item.partyId) : undefined;
  if (s) {
    const buffer = s.sd ? Math.ceil(s.sd * 0.5) : 0;
    date = addDays(item.tranDate, Math.round(s.avg) + buffer);
    method = "Statistical";
  } else {
    date = addDays(item.tranDate, stats.globalAvg);
  }
  // Floor at due date.
  if (item.dueDate && date < item.dueDate) {
    date = item.dueDate;
    method = "Due date";
  }
  // Overdue → push forward.
  if (date < asOf) {
    const overdue = daysBetween(date, asOf);
    const push = overdue > 60 ? 28 : overdue > 30 ? 14 : 7;
    date = addDays(asOf, push);
    method = "Overdue push";
  }
  return { date: businessDay(date), method };
}

/**
 * Predict every open item into a week bucket. Returns the by-week entry map
 * and the total scheduled inside the horizon — the shared step behind the
 * analytics timeline and the cockpit worklists.
 */
function scheduleByWeek(
  items: OpenItem[],
  stats: SettlementStats,
  asOf: Date,
  start: Date,
  end: Date,
): Map<string, ForecastEntry[]> {
  const byWeek = new Map<string, ForecastEntry[]>();
  for (const item of items) {
    const { date, method } = predictItem(item, asOf, stats);
    if (date < start || date > end) continue;
    const wk = toISO(weekStart(date));
    const entry: ForecastEntry = {
      amount: item.remaining,
      dueDate: item.dueDate ? toISO(item.dueDate) : null,
      predictedDate: toISO(date),
      weekStart: wk,
      method,
      docKind: item.docKind,
      docNumber: item.docNumber,
      partyName: item.partyName,
    };
    const bucket = byWeek.get(wk);
    if (bucket) bucket.push(entry);
    else byWeek.set(wk, [entry]);
  }
  return byWeek;
}

type TimelineWeek = { weekStart: string; inflow: string; outflow: string; endingCash: string };

/**
 * Roll the weekly cash timeline: AR/AP join each week; when AP scheduling is
 * on, payables are paid oldest-due-first up to that week's capacity and the
 * remainder defers forward. Category recurrers are out of scope (see module
 * docblock), so dynamic flows are always zero here.
 */
function rollTimeline(args: {
  weekStarts: string[];
  startingCash: string;
  arByWeek: Map<string, ForecastEntry[]>;
  apByWeek: Map<string, ForecastEntry[]>;
  weeklyCap: string;
  restrictToSafe: boolean;
}): { weeks: TimelineWeek[]; lowestCash: string; lowestWeek: string } {
  const { weekStarts, startingCash, arByWeek, apByWeek, weeklyCap, restrictToSafe } = args;
  const cap = normalizeMoney(weeklyCap);
  const schedulingOn = cmp(cap, "0.0000") > 0 || restrictToSafe;

  const weeks: TimelineWeek[] = [];
  let running = normalizeMoney(startingCash);
  let backlog: ForecastEntry[] = [];
  let lowestCash = running;
  let lowestWeek = weekStarts[0]!;
  for (const k of weekStarts) {
    const arInflow = sum((arByWeek.get(k) ?? []).map((e) => e.amount));
    const dueThisWeek = apByWeek.get(k) ?? [];
    let apOutflow = sum(dueThisWeek.map((e) => e.amount));
    if (schedulingOn) {
      // Oldest due date first, then largest amount (the backlog order).
      backlog = [...backlog, ...dueThisWeek].sort((a, b) => {
        const ad = a.dueDate ?? a.predictedDate;
        const bd = b.dueDate ?? b.predictedDate;
        return ad < bd ? -1 : ad > bd ? 1 : cmp(b.amount, a.amount);
      });
      const safe = restrictToSafe
        ? (() => {
            const available = add(running, arInflow);
            return cmp(available, "0.0000") > 0 ? available : "0.0000";
          })()
        : null;
      const capacity =
        safe === null
          ? cmp(cap, "0.0000") > 0
            ? cap
            : null
          : cmp(cap, "0.0000") > 0 && cmp(cap, safe) < 0
            ? cap
            : safe;
      const remaining: ForecastEntry[] = [];
      let spent = "0.0000";
      let paid = "0.0000";
      for (const e of backlog) {
        if (capacity === null || cmp(add(spent, e.amount), capacity) <= 0) {
          spent = add(spent, e.amount);
          paid = add(paid, e.amount);
        } else {
          remaining.push(e);
        }
      }
      backlog = remaining;
      apOutflow = paid;
    }
    running = add(running, add(arInflow, neg(apOutflow)));
    weeks.push({ weekStart: k, inflow: arInflow, outflow: apOutflow, endingCash: running });
    if (cmp(running, lowestCash) < 0) {
      lowestCash = running;
      lowestWeek = k;
    }
  }
  return { weeks, lowestCash, lowestWeek };
}

/**
 * The cashflow board's AP scheduling knobs (orgs.settings.analytics.cashflow
 * over the defaults: weeklyApCap "0.0000" = unlimited, restrictToSafe 0),
 * clamped exactly like the config surface clamps them.
 */
async function cashflowSettings(orgId: string): Promise<{ weeklyCap: string; restrictToSafe: boolean }> {
  const res = await db.execute<{ cfg: unknown }>(sql`
    select settings -> 'analytics' -> 'cashflow' as cfg from orgs where id = ${orgId}
  `);
  const stored = (res.rows[0]?.cfg ?? {}) as { weeklyApCap?: unknown; restrictToSafe?: unknown };
  let weeklyCap = "0.0000";
  try {
    const amount = normalizeMoney(String(stored.weeklyApCap ?? "0"));
    if (cmp(amount, "0.0000") >= 0 && cmp(amount, "100000000.0000") <= 0) weeklyCap = amount;
  } catch {
    weeklyCap = "0.0000";
  }
  const restrictRaw = Number(stored.restrictToSafe ?? 0);
  const restrictToSafe = Number.isFinite(restrictRaw) && Math.min(1, Math.max(0, restrictRaw)) >= 1;
  return { weeklyCap, restrictToSafe };
}

export async function cashFindings(
  orgId: string,
  agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
): Promise<AgentFinding[]> {
  const today = await businessToday(orgId);
  const findings: AgentFinding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));

  const balancePolicy = byKey.get("cash_low_balance");
  const crunchPolicy = byKey.get("cash_bill_crunch");
  const forecastPolicy = byKey.get("cash_forecast_shortfall");
  if (!balancePolicy?.enabled && !crunchPolicy?.enabled && !forecastPolicy?.enabled) return findings;

  const base = await cashBaseCurrency(orgId);
  const banks = await bankAccountBalances(orgId, base, today);
  const startingCash = sum(banks.map((b) => b.balance));

  if (balancePolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(balancePolicy, agentThreshold);
    // The floor is the alert: cash under it flags with the shortfall.
    if (cmp(startingCash, threshold) < 0) {
      const shortfall = add(threshold, neg(startingCash));
      findings.push({
        agentKey: "cash",
        findingType: "cash_low_balance",
        fingerprint: "cash-low-balance",
        severity: classifyForensicItem({
          materiality: shortfall,
          threshold,
          criticalMaterialityMultiple: balancePolicy.parameters.criticalMaterialityMultiple,
        }),
        confidence: "1.0000",
        materiality: shortfall,
        summary: {
          total: startingCash,
          floor: threshold,
          shortfall,
          base,
          asOf: today,
          accounts: banks.map((b) => ({ id: b.id, name: b.name, number: b.number, balance: b.balance })),
          href: CASH_HREF,
        },
        evidence: [
          {
            kind: "cash_balance",
            data: { total: startingCash, floor: threshold, shortfall, base, measuredAt: today },
          },
        ],
      });
    }
  }

  const apItems =
    crunchPolicy?.enabled || forecastPolicy?.enabled ? await sideOpenItems(orgId, base, "ap", today) : [];
  const arItems = forecastPolicy?.enabled ? await sideOpenItems(orgId, base, "ar", today) : [];

  if (crunchPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(crunchPolicy, agentThreshold);
    const horizon = addCalendarDays(today, crunchPolicy.parameters.dueWithinDays!);
    // Payables due inside the window (undated items count from their
    // transaction date, like the forecast's prediction input).
    const due = apItems.filter((item) => toISO(item.dueDate ?? item.tranDate) <= horizon);
    const dueTotal = sum(due.map((item) => item.remaining));
    if (cmp(dueTotal, startingCash) > 0) {
      const excess = add(dueTotal, neg(startingCash));
      if (cmp(excess, threshold) >= 0) {
        const bills = [...due]
          .filter((item) => item.docKind === "vendor_bill" || item.docKind === "expense_report")
          .sort((a, b) => cmp(b.remaining, a.remaining))
          .slice(0, 10);
        findings.push({
          agentKey: "cash",
          findingType: "cash_bill_crunch",
          fingerprint: "cash-bill-crunch",
          severity: classifyForensicItem({
            materiality: excess,
            threshold,
            criticalMaterialityMultiple: crunchPolicy.parameters.criticalMaterialityMultiple,
          }),
          confidence: "1.0000",
          materiality: excess,
          summary: {
            dueTotal,
            cashTotal: startingCash,
            excess,
            billCount: due.length,
            horizon,
            dueWithinDays: crunchPolicy.parameters.dueWithinDays,
            base,
            asOf: today,
            href: CASH_HREF,
          },
          evidence: [
            {
              kind: "cash_crunch",
              data: {
                dueTotal,
                cashTotal: startingCash,
                excess,
                horizon,
                bills: bills.map((item) => ({
                  docNumber: item.docNumber,
                  party: item.partyName,
                  amount: item.remaining,
                  dueDate: item.dueDate ? toISO(item.dueDate) : null,
                })),
                measuredAt: today,
              },
            },
          ],
        });
      }
    }
  }

  if (forecastPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(forecastPolicy, agentThreshold);
    const horizonWeeks = forecastPolicy.parameters.forecastWeeks!;
    const asOf = parseISO(today);
    const start = weekStart(asOf);
    const end = addDays(start, horizonWeeks * 7 - 1);
    const weekStarts: string[] = [];
    for (let cur = new Date(start); cur <= end; cur = addDays(cur, 7)) weekStarts.push(toISO(cur));
    const [arStats, apStats, settings] = await Promise.all([
      settlementStats(orgId, "ar", today),
      settlementStats(orgId, "ap", today),
      cashflowSettings(orgId),
    ]);
    const timeline = rollTimeline({
      weekStarts,
      startingCash,
      arByWeek: scheduleByWeek(arItems, arStats, asOf, start, end),
      apByWeek: scheduleByWeek(apItems, apStats, asOf, start, end),
      weeklyCap: settings.weeklyCap,
      restrictToSafe: settings.restrictToSafe,
    });
    // The cockpit's own signal: the timeline's lowest point.
    if (cmp(timeline.lowestCash, "0.0000") < 0 && cmp(moneyAbs(timeline.lowestCash), threshold) >= 0) {
      findings.push({
        agentKey: "cash",
        findingType: "cash_forecast_shortfall",
        fingerprint: "cash-forecast-shortfall",
        severity: classifyForensicItem({
          materiality: moneyAbs(timeline.lowestCash),
          threshold,
          criticalMaterialityMultiple: forecastPolicy.parameters.criticalMaterialityMultiple,
        }),
        confidence: "1.0000",
        materiality: moneyAbs(timeline.lowestCash),
        summary: {
          lowestCash: timeline.lowestCash,
          lowestWeek: timeline.lowestWeek,
          startingCash,
          horizonWeeks,
          weeklyCap: settings.weeklyCap,
          restrictToSafe: settings.restrictToSafe,
          openItemCashOnly: true,
          base,
          asOf: today,
          href: CASH_HREF,
        },
        evidence: [
          {
            kind: "cash_forecast",
            data: {
              lowestCash: timeline.lowestCash,
              lowestWeek: timeline.lowestWeek,
              startingCash,
              weeks: timeline.weeks,
              measuredAt: today,
            },
          },
        ],
      });
    }
  }

  return findings;
}
