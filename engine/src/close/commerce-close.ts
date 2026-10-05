import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { fetchChannelDayTotals } from "../commerce/shopify/day-totals.ts";
import { addCloseEvidence } from "./tasks.ts";

/**
 * Commerce close completeness: the proof that every storefront sale reached
 * the ledger. Each function here is a close checklist item with evidence and
 * a remedy link — the month-end close consumes them through readinessChecks,
 * the daily dashboard through the channels completeness route. Both modes
 * share this one implementation so the daily tile and the close package can
 * never disagree.
 *
 * OpenBooks is the book of record, so the subledger never proves itself:
 * order counts and gross totals are measured against the storefront's own
 * numbers (Shopify orders via GraphQL), payouts against posted settlement
 * batches, and every liability roll-forward against its ledger accounts.
 * Anything the proof cannot read refuses by name instead of passing.
 */

export interface CommerceCloseScope {
  startsOn: string;
  endsOn: string;
  bookId: string;
  subsidiaryIds?: string[];
}

export type CommerceCheckSeverity = "warning" | "error" | "critical";

export interface CommerceCloseCheck {
  code: string;
  taskKey: "commerce-complete";
  category: "commerce";
  severity: CommerceCheckSeverity;
  title: string;
  message: string;
  count: number;
  details?: Record<string, unknown>;
}

export interface StorefrontDayTotal {
  orderCount: number;
  grossMinor: bigint;
  currency: string;
}

export type StorefrontTotalsProvider = (
  orgId: string,
  channelId: string,
  day: string,
) => Promise<StorefrontDayTotal>;

/** Lines posted this close to period end may still be in flight to the bank. */
const IN_TRANSIT_DAYS = 5;

type ChannelRow = {
  id: string;
  name: string;
  kind: string;
  currency: string;
};

function eachDay(startsOn: string, endsOn: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${startsOn}T00:00:00Z`);
  const end = new Date(`${endsOn}T00:00:00Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

async function activeChannels(
  orgId: string,
  subsidiaryIds: string[],
): Promise<ChannelRow[]> {
  const rows = (
    await db.execute<ChannelRow & { subsidiary_id: string | null }>(sql`
      select id, name, kind, currency from sales_channels
       where org_id = ${orgId} and status = 'active'
         and (${subsidiaryIds.length === 0} or subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))`)
  ).rows;
  return rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, currency: row.currency }));
}

type IngestedDayRow = {
  channel_id: string;
  day: string;
  shop_currency: string;
  order_count: string;
  gross_minor: string;
};

async function ingestedDayTotals(orgId: string, scope: CommerceCloseScope): Promise<IngestedDayRow[]> {
  return (
    await db.execute<IngestedDayRow>(sql`
      select o.channel_id,
             (o.ordered_at at time zone 'UTC')::date::text as day,
             o.shop_currency,
             count(*)::text as order_count,
             coalesce(sum(o.total_minor), 0)::text as gross_minor
        from channel_orders o
       where o.org_id = ${orgId}
         and (o.ordered_at at time zone 'UTC')::date between ${scope.startsOn}::date and ${scope.endsOn}::date
         and o.posting_status <> 'excluded'
       group by o.channel_id, ((o.ordered_at at time zone 'UTC')::date), o.shop_currency`)
  ).rows;
}

type UnpostedRow = {
  pending_orders: string;
  pending_events: string;
};

async function unpostedCounts(orgId: string, scope: CommerceCloseScope): Promise<UnpostedRow> {
  const rows = (
    await db.execute<UnpostedRow>(sql`
      select
        ((select count(*) from channel_orders o
           where o.org_id = ${orgId} and o.posting_status = 'pending'
             and (o.ordered_at at time zone 'UTC')::date between ${scope.startsOn}::date and ${scope.endsOn}::date))::text as pending_orders,
        ((select count(*) from channel_order_events e
           where e.org_id = ${orgId} and e.posting_status = 'pending'
             and (e.occurred_at at time zone 'UTC')::date between ${scope.startsOn}::date and ${scope.endsOn}::date))::text as pending_events`)
  ).rows;
  return rows[0] ?? { pending_orders: "0", pending_events: "0" };
}

interface DayGap {
  channelId: string;
  channelName: string;
  day: string;
  currency: string;
  storefrontCount: number;
  ingestedCount: number;
  missingCount: number;
  storefrontGrossMinor: string;
  ingestedGrossMinor: string;
  grossGapMinor: string;
  remedyHref: string;
}

async function orderCompletenessCheck(
  orgId: string,
  scope: CommerceCloseScope,
  provider: StorefrontTotalsProvider,
): Promise<{ check: CommerceCloseCheck; unreachable: CommerceCloseCheck }> {
  const channels = await activeChannels(orgId, scope.subsidiaryIds ?? []);
  const ingested = await ingestedDayTotals(orgId, scope);
  const unposted = await unpostedCounts(orgId, scope);
  const byChannelDay = new Map<string, { count: number; gross: bigint; currency: string }>();
  for (const row of ingested) {
    const key = `${row.channel_id}|${row.day}|${row.shop_currency}`;
    const current = byChannelDay.get(key) ?? { count: 0, gross: 0n, currency: row.shop_currency };
    current.count += Number(row.order_count);
    current.gross += BigInt(row.gross_minor);
    byChannelDay.set(key, current);
  }
  const gaps: DayGap[] = [];
  const unreachable: { channelId: string; channelName: string; day: string; error: string }[] = [];
  type DayOutcome =
    | { day: string; skipped: true }
    | { day: string; skipped: false; totals: StorefrontDayTotal }
    | { day: string; skipped: false; error: string };
  // One storefront read per channel day: the external truth ingestion is
  // measured against. Days run in parallel per channel; a refusal to answer
  // is recorded as unverifiable, never as agreement.
  for (const channel of channels) {
    const days = eachDay(scope.startsOn, scope.endsOn);
    const outcomes: DayOutcome[] = await Promise.all(
      days.map(async (day): Promise<DayOutcome> => {
        if (channel.kind !== "shopify") return { day, skipped: true };
        try {
          const totals = await provider(orgId, channel.id, day);
          return { day, skipped: false, totals };
        } catch (error) {
          return {
            day,
            skipped: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.skipped) continue;
      if ("error" in outcome) {
        unreachable.push({
          channelId: channel.id,
          channelName: channel.name,
          day: outcome.day,
          error: outcome.error,
        });
        continue;
      }
        const key = `${channel.id}|${outcome.day}|${outcome.totals.currency}`;
      const seen = byChannelDay.get(key) ?? { count: 0, gross: 0n, currency: outcome.totals.currency };
      const missingCount = Math.max(0, outcome.totals.orderCount - seen.count);
      const grossGap = outcome.totals.grossMinor - seen.gross;
      if (missingCount > 0 || grossGap !== 0n) {
        gaps.push({
          channelId: channel.id,
          channelName: channel.name,
          day: outcome.day,
          currency: outcome.totals.currency,
          storefrontCount: outcome.totals.orderCount,
          ingestedCount: seen.count,
          missingCount,
          storefrontGrossMinor: outcome.totals.grossMinor.toString(),
          ingestedGrossMinor: seen.gross.toString(),
          grossGapMinor: grossGap.toString(),
          remedyHref: `/channels/${channel.id}?tab=orders`,
        });
      }
    }
  }
  const pendingOrders = Number(unposted.pending_orders);
  const pendingEvents = Number(unposted.pending_events);
  const count = gaps.length + pendingOrders + pendingEvents;
  return {
    check: {
      code: "commerce-orders-incomplete",
      taskKey: "commerce-complete",
      category: "commerce",
      severity: "critical",
      title: "close.diagnostics.commerce-orders-incomplete.title",
      message: "close.diagnostics.commerce-orders-incomplete.message",
      count,
      details: {
        gaps,
        pendingOrders,
        pendingEvents,
        scope: { startsOn: scope.startsOn, endsOn: scope.endsOn },
      },
    },
    unreachable: {
      code: "commerce-storefront-unreachable",
      taskKey: "commerce-complete",
      category: "commerce",
      severity: "error",
      title: "close.diagnostics.commerce-storefront-unreachable.title",
      message: "close.diagnostics.commerce-storefront-unreachable.message",
      count: unreachable.length,
      details: { days: unreachable },
    },
  };
}

type PayoutRow = {
  provider: string;
  external_ref: string;
  settlement_date: string;
  currency: string;
  net_amount: string;
};

/**
 * Every payout settled in the window must be posted. A dedicated
 * payout-to-order reconciliation record does not exist on main yet, so the
 * proof is the posted settlement batch itself: a draft batch holds money
 * the ledger has never seen.
 */
async function payoutCheck(orgId: string, scope: CommerceCloseScope): Promise<CommerceCloseCheck> {
  const subsidiaryIds = scope.subsidiaryIds ?? [];
  const rows = (
    await db.execute<PayoutRow>(sql`
      select provider, external_ref, settlement_date::text, currency, net_amount::text
        from psp_settlement_batches
       where org_id = ${orgId} and status = 'draft'
         and settlement_date between ${scope.startsOn}::date and ${scope.endsOn}::date
         and (${subsidiaryIds.length === 0} or subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
       order by settlement_date, provider`)
  ).rows;
  return {
    code: "commerce-payouts-unposted",
    taskKey: "commerce-complete",
    category: "commerce",
    severity: "critical",
    title: "close.diagnostics.commerce-payouts-unposted.title",
    message: "close.diagnostics.commerce-payouts-unposted.message",
    count: rows.length,
    details: {
      batches: rows.map((row) => ({
        provider: row.provider,
        externalRef: row.external_ref,
        settlementDate: row.settlement_date,
        currency: row.currency,
        netAmount: row.net_amount,
        remedyHref: "/banking/psp-settlements",
      })),
    },
  };
}

type ClearingRow = {
  account_id: string;
  number: string | null;
  name: string;
  currency: string;
  residual: string;
  line_count: string;
  in_transit_count: string;
  in_transit_sum: string;
};

/**
 * Gateway clearing (and the PSP batches' own clearing accounts, typically
 * undeposited funds) must clear to zero: money captured but not yet paid out
 * cannot sit unexplained at close. Lines posted in the last
 * in-transit window are named as possibly still in flight; anything older is
 * a genuine residual. Acknowledging in-transit money is the task waive with
 * its reason, not a silent pass.
 */
async function clearingCheck(orgId: string, scope: CommerceCloseScope): Promise<CommerceCloseCheck> {
  const subsidiaryIds = scope.subsidiaryIds ?? [];
  const subsidiaryFilter = subsidiaryIds.length === 0
    ? sql`true`
    : sql`l.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[])`;
  const rows = (
    await db.execute<ClearingRow>(sql`
      with clearing_accounts as (
        select distinct m.account_id
          from sales_channel_account_maps m
          join sales_channels c on c.org_id = m.org_id and c.id = m.channel_id
         where m.org_id = ${orgId} and m.role in ('gateway_clearing', 'refund_clearing')
           and m.effective_from <= ${scope.endsOn}::date
           and (m.effective_to is null or m.effective_to >= ${scope.startsOn}::date)
           and (${subsidiaryIds.length === 0} or c.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
        union
        select distinct b.clearing_account_id as account_id
          from psp_settlement_batches b
         where b.org_id = ${orgId} and b.clearing_account_id is not null
           and b.settlement_date between ${scope.startsOn}::date and ${scope.endsOn}::date
           and (${subsidiaryIds.length === 0} or b.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
      )
      select l.account_id::text as account_id, a.number, a.name, l.currency as currency,
             coalesce(sum(l.txn_amount), 0)::text as residual,
             count(*)::text as line_count,
             count(*) filter (where l.posting_date > (${scope.endsOn}::date - ${IN_TRANSIT_DAYS}::integer))::text as in_transit_count,
             coalesce(sum(l.txn_amount) filter (where l.posting_date > (${scope.endsOn}::date - ${IN_TRANSIT_DAYS}::integer)), 0)::text as in_transit_sum
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
       where l.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
         and l.posting_date <= ${scope.endsOn}::date
         and l.account_id in (select account_id from clearing_accounts)
         and ${subsidiaryFilter}
       group by l.account_id, a.number, a.name, l.currency
      having coalesce(sum(l.txn_amount), 0) <> 0
       order by a.number nulls last, a.name, l.currency`)
  ).rows;
  return {
    code: "commerce-clearing-residual",
    taskKey: "commerce-complete",
    category: "commerce",
    severity: "critical",
    title: "close.diagnostics.commerce-clearing-residual.title",
    message: "close.diagnostics.commerce-clearing-residual.message",
    count: rows.length,
    details: {
      inTransitDays: IN_TRANSIT_DAYS,
      accounts: rows.map((row) => ({
        accountId: row.account_id,
        number: row.number,
        name: row.name,
        currency: row.currency,
        residual: row.residual,
        lineCount: Number(row.line_count),
        inTransitCount: Number(row.in_transit_count),
        inTransitSum: row.in_transit_sum,
        remedyHref: "/channels",
      })),
    },
  };
}

type StoredValueTieRow = {
  account_id: string | null;
  number: string | null;
  name: string | null;
  subledger: string | null;
  ledger: string;
  gap: string | null;
};

type StoredValueBreakdownRow = {
  account_id: string | null;
  side: string;
  currency: string;
  amount: string | null;
};

/**
 * Stored-value liability roll-forward: outstanding card and credit balances
 * per liability account tie to the ledger legs on that account. Both sides
 * sum at par in ledger decimals — card balances are ten-thousandths (the
 * journal posts them through fromUnits), journal legs through their
 * transaction amounts — because that is how the postings are written (a
 * foreign-currency card posts its legs in the subsidiary currency at par,
 * with no FX conversion). Every subledger movement carries a matching
 * par-valued leg, so the account total ties whatever currencies the cards
 * were sold in; a stray manual journal with no card behind it breaks it. A
 * card with no resolvable liability account fails closed rather than
 * reading zero.
 */
async function storedValueCheck(orgId: string, scope: CommerceCloseScope): Promise<CommerceCloseCheck> {
  const rows = (
    await db.execute<StoredValueTieRow>(sql`
      with subledger as (
        -- Stored-value minor units are ten-thousandths (the journal posts
        -- them through fromUnits), not currency cents: the divisor is always
        -- 10^4, whatever currency the card was sold in.
        select coalesce(a.liability_account_id, p.liability_account_id) as account_id,
               sum(a.balance_minor / 10000::numeric)::numeric as subtotal
          from stored_value_accounts a
          join stored_value_programs p on p.org_id = a.org_id and p.id = a.program_id
         where a.org_id = ${orgId}
         group by coalesce(a.liability_account_id, p.liability_account_id)
      ),
      ledger as (
        select l.account_id, coalesce(sum(l.txn_amount), 0)::numeric as ledger_sum
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
           and l.posting_date <= ${scope.endsOn}::date
           and l.account_id in (select account_id from subledger where account_id is not null)
         group by l.account_id
      )
      select coalesce(s.account_id, g.account_id)::text as account_id, a.number, a.name,
             round(coalesce(s.subtotal, 0), 4)::text as subledger,
             round(coalesce(g.ledger_sum, 0), 4)::text as ledger,
             case when s.account_id is null and g.account_id is null then null
                  else round(coalesce(g.ledger_sum, 0) + coalesce(s.subtotal, 0), 4)::text end as gap
        from (select * from subledger) s
        full outer join ledger g on g.account_id = s.account_id
        left join accounts a on a.org_id = ${orgId} and a.id = coalesce(s.account_id, g.account_id)
       where coalesce(s.subtotal, 0) <> 0 or coalesce(g.ledger_sum, 0) <> 0 or s.account_id is null
       order by a.number nulls last, a.name`)
  ).rows;
  // A null gap means the tie is unmeasurable (no liability account, or a
  // currency the registry cannot convert) — it fails closed.
  const gaps = rows.filter((row) => row.gap === null || Number(row.gap) !== 0);
  let breakdown: StoredValueBreakdownRow[] = [];
  if (gaps.length > 0) {
    const accountIds = gaps.map((row) => row.account_id).filter((id): id is string => id !== null);
    breakdown = (
      await db.execute<StoredValueBreakdownRow>(sql`
        (select s.account_id::text as account_id, 'subledger' as side, s.currency as currency,
                round(sum(s.balance_minor / 10000::numeric), 4)::text as amount
           from (select coalesce(a.liability_account_id, p.liability_account_id) as account_id,
                        a.currency as currency, a.balance_minor as balance_minor
                   from stored_value_accounts a
                   join stored_value_programs p on p.org_id = a.org_id and p.id = a.program_id
                  where a.org_id = ${orgId}) s
          where s.account_id = any(${`{${accountIds.join(",")}}`}::uuid[])
          group by s.account_id, s.currency)
        union all
        (select l.account_id::text as account_id, 'ledger' as side, l.currency as currency,
                round(coalesce(sum(l.txn_amount), 0), 4)::text as amount
           from journal_lines l
           join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          where l.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
            and l.posting_date <= ${scope.endsOn}::date
            and l.account_id = any(${`{${accountIds.join(",")}}`}::uuid[])
          group by l.account_id, l.currency)
        order by account_id, side, currency`)
    ).rows;
  }
  return {
    code: "commerce-stored-value-gap",
    taskKey: "commerce-complete",
    category: "commerce",
    severity: "error",
    title: "close.diagnostics.commerce-stored-value-gap.title",
    message: "close.diagnostics.commerce-stored-value-gap.message",
    count: gaps.length,
    details: {
      ties: gaps.map((row) => ({
        accountId: row.account_id,
        number: row.number,
        name: row.name,
        subledger: row.subledger,
        ledger: row.ledger,
        gap: row.gap,
        breakdown: breakdown
          .filter((line) => line.account_id === row.account_id)
          .map((line) => ({ side: line.side, currency: line.currency, amount: line.amount })),
        remedyHref: "/stored-value",
      })),
    },
  };
}

type DeferredTieRow = {
  account_id: string;
  number: string | null;
  name: string;
  plan: string;
  ledger: string;
  gap: string;
  obligations: string;
};

/**
 * Deferred-revenue roll-forward: the ledger's deferred balance per account
 * ties to the unrecognized recognition plan. Unrecognized means a nonzero
 * line with no journal behind it on a live schedule — the same population
 * the recognition runner measures as due, minus the forecast rules that
 * never post. Deferred is a credit balance, so ledger plus plan is zero.
 */
async function deferredCheck(orgId: string, scope: CommerceCloseScope): Promise<CommerceCloseCheck> {
  const rows = (
    await db.execute<DeferredTieRow>(sql`
      with plan as (
        select coalesce(o.deferred_account_id, r.deferred_account_id) as account_id,
               coalesce(sum(l.planned_amount), 0)::numeric as plan,
               count(distinct o.id)::integer as obligations
          from recognition_schedule_lines l
          join recognition_schedules s on s.org_id = l.org_id and s.id = l.schedule_id
          join performance_obligations o on o.org_id = l.org_id and o.id = s.obligation_id
          join recognition_rules r on r.org_id = l.org_id and r.id = o.recognition_rule_id
         where l.org_id = ${orgId} and s.book_id = ${scope.bookId}
           and l.journal_entry_id is null and l.planned_amount <> 0
           and o.status <> 'cancelled' and s.status <> 'cancelled' and not r.is_forecast
           and coalesce(o.deferred_account_id, r.deferred_account_id) is not null
         group by coalesce(o.deferred_account_id, r.deferred_account_id)
      ),
      ledger as (
        select l.account_id, coalesce(sum(l.amount), 0)::numeric as ledger_sum
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
           and l.posting_date <= ${scope.endsOn}::date
         group by l.account_id
      )
      select p.account_id::text as account_id, a.number, a.name,
             p.plan::text as plan,
             coalesce(g.ledger_sum, 0)::text as ledger,
             (coalesce(g.ledger_sum, 0) + p.plan)::text as gap,
             p.obligations::text as obligations
        from plan p
        join accounts a on a.org_id = ${orgId} and a.id = p.account_id
        left join ledger g on g.account_id = p.account_id
       where (coalesce(g.ledger_sum, 0) + p.plan) <> 0
       order by a.number nulls last, a.name`)
  ).rows;
  return {
    code: "commerce-deferred-gap",
    taskKey: "commerce-complete",
    category: "commerce",
    severity: "error",
    title: "close.diagnostics.commerce-deferred-gap.title",
    message: "close.diagnostics.commerce-deferred-gap.message",
    count: rows.length,
    details: {
      ties: rows.map((row) => ({
        accountId: row.account_id,
        number: row.number,
        name: row.name,
        unrecognizedPlan: row.plan,
        ledger: row.ledger,
        gap: row.gap,
        obligations: Number(row.obligations),
        remedyHref: "/revenue",
      })),
    },
  };
}

type ContractCostTieRow = {
  asset_id: string;
  currency: string;
  status: string;
  capitalized: string;
  amortized: string;
  ledger: string;
  gap: string;
};

/**
 * Contract-cost (ASC 340-40) roll-forward: each capitalized cost's carrying
 * value ties to its own ledger legs through the contributor linkage the
 * capitalization, amortization and impairment postings all carry. Active
 * assets tie exactly; an impaired asset ties with its write-down named (the
 * ledger may only sit below carrying, never above it). Costs the practical
 * expedient sent straight to expense never touch the asset account and are
 * reported, not tied.
 */
async function contractCostCheck(orgId: string, scope: CommerceCloseScope): Promise<CommerceCloseCheck> {
  const rows = (
    await db.execute<ContractCostTieRow>(sql`
      with amortized as (
        select m.asset_id, coalesce(sum(m.amount_minor), 0)::numeric as amort_minor
          from contract_cost_amortization m
          join accounting_periods p on p.org_id = m.org_id and p.id = m.period_id
         where m.org_id = ${orgId} and p.ends_on <= ${scope.endsOn}::date
         group by m.asset_id
      ),
      ledger as (
        select l.contributor_ref as asset_id, l.currency as currency,
               coalesce(sum(l.txn_amount), 0)::numeric as ledger_sum
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
           and l.posting_date <= ${scope.endsOn}::date
           and l.contributor_kind = 'contract_cost_asset'
         group by l.contributor_ref, l.currency
      )
      select c.id::text as asset_id, c.currency as currency, c.status as status,
             round(c.amount_minor / power(10::numeric, cur.minor_units), 4)::text as capitalized,
             round(coalesce(a.amort_minor, 0) / power(10::numeric, cur.minor_units), 4)::text as amortized,
             round(coalesce(g.ledger_sum, 0), 4)::text as ledger,
             round(coalesce(g.ledger_sum, 0)
                - (c.amount_minor - coalesce(a.amort_minor, 0)) / power(10::numeric, cur.minor_units), 4)::text as gap
        from contract_cost_assets c
        left join amortized a on a.asset_id = c.id
        left join ledger g on g.asset_id = c.id and g.currency = c.currency
        left join currencies cur on cur.code = c.currency
       where c.org_id = ${orgId} and c.capitalized_on <= ${scope.endsOn}::date
         and c.status in ('active', 'fully_amortized', 'impaired')
       order by c.currency, c.capitalized_on`)
  ).rows;
  const gaps = rows.filter((row) => {
    if (row.status === "impaired") return Number(row.gap) > 0;
    return Number(row.gap) !== 0;
  });
  const expensed = (
    await db.execute<{ count: string }>(sql`
      select count(*)::text as count from contract_cost_assets
       where org_id = ${orgId} and status = 'expensed'
         and capitalized_on <= ${scope.endsOn}::date`)
  ).rows[0];
  return {
    code: "commerce-contract-cost-gap",
    taskKey: "commerce-complete",
    category: "commerce",
    severity: "error",
    title: "close.diagnostics.commerce-contract-cost-gap.title",
    message: "close.diagnostics.commerce-contract-cost-gap.message",
    count: gaps.length,
    details: {
      expensedAssets: Number(expensed?.count ?? "0"),
      ties: gaps.map((row) => ({
        assetId: row.asset_id,
        currency: row.currency,
        status: row.status,
        capitalized: row.capitalized,
        amortized: row.amortized,
        ledger: row.ledger,
        gap: row.gap,
        remedyHref: "/revenue/contract-costs",
      })),
    },
  };
}

type ExceptionQueueRow = {
  kind: string;
  channel_id: string;
  channel_name: string;
  reference: string;
  code: string | null;
  reason: string | null;
  occurred_on: string;
};

/**
 * The exception queue: parked orders and events in the window, each with its
 * code, reason and remedy. Deliberately scoped-out rows (excluded, with its
 * reason) are the acknowledgement — they never appear here. Anything else
 * still parked blocks the close until it posts or is scoped out.
 */
async function exceptionCheck(orgId: string, scope: CommerceCloseScope): Promise<CommerceCloseCheck> {
  const rows = (
    await db.execute<ExceptionQueueRow>(sql`
      (select 'order' as kind, o.channel_id, c.name as channel_name,
              o.external_number as reference, o.exception_code as code,
              o.exception_reason as reason,
              (o.ordered_at at time zone 'UTC')::date::text as occurred_on
         from channel_orders o
         join sales_channels c on c.org_id = o.org_id and c.id = o.channel_id
        where o.org_id = ${orgId} and o.posting_status = 'exception'
          and (o.ordered_at at time zone 'UTC')::date between ${scope.startsOn}::date and ${scope.endsOn}::date)
      union all
      (select e.kind as kind, e.channel_id, c.name as channel_name,
              o.external_number as reference, e.exception_code as code,
              e.exception_reason as reason,
              (e.occurred_at at time zone 'UTC')::date::text as occurred_on
         from channel_order_events e
         join channel_orders o on o.org_id = e.org_id and o.id = e.order_id
         join sales_channels c on c.org_id = e.org_id and c.id = e.channel_id
        where e.org_id = ${orgId} and e.posting_status = 'exception'
          and (e.occurred_at at time zone 'UTC')::date between ${scope.startsOn}::date and ${scope.endsOn}::date)
      order by occurred_on, reference`)
  ).rows;
  return {
    code: "commerce-exceptions-open",
    taskKey: "commerce-complete",
    category: "commerce",
    severity: "error",
    title: "close.diagnostics.commerce-exceptions-open.title",
    message: "close.diagnostics.commerce-exceptions-open.message",
    count: rows.length,
    details: {
      parked: rows.map((row) => ({
        kind: row.kind,
        channelId: row.channel_id,
        channelName: row.channel_name,
        reference: row.reference,
        code: row.code,
        reason: row.reason,
        occurredOn: row.occurred_on,
        remedyHref: `/channels/${row.channel_id}?tab=exceptions`,
      })),
    },
  };
}

const defaultStorefrontTotals: StorefrontTotalsProvider = (orgId, channelId, day) =>
  fetchChannelDayTotals(orgId, channelId, day).then((totals) => ({
    orderCount: totals.orderCount,
    grossMinor: totals.grossMinor,
    currency: totals.currency,
  }));

/**
 * The month-end evidence snapshot: the eight proofs with their counts and
 * drill details, frozen onto the commerce task with the run fingerprint it
 * proves. Idempotent per fingerprint — a refresh that changes nothing
 * attaches nothing new, and evidence from an older fingerprint stays as the
 * history of what the operator actually signed. Returns the evidence id, or
 * null when the task is not complete (nothing proven yet).
 */
export async function snapshotCommerceCloseEvidence(
  orgId: string,
  runId: string,
  actorId: string | undefined,
): Promise<string | null> {
  const run = (
    await db.execute<{
      period_id: string;
      book_id: string;
      data_fingerprint: string | null;
      scope: { subsidiaryIds?: string[] };
      starts_on: string;
      ends_on: string;
      task_id: string | null;
      task_status: string | null;
    }>(sql`
      select r.period_id, r.book_id, r.data_fingerprint, r.scope,
             p.starts_on::text, p.ends_on::text,
             t.id as task_id, t.status as task_status
        from close_runs r
        join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
        left join close_run_tasks t on t.run_id = r.id and t.org_id = r.org_id and t.key = 'commerce-complete'
       where r.id = ${runId} and r.org_id = ${orgId}`)
  ).rows[0];
  // Evidence is signed work: a refresh with no actor cannot sign it.
  if (!run?.task_id || run.task_status !== "complete" || !run.data_fingerprint || !actorId) return null;
  const existing = (
    await db.execute<{ id: string }>(sql`
      select id from close_task_evidence
       where org_id = ${orgId} and run_id = ${runId} and task_id = ${run.task_id}
         and evidence_type = 'report' and snapshot->>'fingerprint' = ${run.data_fingerprint}
       limit 1`)
  ).rows[0];
  if (existing) return existing.id;
  const checks = await commerceCloseChecks(orgId, {
    startsOn: run.starts_on,
    endsOn: run.ends_on,
    bookId: run.book_id,
    subsidiaryIds: run.scope?.subsidiaryIds ?? [],
  });
  return addCloseEvidence({
    orgId,
    runId,
    taskId: run.task_id,
    actorId,
    evidenceType: "report",
    label: "Commerce completeness evidence",
    snapshot: {
      fingerprint: run.data_fingerprint,
      scope: { startsOn: run.starts_on, endsOn: run.ends_on },
      checks: checks.map((check) => ({
        code: check.code,
        severity: check.severity,
        count: check.count,
        details: check.details ?? {},
      })),
    },
  });
}

/**
 * Every commerce completeness check for one scope, in checklist order. The
 * storefront reader defaults to the live Shopify fetch; tests inject a
 * scripted provider (the network is the seam, never the math).
 */
export async function commerceCloseChecks(
  orgId: string,
  scope: CommerceCloseScope,
  options: { storefrontTotals?: StorefrontTotalsProvider } = {},
): Promise<CommerceCloseCheck[]> {
  const provider = options.storefrontTotals ?? defaultStorefrontTotals;
  const { check: orders, unreachable } = await orderCompletenessCheck(orgId, scope, provider);
  const [payouts, clearing, storedValue, deferred, contractCosts, exceptions] = await Promise.all([
    payoutCheck(orgId, scope),
    clearingCheck(orgId, scope),
    storedValueCheck(orgId, scope),
    deferredCheck(orgId, scope),
    contractCostCheck(orgId, scope),
    exceptionCheck(orgId, scope),
  ]);
  return [orders, unreachable, payouts, clearing, storedValue, deferred, contractCosts, exceptions];
}
