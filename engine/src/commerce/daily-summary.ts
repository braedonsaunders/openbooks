import { sql } from "drizzle-orm";
import {
  formatLedgerMinor,
  OrderPostException,
  postCashSaleDraft,
  postChannelOrder,
  resolveOrderForPosting,
  type CashSaleDraft,
  type ResolvedOrder,
} from "./order-posting.ts";
import { loadChannelOrder, markOrderException, markOrderSummarized } from "./orders.ts";
import { getPostingPolicy } from "./posting-policies.ts";
import { CommerceError } from "./errors.ts";
import { db, withBypassContext, withOrg, withOrgTransaction } from "../platform/db.ts";
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { runPostDocumentEffects } from "../ledger/posting-dispatch.ts";

interface SummaryGroup {
  channelId: string;
  provider: string;
  day: string;
  stockLocationId: string;
  currency: string;
  subsidiaryId: string | null;
  cutoffTz: string;
}

/** Exact decimal quantity addition (up to 8 places) for aggregated summary lines. */
function addQuantities(first: string, second: string): string {
  const scale = (value: string): bigint => {
    const [whole, frac = ""] = value.trim().split(".");
    return BigInt(`${whole}${(frac + "00000000").slice(0, 8)}`);
  };
  const total = scale(first) + scale(second);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(9, "0");
  const head = digits.slice(0, -8).replaceAll(/^0+(?=\d)/g, "");
  const tail = digits.slice(-8).replaceAll(/0+$/g, "");
  return `${negative ? "-" : ""}${head}${tail === "" ? "" : `.${tail}`}`;
}

type SummaryDbRow = Record<string, unknown> & {
  id: string;
  status: string;
  posting_document_id: string | null;
};

/**
 * Aggregate resolved orders into one cash-sale draft per (channel, day,
 * location, currency): product lines by item, price, promotion and tax
 * fingerprint; shipping by account and tax; discounts by account and title;
 * tenders by gateway and card. Stored-value moves stay per order (each
 * buyer redeems their own card and receives their own code) while the
 * money aggregates.
 */
export function aggregateSummaryDraft(
  group: SummaryGroup,
  resolved: ResolvedOrder[],
): { draft: CashSaleDraft; scope: string } {
  const lines: CashSaleDraft["lines"] = [];
  const lineIndex = new Map<string, number>();
  const tenders: CashSaleDraft["tenders"] = [];
  const tenderIndex = new Map<string, number>();
  const giftIssues: CashSaleDraft["giftIssues"] = [];
  let merchantTaxMinor = 0n;
  let merchantTotalMinor = 0n;
  if (resolved.length === 0) throw new Error("Summary aggregation needs at least one resolved order");
  for (const order of resolved) {
    merchantTaxMinor += order.merchantTaxMinor;
    merchantTotalMinor += order.merchantTotalMinor;
    for (const issue of order.giftIssues) giftIssues.push(issue);
    for (const line of order.lines) {
      const taxKey = line.taxes
        .map((tax) => `${tax.taxCodeId}:${tax.ratePercent}:${tax.collectedBy}:${tax.facilitatorName ?? ""}`)
        .sort()
        .join("|");
      const key = `${line.kind}:${line.itemId ?? ""}:${line.accountId}:${line.unitPrice}:${line.promotionId ?? ""}:${taxKey}:${line.title}`;
      const existing = lineIndex.get(key);
      if (existing === undefined) {
        lineIndex.set(key, lines.length);
        lines.push({ ...line, taxes: line.taxes.map((tax) => ({ ...tax })) });
      } else {
        const target = lines[existing]!;
        target.amountMinor += line.amountMinor;
        target.amount = formatLedgerMinor(target.amountMinor, group.currency);
        target.quantity = addQuantities(target.quantity, line.quantity);
        for (const tax of line.taxes) {
          const match = target.taxes.find(
            (candidate) =>
              candidate.taxCodeId === tax.taxCodeId &&
              candidate.ratePercent === tax.ratePercent &&
              candidate.collectedBy === tax.collectedBy &&
              (candidate.facilitatorName ?? "") === (tax.facilitatorName ?? ""),
          );
          if (match) match.amountMinor += tax.amountMinor;
          else target.taxes.push({ ...tax });
        }
      }
    }
    for (const tender of order.tenders) {
      if (tender.amountMinor <= 0n) continue;
      const key = `${tender.accountId}:${tender.gateway}:${tender.giftCardAccountId ?? ""}`;
      const existing = tenderIndex.get(key);
      if (existing === undefined) {
        tenderIndex.set(key, tenders.length);
        tenders.push({ ...tender });
      } else {
        const target = tenders[existing]!;
        target.amountMinor += tender.amountMinor;
        target.amount = formatLedgerMinor(target.amountMinor, group.currency);
      }
    }
  }
  return {
    draft: {
      kind: "cash_sale",
      provider: group.provider,
      externalRef: "",
      channelId: group.channelId,
      documentDate: group.day,
      currency: group.currency,
      subsidiaryId: group.subsidiaryId,
      partyId: null,
      stockLocationId: group.stockLocationId,
      lines,
      tenders,
      merchantTaxMinor,
      merchantTotalMinor,
      giftIssues,
    },
    scope: `channel-summary:${group.channelId}:${group.day}:${group.stockLocationId}:${group.currency}`,
  };
}

/**
 * Post one due summary batch: resolve every pending order for the batch
 * (parking the unpostable, leaving the unpaid), aggregate the paid into one
 * cash sale, post it, and link the orders. Late orders for an already-posted
 * batch post per order instead, so revenue keeps its day. One unit: a crash
 * replays the whole batch, and the cash-sale draft idempotency plus the
 * batch unique key keep the replay to a single document.
 */
export async function postSummaryBatch(
  orgId: string,
  actor: string | null,
  group: SummaryGroup,
  orderIds: string[],
): Promise<{ status: string; documentId: string | null; summarized: number; parked: number }> {
  return withOrg(orgId, async () => {
    const outcome = await withOrgTransaction(orgId, async () => {
      await acquireOrgFeatureGateLock(db, orgId);
      if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
        throw new CommerceError("feature_off", "Sales Channels is turned off for this organization.", "Enable Sales Channels in Company Settings → Features.");
      }
      const resolved: ResolvedOrder[] = [];
      const resolvedIds: string[] = [];
      let parked = 0;
      for (const orderId of orderIds) {
        const live = await loadChannelOrder(orgId, orderId);
        if (!live || live.postingStatus !== "pending") continue;
        try {
          const one = await resolveOrderForPosting(orgId, actor, db, live);
          if (!one.paid) continue;
          if (one.policy.mode !== "daily_summary") continue;
          resolved.push(one);
          resolvedIds.push(orderId);
        } catch (error) {
          if (error instanceof OrderPostException) {
            await markOrderException(orgId, orderId, actor, { code: error.code, reason: error.message, remedy: error.remedy });
            parked += 1;
            continue;
          }
          throw error;
        }
      }
      if (resolved.length === 0) return { status: "empty", documentId: null as string | null, summarized: 0, parked, effectsDocumentId: null as string | null };
      // The batch row is the idempotency key: a replayed cut-off observes
      // the open row instead of double-counting its orders. The conflict is
      // expected on replay, so re-read the winner.
      const inserted = await db.execute<{ id: string; status: string; posting_document_id: string | null }>(sql`
        insert into channel_daily_summaries
          (org_id, channel_id, summary_date, stock_location_id, currency, created_by, updated_by)
        values (${orgId}, ${group.channelId}, ${group.day}, ${group.stockLocationId}, ${group.currency}, ${actor}, ${actor})
        on conflict (org_id, channel_id, summary_date, stock_location_id, currency) do nothing
        returning id, status, posting_document_id`);
      const batch = inserted.rows[0] ?? (await db.execute<SummaryDbRow>(sql`
        select id, status, posting_document_id from channel_daily_summaries
         where org_id = ${orgId} and channel_id = ${group.channelId} and summary_date = ${group.day}
           and stock_location_id = ${group.stockLocationId} and currency = ${group.currency}`)).rows[0];
      if (!batch) throw new Error("Summary batch store returned no row; the batch was lost");
      if (batch.status === "posted" && batch.posting_document_id) {
        return { status: "posted", documentId: batch.posting_document_id, summarized: 0, parked, effectsDocumentId: null as string | null };
      }
      const { draft, scope } = aggregateSummaryDraft(group, resolved);
      draft.externalRef = `channel-summary:${batch.id}`;
      const built = await postCashSaleDraft(orgId, actor, draft, scope);
      if (!built.journalEntryId) {
        return { status: "pending", documentId: built.documentId, summarized: 0, parked, effectsDocumentId: null as string | null };
      }
      let subtotalMinor = 0n;
      let taxMinor = 0n;
      let shippingMinor = 0n;
      let discountMinor = 0n;
      let totalMinor = 0n;
      for (const order of resolved) {
        subtotalMinor += order.order.subtotalMinor;
        taxMinor += order.order.taxMinor;
        shippingMinor += order.order.shippingMinor;
        discountMinor += order.order.discountMinor;
        totalMinor += order.order.totalMinor;
      }
      const closed = await db.execute(sql`
        update channel_daily_summaries
           set status = 'posted', order_count = ${resolved.length},
               subtotal_minor = ${subtotalMinor.toString()}, tax_minor = ${taxMinor.toString()},
               shipping_minor = ${shippingMinor.toString()}, discount_minor = ${discountMinor.toString()},
               total_minor = ${totalMinor.toString()},
               posting_document_id = ${built.documentId},
               updated_by = ${actor}, updated_at = now()
         where org_id = ${orgId} and id = ${batch.id} and status = 'open'`);
      if (closed.rowCount !== 1) {
        throw new Error("Summary batch close matched no row; the batch posted while it closed");
      }
      for (const orderId of resolvedIds) {
        await markOrderSummarized(orgId, orderId, actor, batch.id);
      }
      return { status: "posted", documentId: built.documentId, summarized: resolved.length, parked, effectsDocumentId: built.documentId };
    });
    if (outcome.effectsDocumentId) {
      await runPostDocumentEffects(outcome.effectsDocumentId, "draft", { actorId: actor });
    }
    return { status: outcome.status, documentId: outcome.documentId, summarized: outcome.summarized, parked: outcome.parked };
  });
}

interface DueChannel {
  channelId: string;
  provider: string;
  subsidiaryId: string | null;
  cutoffTz: string;
}

/**
 * Post every due daily summary: for each channel in daily-summary mode,
 * every shop day strictly before today (in the channel's cut-off zone)
 * with pending orders posts one cash sale. Orders for an already-posted
 * day post per order instead, so late arrivals keep their day. Unpaid
 * orders stay pending for payment (or become sales orders through the
 * per-order path when the policy says so).
 */
export async function postDueDailySummaries(): Promise<{ posted: number; parked: number }> {
  // bypass: scheduler-tick — the summary cut-off scans pending orders
  // across organizations before each row's organization is known.
  const orgs = await withBypassContext(() => db.execute<{ org_id: string }>(sql`
    select distinct org_id from channel_orders where posting_status = 'pending' limit 50`))
    .then((result) => result.rows);
  let posted = 0;
  let parked = 0;
  for (const org of orgs) {
    try {
      const outcome = await withOrg(org.org_id, () => postDueDailySummariesForOrg(org.org_id, null));
      posted += outcome.posted;
      parked += outcome.parked;
    } catch {
      continue;
    }
  }
  return { posted, parked };
}

export async function postDueDailySummariesForOrg(
  orgId: string,
  actor: string | null,
): Promise<{ posted: number; parked: number }> {
  let posted = 0;
  let parked = 0;
  const channels = (await db.execute<{ channel_id: string }>(sql`
    select distinct channel_id from channel_orders
     where org_id = ${orgId} and posting_status = 'pending'`)).rows;
  for (const channel of channels) {
    const meta = (await db.execute<{ kind: string; subsidiary_id: string | null }>(sql`
      select kind, subsidiary_id from sales_channels where org_id = ${orgId} and id = ${channel.channel_id}`)).rows[0];
    if (!meta) continue;
    let policy: { mode: string; cutoffTz: string };
    try {
      const today = (await db.execute<{ today: string }>(sql`select current_date::text as today`)).rows[0]!.today;
      policy = await getPostingPolicy(orgId, channel.channel_id, today);
    } catch {
      continue;
    }
    if (policy.mode !== "daily_summary") continue;
    let shopToday: string;
    try {
      shopToday = (await db.execute<{ day: string }>(sql`
        select ((now() at time zone ${policy.cutoffTz})::date)::text as day`)).rows[0]!.day;
    } catch {
      continue;
    }
    const due: DueChannel = { channelId: channel.channel_id, provider: meta.kind, subsidiaryId: meta.subsidiary_id, cutoffTz: policy.cutoffTz };
    const groups = (await db.execute<{ day: string; stock_location_id: string; currency: string; order_ids: string[] }>(sql`
      select ((ordered_at at time zone ${policy.cutoffTz})::date)::text as day,
             coalesce(
               (select stock_location_id from sales_channel_locations
                 where org_id = ${orgId} and channel_id = ${channel.channel_id} and fulfils_orders
                   and stock_location_id is not null
                 limit 1),
               '00000000-0000-0000-0000-000000000000') as stock_location_id,
             shop_currency as currency,
             array_agg(id order by ordered_at) as order_ids
        from channel_orders
       where org_id = ${orgId} and channel_id = ${channel.channel_id} and posting_status = 'pending'
       group by 1, 2, 3`)).rows;
    for (const group of groups) {
      if (group.day >= shopToday) continue;
      const postedSummary = (await db.execute<{ id: string }>(sql`
        select id from channel_daily_summaries
         where org_id = ${orgId} and channel_id = ${due.channelId}
           and summary_date = ${group.day} and currency = ${group.currency} and status = 'posted'
         limit 1`)).rows[0];
      if (postedSummary) {
        for (const orderId of group.order_ids) {
          const outcome = await postChannelOrder(orgId, actor, orderId, { forcePerOrder: true }).catch(() => ({ status: "pending" as string }));
          if (outcome.status === "posted") posted += 1;
          else if (outcome.status === "exception") parked += 1;
        }
        continue;
      }
      if (group.stock_location_id === "00000000-0000-0000-0000-000000000000") {
        for (const orderId of group.order_ids) {
          const outcome = await postChannelOrder(orgId, actor, orderId, { forcePerOrder: true }).catch(() => ({ status: "pending" as string }));
          if (outcome.status === "exception") parked += 1;
        }
        continue;
      }
      const outcome = await postSummaryBatch(orgId, actor, {
        channelId: due.channelId,
        provider: due.provider,
        day: group.day,
        stockLocationId: group.stock_location_id,
        currency: group.currency,
        subsidiaryId: due.subsidiaryId,
        cutoffTz: due.cutoffTz,
      }, group.order_ids);
      if (outcome.status === "posted") posted += outcome.summarized;
      parked += outcome.parked;
    }
  }
  return { posted, parked };
}
