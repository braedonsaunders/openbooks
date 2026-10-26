import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { MATCHABLE_SETTLEMENT_LINE_KINDS } from "../payments/psp-settlement.ts";
import { fetchChannelDayTotals } from "../commerce/shopify/day-totals.ts";
import { addCloseEvidence } from "./tasks.ts";
import { defaultPostingSubsidiaryId, loadSubsidiaryContext } from "../organization/subsidiaries.ts";

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
  fallbackSubsidiaryId: string,
): Promise<ChannelRow[]> {
  const rows = await db.execute<ChannelRow & { subsidiary_id: string | null }>(
    sql`
      select c.id, c.name, c.kind, c.currency from sales_channels c
       where c.org_id = ${orgId} and c.status = 'active'
         and (${subsidiaryIds.length === 0} or coalesce(c.subsidiary_id, ${fallbackSubsidiaryId}) = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))`,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    currency: row.currency,
  }));
}

type IngestedDayRow = {
  channel_id: string;
  day: string;
  shop_currency: string;
  order_count: string;
  gross_minor: string;
};

async function ingestedDayTotals(
  orgId: string,
  scope: CommerceCloseScope,
  fallbackSubsidiaryId: string,
): Promise<IngestedDayRow[]> {
  const subsidiaryIds = scope.subsidiaryIds ?? [];
  return await db.execute<IngestedDayRow>(
    sql`
      select o.channel_id,
             (o.ordered_at at time zone 'UTC')::date::text as day,
             o.shop_currency,
             count(*)::text as order_count,
             coalesce(sum(o.total_minor), 0)::text as gross_minor
        from channel_orders o
        join sales_channels c on c.org_id = o.org_id and c.id = o.channel_id
       where o.org_id = ${orgId}
         and (o.ordered_at at time zone 'UTC')::date between ${scope.startsOn}::date and ${scope.endsOn}::date
         and o.posting_status <> 'excluded'
         and (${subsidiaryIds.length === 0} or coalesce(c.subsidiary_id, ${fallbackSubsidiaryId}) = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
       group by o.channel_id, ((o.ordered_at at time zone 'UTC')::date), o.shop_currency`,
    "objects",
  );
}

type UnpostedRow = {
  pending_orders: string;
  pending_events: string;
};

async function unpostedCounts(
  orgId: string,
  scope: CommerceCloseScope,
  fallbackSubsidiaryId: string,
): Promise<UnpostedRow> {
  const subsidiaryIds = scope.subsidiaryIds ?? [];
  const rows = await db.execute<UnpostedRow>(
    sql`
      select
        (select count(*)::text from channel_orders o
           join sales_channels c on c.org_id = o.org_id and c.id = o.channel_id
           where o.org_id = ${orgId} and o.posting_status = 'pending'
             and (o.ordered_at at time zone 'UTC')::date between ${scope.startsOn}::date and ${scope.endsOn}::date
             and (${subsidiaryIds.length === 0} or coalesce(c.subsidiary_id, ${fallbackSubsidiaryId}) = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))) as pending_orders,
        (select count(*)::text from channel_order_events e
           join sales_channels c on c.org_id = e.org_id and c.id = e.channel_id
           where e.org_id = ${orgId} and e.posting_status = 'pending'
             and (e.occurred_at at time zone 'UTC')::date between ${scope.startsOn}::date and ${scope.endsOn}::date
             and (${subsidiaryIds.length === 0} or coalesce(c.subsidiary_id, ${fallbackSubsidiaryId}) = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))) as pending_events`,
    "objects",
  );
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
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
  const channels = await activeChannels(orgId, scope.subsidiaryIds ?? [], fallbackSubsidiaryId);
  const ingested = await ingestedDayTotals(orgId, scope, fallbackSubsidiaryId);
  const unposted = await unpostedCounts(orgId, scope, fallbackSubsidiaryId);
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
      const seen = byChannelDay.get(key) ?? {
        count: 0,
        gross: 0n,
        currency: outcome.totals.currency,
      };
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

type UnlinkedBatchRow = {
  provider: string;
  batch_ref: string;
  settlement_date: string;
  currency: string;
  unevidenced_lines: string;
  unevidenced_total: string;
};

/**
 * Every payout settled in the window must be posted and reconciled. Draft
 * batches hold money the ledger has never seen; a posted batch with
 * matchable lines (charges, refunds, disputes — the same kinds the payout
 * matcher resolves) that point at nothing, or at a document that no longer
 * posts, is money without a receipt. The gate counts unlinked BATCHES with
 * their unevidenced line totals, not lines: one operator action — a
 * document link per line or one batch-level journal recognition — clears a
 * whole batch. The link is re-verified, never trusted: a stale document id
 * counts as unmatched. A line marked as recognised by a posted journal
 * entry is evidenced by that marker — the sale was booked by journal, so
 * there is no document to link.
 */
async function payoutCheck(orgId: string, scope: CommerceCloseScope): Promise<CommerceCloseCheck> {
  const subsidiaryIds = scope.subsidiaryIds ?? [];
  const subsidiaryList = `{${subsidiaryIds.join(",")}}`;
  const rows = await db.execute<PayoutRow>(
    sql`
      select provider, external_ref, settlement_date::text, currency, net_amount::text
        from psp_settlement_batches
       where org_id = ${orgId} and status = 'draft'
         and settlement_date between ${scope.startsOn}::date and ${scope.endsOn}::date
         and (${subsidiaryIds.length === 0} or subsidiary_id = any(${subsidiaryList}::uuid[]))
       order by settlement_date, provider`,
    "objects",
  );
  // The matchable kinds stay C30's single source of truth; only the
  // literal form is inlined for the ANY() comparison.
  const matchableList = `{"${[...MATCHABLE_SETTLEMENT_LINE_KINDS].join('","')}"}`;
  const unlinked = await db.execute<UnlinkedBatchRow>(
    sql`
      select b.provider, b.external_ref as batch_ref, b.settlement_date::text,
             b.currency, count(*)::text as unevidenced_lines,
             coalesce(sum(l.amount), 0)::text as unevidenced_total
        from psp_settlement_lines l
        join psp_settlement_batches b on b.org_id = l.org_id and b.id = l.batch_id
        left join documents d on d.org_id = l.org_id and d.id = l.document_id
       where l.org_id = ${orgId} and b.status = 'posted'
         and b.settlement_date between ${scope.startsOn}::date and ${scope.endsOn}::date
         and (${subsidiaryIds.length === 0} or b.subsidiary_id = any(${subsidiaryList}::uuid[]))
         and l.kind = any(${matchableList}::text[])
         and (l.document_id is null or d.id is null or d.status <> 'posted')
         -- A line the bookkeeper marked as recognised by a posted journal
         -- entry carries its evidence in the marker, not in a document link.
         and (l.meta->>'recognizedByJournalEntry' is null)
       group by b.provider, b.external_ref, b.settlement_date, b.currency
       order by b.settlement_date, b.provider`,
    "objects",
  );
  return {
    code: "commerce-payouts-unposted",
    taskKey: "commerce-complete",
    category: "commerce",
    severity: "critical",
    title: "close.diagnostics.commerce-payouts-unposted.title",
    message: "close.diagnostics.commerce-payouts-unposted.message",
    count: rows.length + unlinked.length,
    details: {
      batches: rows.map((row) => ({
        provider: row.provider,
        externalRef: row.external_ref,
        settlementDate: row.settlement_date,
        currency: row.currency,
        netAmount: row.net_amount,
        remedyHref: "/banking/psp-settlements",
      })),
      unlinkedBatches: unlinked.map((row) => ({
        provider: row.provider,
        batchRef: row.batch_ref,
        settlementDate: row.settlement_date,
        currency: row.currency,
        unevidencedLines: Number(row.unevidenced_lines),
        unevidencedTotal: row.unevidenced_total,
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
  expected: string;
  line_count: string;
};

type OpenPayoutRow = {
  kind: "batch" | "accrual";
  ref: string;
  date: string;
  amount: string;
  currency: string;
};

/**
 * Gateway clearing (and the PSP batches' own clearing accounts, typically
 * undeposited funds) must equal the open in-transit position at period end,
 * not zero: money captured but not yet paid out — payouts settling after the
 * period, and the period-end accruals taken for them — legitimately sits in
 * clearing until it lands. The proof is per account and currency: the ledger
 * residual must match the clearing legs the system attributes to those open
 * payouts and their unreversed accruals. Anything beyond the attributed
 * position is a genuine residual, and the open items are listed beside it so
 * the operator reconciles instead of guessing. With nothing open the
 * expectation is zero, which is exactly the old rule.
 */
async function clearingCheck(
  orgId: string,
  scope: CommerceCloseScope,
): Promise<CommerceCloseCheck> {
  const subsidiaryIds = scope.subsidiaryIds ?? [];
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
  const subsidiaryFilter =
    subsidiaryIds.length === 0
      ? sql`true`
      : sql`l.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[])`;
  const scopeAny = (column: ReturnType<typeof sql>) =>
    subsidiaryIds.length === 0
      ? sql`true`
      : sql`${column} = any(${`{${subsidiaryIds.join(",")}}`}::uuid[])`;
  const openItems = await db.execute<OpenPayoutRow>(
    sql`
      select 'batch' as kind, b.external_ref as ref, b.settlement_date::text as date,
             b.net_amount::text as amount, b.currency
        from psp_settlement_batches b
       where b.org_id = ${orgId} and b.status = 'posted'
         and b.settlement_date > ${scope.endsOn}::date
         and ${scopeAny(sql`b.subsidiary_id`)}
      union all
      select 'accrual' as kind, b.external_ref as ref, a.accrual_date::text as date,
             a.amount::text as amount, a.currency
        from psp_payout_accruals a
        join psp_settlement_batches b on b.org_id = a.org_id and b.id = a.batch_id
       where a.org_id = ${orgId} and a.status = 'accrued'
         and a.accrual_date <= ${scope.endsOn}::date
         and ${scopeAny(sql`a.subsidiary_id`)}
       order by date, ref`,
    "objects",
  );
  const rows = await db.execute<ClearingRow>(
    sql`
      with clearing_accounts as (
        select distinct m.account_id
          from sales_channel_account_maps m
          join sales_channels c on c.org_id = m.org_id and c.id = m.channel_id
         where m.org_id = ${orgId} and m.role in ('gateway_clearing', 'refund_clearing')
           and m.effective_from <= ${scope.endsOn}::date
           and (m.effective_to is null or m.effective_to >= ${scope.startsOn}::date)
           and (${subsidiaryIds.length === 0} or coalesce(c.subsidiary_id, ${fallbackSubsidiaryId}) = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
        union
        select distinct b.clearing_account_id as account_id
          from psp_settlement_batches b
         where b.org_id = ${orgId} and b.clearing_account_id is not null
           and b.settlement_date between ${scope.startsOn}::date and ${scope.endsOn}::date
           and (${subsidiaryIds.length === 0} or b.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
      ),
      -- Payouts settling after period end, and the unreversed period-end
      -- accruals taken for in-transit money: their clearing legs are the
      -- open position this balance must equal.
      open_batches as (
        select b.id, b.journal_entry_id
          from psp_settlement_batches b
         where b.org_id = ${orgId} and b.status = 'posted'
           and b.settlement_date > ${scope.endsOn}::date
           and b.journal_entry_id is not null
           and (${subsidiaryIds.length === 0} or b.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
      ),
      open_accruals as (
        select a.accrual_entry_id
          from psp_payout_accruals a
         where a.org_id = ${orgId} and a.status = 'accrued'
           and a.accrual_date <= ${scope.endsOn}::date
           and (${subsidiaryIds.length === 0} or a.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
      ),
      attributed_entries as (
        select e.id
          from journal_entries e
         where e.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
           and (e.id in (select journal_entry_id from open_batches)
             or e.id in (select accrual_entry_id from open_accruals)
             or e.id in (select d.posted_entry_id
                           from psp_settlement_lines l
                           join open_batches b on b.id = l.batch_id and l.org_id = ${orgId}
                           join documents d on d.org_id = l.org_id and d.id = l.document_id
                          where d.posted_entry_id is not null))
      ),
      residual as (
        select l.account_id, l.currency, coalesce(sum(l.txn_amount), 0) as residual,
               count(*) as line_count
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
           and l.posting_date <= ${scope.endsOn}::date
           and l.account_id in (select account_id from clearing_accounts)
           and ${subsidiaryFilter}
         group by l.account_id, l.currency
      ),
      expected as (
        select l.account_id, l.currency, coalesce(sum(l.txn_amount), 0) as expected
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
           and l.posting_date <= ${scope.endsOn}::date
           and l.account_id in (select account_id from clearing_accounts)
           and ${subsidiaryFilter}
           and e.id in (select id from attributed_entries)
         group by l.account_id, l.currency
      ),
      joined as (
        select coalesce(r.account_id, x.account_id) as account_id,
               coalesce(r.currency, x.currency) as currency,
               coalesce(r.residual, 0) as residual,
               coalesce(x.expected, 0) as expected,
               coalesce(r.line_count, 0) as line_count
          from residual r
          full outer join expected x using (account_id, currency)
      )
      select j.account_id::text as account_id, a.number, a.name, j.currency as currency,
             j.residual::text as residual, j.expected::text as expected,
             j.line_count::text as line_count
        from joined j
        join accounts a on a.id = j.account_id and a.org_id = ${orgId}
       where j.residual <> j.expected
       order by a.number nulls last, a.name, j.currency`,
    "objects",
  );
  return {
    code: "commerce-clearing-residual",
    taskKey: "commerce-complete",
    category: "commerce",
    severity: "critical",
    title: "close.diagnostics.commerce-clearing-residual.title",
    message: "close.diagnostics.commerce-clearing-residual.message",
    count: rows.length,
    details: {
      accounts: rows.map((row) => ({
        accountId: row.account_id,
        number: row.number,
        name: row.name,
        currency: row.currency,
        residual: row.residual,
        expected: row.expected,
        lineCount: Number(row.line_count),
        remedyHref: "/banking/psp-settlements",
      })),
      openItems: openItems.map((item) => ({
        kind: item.kind,
        ref: item.ref,
        date: item.date,
        amount: item.amount,
        currency: item.currency,
      })),
    },
  };
}

type StoredValueTieRow = {
  account_id: string | null;
  subsidiary_id: string | null;
  subsidiary_name: string | null;
  functional_currency: string | null;
  number: string | null;
  name: string | null;
  subledger: string | null;
  ledger: string;
  gap: string | null;
};

type StoredValueBreakdownRow = {
  account_id: string | null;
  subsidiary_id: string | null;
  side: string;
  currency: string;
  amount: string | null;
};

/**
 * Stored-value liability roll-forward: the functional carrying value behind
 * each liability account ties to the functional ledger legs on that account,
 * per legal entity. Both sides are ten-thousandths of the owning
 * subsidiary's base currency — the subledger through each entry's priced
 * functional amount, the ledger through its functional line amounts (the
 * journal posts them through fromUnits) — so a foreign-currency card ties
 * at its carrying value instead of at par, and each entity's outstanding
 * debt is measured in the currency it owes. A close scoped to some
 * subsidiaries reads only those entities' cards and legs, the way the
 * payout and clearing checks do; an empty scope reads every entity. A card
 * with no resolvable liability account fails closed rather than reading
 * zero.
 */
async function storedValueCheck(
  orgId: string,
  scope: CommerceCloseScope,
): Promise<CommerceCloseCheck> {
  const subsidiaryIds = scope.subsidiaryIds ?? [];
  const rows = await db.execute<StoredValueTieRow>(
    sql`
      with subledger as (
        -- The functional carrying total: every entry priced into the owing
        -- subsidiary's base currency at its own rate sums to what the
        -- ledger must carry, whatever currencies the cards were sold in.
        select coalesce(a.liability_account_id, p.liability_account_id) as account_id,
               a.subsidiary_id as subsidiary_id,
               sum(e.functional_amount_minor / 10000::numeric)::numeric as subtotal
          from stored_value_entries e
          join stored_value_accounts a on a.org_id = e.org_id and a.id = e.account_id
          join stored_value_programs p on p.org_id = a.org_id and p.id = a.program_id
         where e.org_id = ${orgId}
           and (${subsidiaryIds.length === 0} or a.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
         group by coalesce(a.liability_account_id, p.liability_account_id), a.subsidiary_id
      ),
      ledger as (
        select l.account_id, l.subsidiary_id, coalesce(sum(l.amount), 0)::numeric as ledger_sum
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
           and l.posting_date <= ${scope.endsOn}::date
           and l.account_id in (select account_id from subledger where account_id is not null)
           and (${subsidiaryIds.length === 0} or l.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
         group by l.account_id, l.subsidiary_id
      )
      select coalesce(s.account_id, g.account_id)::text as account_id,
             coalesce(s.subsidiary_id, g.subsidiary_id)::text as subsidiary_id,
             sub.name as subsidiary_name, sub.base_currency as functional_currency,
             a.number, a.name,
             round(coalesce(s.subtotal, 0), 4)::text as subledger,
             round(coalesce(g.ledger_sum, 0), 4)::text as ledger,
             case when s.account_id is null and g.account_id is null then null
                  else round(coalesce(g.ledger_sum, 0) + coalesce(s.subtotal, 0), 4)::text end as gap
        from (select * from subledger) s
        full outer join ledger g on g.account_id = s.account_id
          and g.subsidiary_id is not distinct from s.subsidiary_id
        left join accounts a on a.org_id = ${orgId} and a.id = coalesce(s.account_id, g.account_id)
        left join subsidiaries sub on sub.org_id = ${orgId} and sub.id = coalesce(s.subsidiary_id, g.subsidiary_id)
       where coalesce(s.subtotal, 0) <> 0 or coalesce(g.ledger_sum, 0) <> 0 or s.account_id is null
       order by sub.name nulls last, a.number nulls last, a.name`,
    "objects",
  );
  // A null gap means the tie is unmeasurable (no liability account) — it
  // fails closed.
  const gaps = rows.filter((row) => row.gap === null || Number(row.gap) !== 0);
  let breakdown: StoredValueBreakdownRow[] = [];
  if (gaps.length > 0) {
    const accountIds = gaps.map((row) => row.account_id).filter((id): id is string => id !== null);
    const gapSubs = gaps.map((row) => row.subsidiary_id).filter((id): id is string => id !== null);
    breakdown = await db.execute<StoredValueBreakdownRow>(
      sql`
        (select s.account_id::text as account_id, s.subsidiary_id::text as subsidiary_id,
                'subledger' as side, s.currency as currency,
                round(sum(s.balance_minor / 10000::numeric), 4)::text as amount
           from (select coalesce(a.liability_account_id, p.liability_account_id) as account_id,
                        a.subsidiary_id as subsidiary_id,
                        a.currency as currency, a.balance_minor as balance_minor
                   from stored_value_accounts a
                   join stored_value_programs p on p.org_id = a.org_id and p.id = a.program_id
                  where a.org_id = ${orgId}
                    and (${subsidiaryIds.length === 0} or a.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))) s
          where s.account_id = any(${`{${accountIds.join(",")}}`}::uuid[])
            and (s.subsidiary_id = any(${`{${gapSubs.join(",")}}`}::uuid[]) or ${gapSubs.length === 0})
          group by s.account_id, s.subsidiary_id, s.currency)
        union all
        (select l.account_id::text as account_id, l.subsidiary_id::text as subsidiary_id,
                'ledger' as side, l.currency as currency,
                round(coalesce(sum(l.txn_amount), 0), 4)::text as amount
           from journal_lines l
           join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          where l.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
            and l.posting_date <= ${scope.endsOn}::date
            and l.account_id = any(${`{${accountIds.join(",")}}`}::uuid[])
            and (${subsidiaryIds.length === 0} or l.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
          group by l.account_id, l.subsidiary_id, l.currency)
        order by account_id, subsidiary_id, side, currency`,
      "objects",
    );
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
        subsidiaryId: row.subsidiary_id,
        subsidiaryName: row.subsidiary_name,
        functionalCurrency: row.functional_currency,
        number: row.number,
        name: row.name,
        subledger: row.subledger,
        ledger: row.ledger,
        gap: row.gap,
        breakdown: breakdown
          .filter(
            (line) =>
              line.account_id === row.account_id &&
              (line.subsidiary_id ?? null) === (row.subsidiary_id ?? null),
          )
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
async function deferredCheck(
  orgId: string,
  scope: CommerceCloseScope,
): Promise<CommerceCloseCheck> {
  const subsidiaryIds = scope.subsidiaryIds ?? [];
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
  const rows = await db.execute<DeferredTieRow>(
    sql`
      with scoped_obligations as (
        select o.id, coalesce(o.deferred_account_id, r.deferred_account_id) as account_id
          from performance_obligations o
          join recognition_rules r on r.org_id = o.org_id and r.id = o.recognition_rule_id
          left join document_lines dl on dl.org_id = o.org_id and dl.id = o.document_line_id
          left join documents doc on doc.org_id = dl.org_id and doc.id = dl.document_id
          left join revenue_contracts rc on rc.org_id = o.org_id and rc.id = o.contract_id
          left join projects prj on prj.org_id = rc.org_id and prj.id = rc.project_id
         where o.org_id = ${orgId} and o.status <> 'cancelled' and not r.is_forecast
           and o.created_at < (${scope.endsOn}::date + interval '1 day')
           and coalesce(o.deferred_account_id, r.deferred_account_id) is not null
           and (${subsidiaryIds.length === 0} or
             coalesce(dl.subsidiary_id, doc.subsidiary_id, prj.subsidiary_id, rc.subsidiary_id, ${fallbackSubsidiaryId})
               = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
      ), deferred_accounts as (
        select distinct account_id
          from scoped_obligations
      ), plan as (
        select o.account_id,
               coalesce(sum(l.planned_amount), 0)::numeric as plan,
               count(distinct o.id)::integer as obligations
          from recognition_schedule_lines l
          join recognition_schedules s on s.org_id = l.org_id and s.id = l.schedule_id
          join scoped_obligations o on o.id = s.obligation_id
          left join journal_entries recognition_entry
            on recognition_entry.org_id = l.org_id and recognition_entry.id = l.journal_entry_id
         where l.org_id = ${orgId} and s.book_id = ${scope.bookId}
           and (l.journal_entry_id is null or recognition_entry.posting_date > ${scope.endsOn}::date)
           and l.planned_amount <> 0 and s.status <> 'cancelled'
         group by o.account_id
      ),
      ledger as (
        select l.account_id, coalesce(sum(l.amount), 0)::numeric as ledger_sum
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
           and l.posting_date <= ${scope.endsOn}::date
           and l.account_id in (select account_id from deferred_accounts)
           and (${subsidiaryIds.length === 0} or l.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
         group by l.account_id
      )
      select coalesce(p.account_id, g.account_id)::text as account_id, a.number, a.name,
             coalesce(p.plan, 0)::text as plan,
             coalesce(g.ledger_sum, 0)::text as ledger,
             (coalesce(g.ledger_sum, 0) + coalesce(p.plan, 0))::text as gap,
             coalesce(p.obligations, 0)::text as obligations
        from plan p
        full outer join ledger g on g.account_id = p.account_id
        join accounts a on a.org_id = ${orgId} and a.id = coalesce(p.account_id, g.account_id)
       where (coalesce(g.ledger_sum, 0) + coalesce(p.plan, 0)) <> 0
       order by a.number nulls last, a.name`,
    "objects",
  );
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
async function contractCostCheck(
  orgId: string,
  scope: CommerceCloseScope,
): Promise<CommerceCloseCheck> {
  const subsidiaryIds = scope.subsidiaryIds ?? [];
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
  const rows = await db.execute<ContractCostTieRow>(
    sql`
      with scoped_assets as (
        select c.*
          from contract_cost_assets c
          left join revenue_contracts rc on rc.org_id = c.org_id and rc.id = c.revenue_contract_id
          left join projects prj on prj.org_id = rc.org_id and prj.id = rc.project_id
         where c.org_id = ${orgId} and c.capitalized_on <= ${scope.endsOn}::date
           and c.status in ('active', 'fully_amortized', 'impaired')
           and (${subsidiaryIds.length === 0} or
             coalesce(rc.subsidiary_id, prj.subsidiary_id, ${fallbackSubsidiaryId})
               = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
      ), amortized as (
        select m.asset_id, coalesce(sum(m.amount_minor), 0)::numeric as amort_minor
          from contract_cost_amortization m
          join accounting_periods p on p.org_id = m.org_id and p.id = m.period_id
          join scoped_assets c on c.org_id = m.org_id and c.id = m.asset_id
         where m.org_id = ${orgId} and p.ends_on <= ${scope.endsOn}::date
         group by m.asset_id
      ),
      ledger as (
        select l.contributor_ref as asset_id, l.currency as currency,
               coalesce(sum(l.txn_amount), 0)::numeric as ledger_sum
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          join scoped_assets c on c.org_id = l.org_id and c.id = l.contributor_ref
         where l.org_id = ${orgId} and e.book_id = ${scope.bookId} and e.status in ('posted', 'reversed')
           and l.posting_date <= ${scope.endsOn}::date
           and l.contributor_kind = 'contract_cost_asset'
           and (${subsidiaryIds.length === 0} or l.subsidiary_id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))
         group by l.contributor_ref, l.currency
      )
      select c.id::text as asset_id, c.currency as currency, c.status as status,
             round(c.amount_minor / power(10::numeric, cur.minor_units), 4)::text as capitalized,
             round(coalesce(a.amort_minor, 0) / power(10::numeric, cur.minor_units), 4)::text as amortized,
             round(coalesce(g.ledger_sum, 0), 4)::text as ledger,
             round(coalesce(g.ledger_sum, 0)
                - (c.amount_minor - coalesce(a.amort_minor, 0)) / power(10::numeric, cur.minor_units), 4)::text as gap
        from scoped_assets c
        left join amortized a on a.asset_id = c.id
        left join ledger g on g.asset_id = c.id and g.currency = c.currency
        left join currencies cur on cur.code = c.currency
       order by c.currency, c.capitalized_on`,
    "objects",
  );
  const gaps = rows.filter((row) => {
    if (row.status === "impaired") return Number(row.gap) > 0;
    return Number(row.gap) !== 0;
  });
  const expensed = (
    await db.execute<{ count: string }>(
      sql`
      select count(*)::text as count from contract_cost_assets c
        left join revenue_contracts rc on rc.org_id = c.org_id and rc.id = c.revenue_contract_id
        left join projects prj on prj.org_id = rc.org_id and prj.id = rc.project_id
       where c.org_id = ${orgId} and c.status = 'expensed'
         and c.capitalized_on <= ${scope.endsOn}::date
         and (${subsidiaryIds.length === 0} or
           coalesce(rc.subsidiary_id, prj.subsidiary_id, ${fallbackSubsidiaryId})
             = any(${`{${subsidiaryIds.join(",")}}`}::uuid[]))`,
      "objects",
    )
  )[0];
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
async function exceptionCheck(
  orgId: string,
  scope: CommerceCloseScope,
): Promise<CommerceCloseCheck> {
  const subsidiaryIds = scope.subsidiaryIds ?? [];
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
  const rows = await db.execute<ExceptionQueueRow>(
    sql`
      (select 'order' as kind, o.channel_id, c.name as channel_name,
              o.external_number as reference, o.exception_code as code,
              o.exception_reason as reason,
              (o.ordered_at at time zone 'UTC')::date::text as occurred_on
         from channel_orders o
         join sales_channels c on c.org_id = o.org_id and c.id = o.channel_id
        where o.org_id = ${orgId} and o.posting_status = 'exception'
          and (o.ordered_at at time zone 'UTC')::date between ${scope.startsOn}::date and ${scope.endsOn}::date
          and (${subsidiaryIds.length === 0} or coalesce(c.subsidiary_id, ${fallbackSubsidiaryId}) = any(${`{${subsidiaryIds.join(",")}}`}::uuid[])))
      union all
      (select e.kind as kind, e.channel_id, c.name as channel_name,
              o.external_number as reference, e.exception_code as code,
              e.exception_reason as reason,
              (e.occurred_at at time zone 'UTC')::date::text as occurred_on
         from channel_order_events e
         join channel_orders o on o.org_id = e.org_id and o.id = e.order_id
         join sales_channels c on c.org_id = e.org_id and c.id = e.channel_id
        where e.org_id = ${orgId} and e.posting_status = 'exception'
          and (e.occurred_at at time zone 'UTC')::date between ${scope.startsOn}::date and ${scope.endsOn}::date
          and (${subsidiaryIds.length === 0} or coalesce(c.subsidiary_id, ${fallbackSubsidiaryId}) = any(${`{${subsidiaryIds.join(",")}}`}::uuid[])))
      order by occurred_on, reference`,
    "objects",
  );
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
    }>(
      sql`
      select r.period_id, r.book_id, r.data_fingerprint, r.scope,
             p.starts_on::text, p.ends_on::text,
             t.id as task_id, t.status as task_status
        from close_runs r
        join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
        left join close_run_tasks t on t.run_id = r.id and t.org_id = r.org_id and t.key = 'commerce-complete'
       where r.id = ${runId} and r.org_id = ${orgId}`,
      "objects",
    )
  )[0];
  // Evidence is signed work: a refresh with no actor cannot sign it.
  if (!run?.task_id || run.task_status !== "complete" || !run.data_fingerprint || !actorId)
    return null;
  const existing = (
    await db.execute<{ id: string }>(
      sql`
      select id from close_task_evidence
       where org_id = ${orgId} and run_id = ${runId} and task_id = ${run.task_id}
         and evidence_type = 'report' and snapshot->>'fingerprint' = ${run.data_fingerprint}
       limit 1`,
      "objects",
    )
  )[0];
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
