import { sql } from "drizzle-orm";
import {
  buildSalesOrderDraft,
  formatLedgerMinor,
  OrderPostException,
  postCashSaleDraft,
  postChannelOrder,
  resolveOrderForPosting,
  type CashSaleDraft,
  type ResolvedOrder,
} from "./order-posting.ts";
import { claimPendingRefundEvents, postDueRefundBatchesForOrg, postRefundBatchDocument } from "./refunds.ts";
import { governedSalesOrderRef, loadChannelOrder, markOrderException, markOrderSummarized, maybeCloseGoverningOrder } from "./orders.ts";
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
  /** Who fulfils from the group shelf: OpenBooks (sale issues at posting) or the storefront (governed batch, fulfilments issue later). */
  fulfilledBy: "openbooks" | "storefront";
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
      if (!(await lockAndCheckOrgFeature(db, orgId, "cashSales"))) {
        throw new CommerceError("feature_off", "Cash sales is turned off for this organization.", "Enable Cash sales in Company Settings → Features.");
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
      // A day with no sales still owes its refunds: they post as the day's
      // refund document without a sales batch. The claim skips rows another
      // worker holds, and each event stays individually idempotent.
      if (resolved.length === 0) {
        const refundIds = await claimPendingRefundEvents(orgId, group.channelId, group.day, group.currency, group.cutoffTz);
        if (refundIds.length === 0) {
          return { status: "empty", documentId: null as string | null, summarized: 0, parked, effectsDocumentId: null as string | null };
        }
        const refunds = await postRefundBatchDocument(orgId, actor, {
          channelId: group.channelId,
          provider: group.provider,
          day: group.day,
          currency: group.currency,
          subsidiaryId: group.subsidiaryId,
        }, refundIds);
        return {
          status: refunds.status,
          documentId: refunds.documentId,
          summarized: 0,
          parked: parked + refunds.parked,
          effectsDocumentId: null as string | null,
        };
      }
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
      // A storefront-fulfilled day posts as one governed batch: every
      // order brings its own draft sales order, and the 'bills' edges mark
      // the batch fulfilment-governed so the kernel skips sale-time issue
      // effects. The batch stays homogeneous by shelf (the sweep groups one
      // shelf per batch), so one flag governs every line.
      const governIds: string[] = [];
      if (group.fulfilledBy === "storefront") {
        for (const one of resolved) {
          governIds.push(
            (await buildSalesOrderDraft(orgId, actor, one, governedSalesOrderRef(one.order.externalId))).documentId,
          );
        }
      }
      const built = await postCashSaleDraft(orgId, actor, draft, scope,
        governIds.length > 0 ? { governFromSalesOrderIds: governIds } : undefined);
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
      for (const orderId of resolvedIds) {
        await maybeCloseGoverningOrder(orgId, actor, orderId);
      }
      // The batch's issues belong to the summary cash sale: every summarized
      // order restates its margin share from the posted batch, on the scan's
      // restatement queue rather than inside this posting. A retried mark
      // collides on (org, order) and the first mark wins.
      await db.execute(sql`
        insert into channel_order_economics_pending (org_id, order_id, reason)
        select ${orgId}, o.id, 'daily summary posted'
          from channel_orders o
         where o.org_id = ${orgId}
           and o.id in (${sql.join(resolvedIds.map((orderId) => sql`${orderId}::uuid`), sql`, `)})
        on conflict (org_id, order_id) do nothing`);
      // Tonight's refunds join the batch they belong to: one refund document
      // beside the sales document, each event on its own lines. The batch
      // unit is still open, so the refund effects run inside it — a rollback
      // retracts the documents with their effects, and the sweep replays.
      const refundIds = await claimPendingRefundEvents(orgId, group.channelId, group.day, group.currency, group.cutoffTz);
      if (refundIds.length > 0) {
        const refunds = await postRefundBatchDocument(orgId, actor, {
          channelId: group.channelId,
          provider: group.provider,
          day: group.day,
          currency: group.currency,
          subsidiaryId: group.subsidiaryId,
        }, refundIds);
        parked += refunds.parked;
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
    // The batch shelf mirrors sale resolution: the fulfilment shelf when
    // OpenBooks fulfils, else the single mapped 3PL shelf. Anything else
    // (no shelf, or several) posts per order and parks with the Locations
    // remedy at resolution.
    const locationLinks = (await db.execute<{ stock_location_id: string | null; fulfils_orders: boolean }>(sql`
      select stock_location_id, fulfils_orders from sales_channel_locations
       where org_id = ${orgId} and channel_id = ${channel.channel_id} and stock_location_id is not null`)).rows;
    const fulfilShelves = locationLinks
      .filter((link) => link.fulfils_orders && link.stock_location_id)
      .map((link) => link.stock_location_id!);
    const mappedShelves = locationLinks
      .map((link) => link.stock_location_id)
      .filter((id): id is string => !!id);
    const groupShelf = fulfilShelves.length === 1
      ? { stockLocationId: fulfilShelves[0]!, fulfilledBy: "openbooks" as const }
      : fulfilShelves.length === 0 && mappedShelves.length === 1
        ? { stockLocationId: mappedShelves[0]!, fulfilledBy: "storefront" as const }
        : null;
    const groups = (await db.execute<{ day: string; currency: string; order_ids: string[] }>(sql`
      select ((ordered_at at time zone ${policy.cutoffTz})::date)::text as day,
             shop_currency as currency,
             array_agg(id order by ordered_at) as order_ids
        from channel_orders
       where org_id = ${orgId} and channel_id = ${channel.channel_id} and posting_status = 'pending'
       group by 1, 2`)).rows;
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
      if (!groupShelf) {
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
        stockLocationId: groupShelf.stockLocationId,
        fulfilledBy: groupShelf.fulfilledBy,
        currency: group.currency,
        subsidiaryId: due.subsidiaryId,
        cutoffTz: due.cutoffTz,
      }, group.order_ids);
      if (outcome.status === "posted") posted += outcome.summarized;
      parked += outcome.parked;
    }
  }
  // Refunds behind already-posted sales (a refund-only day, or a refund that
  // arrived after its sales batch closed) post as their own day documents.
  // Refunds behind still-pending orders joined the sales batch above.
  const refunds = await postDueRefundBatchesForOrg(orgId, actor).catch(() => ({ posted: 0, parked: 0 }));
  posted += refunds.posted;
  parked += refunds.parked;
  return { posted, parked };
}
