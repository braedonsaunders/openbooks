import { sql } from "drizzle-orm";
import { postChannelOrder } from "./order-posting.ts";
import { postChannelRefund } from "./refunds.ts";
import { postChannelCancellation } from "./cancellations.ts";
import { postChannelFulfilment } from "./fulfilments.ts";
import { loadChannelEvent, loadChannelOrder } from "./orders.ts";
import { db, withOrg, withOrgContext } from "../platform/db.ts";

export interface ChannelExceptionRow {
  orderId: string;
  channelId: string;
  channelName: string;
  externalNumber: string;
  shopCurrency: string;
  totalMinor: bigint;
  orderedAt: string;
  code: string;
  reason: string;
  remedy: string;
}

type ExceptionDbRow = Record<string, unknown> & {
  order_id: string;
  channel_id: string;
  channel_name: string;
  external_number: string;
  shop_currency: string;
  total_minor: bigint;
  ordered_at: string;
  code: string;
  reason: string;
  remedy: string;
};

/**
 * The Needs-attention queue: every parked order with the code, the reason
 * and the one-click remedy. Ordered oldest first, so the queue drains in
 * the sequence the storefront sent.
 */
export async function listChannelExceptions(
  orgId: string,
  channelId: string | null = null,
  code: string | null = null,
): Promise<ChannelExceptionRow[]> {
  const rows = (await withOrgContext(orgId, () => db.execute<ExceptionDbRow>(sql`
    select o.id as order_id, o.channel_id, c.name as channel_name, o.external_number,
           o.shop_currency, o.total_minor, o.ordered_at,
           o.exception_code as code, o.exception_reason as reason, o.exception_remedy as remedy
      from channel_orders o
      join sales_channels c on c.org_id = o.org_id and c.id = o.channel_id
     where o.org_id = ${orgId} and o.posting_status = 'exception'
       and (${channelId}::uuid is null or o.channel_id = ${channelId})
       and (${code}::text is null or o.exception_code = ${code})
     order by o.ordered_at`))).rows;
  return rows.map((row) => ({
    orderId: row.order_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    externalNumber: row.external_number,
    shopCurrency: row.shop_currency,
    totalMinor: typeof row.total_minor === "bigint" ? row.total_minor : BigInt(row.total_minor as unknown as string),
    orderedAt: row.ordered_at,
    code: row.code,
    reason: row.reason,
    remedy: row.remedy,
  }));
}

/**
 * Replay parked orders after the operator fixed the cause: reset each to
 * pending, then post it through the normal path (per-order posts now,
 * summary mode rejoins its batch at cut-off). Fix-all-similar is a
 * code-scoped replay: every order parked under the same code goes again.
 * Counts posted, parked (still blocked) and waiting (deferred to cut-off
 * or payment); anything else propagates.
 */
export async function replayChannelExceptions(
  orgId: string,
  actor: string | null,
  channelId: string | null = null,
  code: string | null = null,
): Promise<{ replayed: number; posted: number; parked: number; waiting: number }> {
  return withOrg(orgId, async () => {
    const queued = await listChannelExceptions(orgId, channelId, code);
    let replayed = 0;
    let posted = 0;
    let parked = 0;
    let waiting = 0;
    for (const row of queued) {
      const live = await loadChannelOrder(orgId, row.orderId);
      if (!live || live.postingStatus !== "exception") continue;
      const reset = await db.execute(sql`
        update channel_orders
           set posting_status = 'pending',
               posting_document_id = null, summary_id = null,
               exception_code = null, exception_reason = null, exception_remedy = null,
               updated_by = ${actor}, updated_at = now()
         where org_id = ${orgId} and id = ${row.orderId} and posting_status = 'exception'`);
      if (reset.rowCount !== 1) continue;
      replayed += 1;
      const outcome = await postChannelOrder(orgId, actor, row.orderId);
      if (outcome.status === "posted") posted += 1;
      else if (outcome.status === "exception") parked += 1;
      else waiting += 1;
    }
    return { replayed, posted, parked, waiting };
  });
}

export interface ChannelEventExceptionRow {
  eventId: string;
  orderId: string;
  channelId: string;
  channelName: string;
  externalNumber: string;
  kind: string;
  externalId: string;
  occurredAt: string;
  code: string;
  reason: string;
  remedy: string;
}

type EventExceptionDbRow = Record<string, unknown> & {
  event_id: string;
  order_id: string;
  channel_id: string;
  channel_name: string;
  external_number: string;
  kind: string;
  external_id: string;
  occurred_at: string;
  code: string;
  reason: string;
  remedy: string;
};

/**
 * The event side of the Needs-attention queue: every parked refund,
 * cancellation and fulfilment with the code, the reason and the one-click
 * remedy. Ordered oldest first, beside the order queue.
 */
export async function listChannelEventExceptions(
  orgId: string,
  channelId: string | null = null,
  code: string | null = null,
  kind: string | null = null,
): Promise<ChannelEventExceptionRow[]> {
  const rows = (await withOrgContext(orgId, () => db.execute<EventExceptionDbRow>(sql`
    select e.id as event_id, e.order_id, e.channel_id, c.name as channel_name, o.external_number,
           e.kind, e.external_id, e.occurred_at,
           e.exception_code as code, e.exception_reason as reason, e.exception_remedy as remedy
      from channel_order_events e
      join sales_channels c on c.org_id = e.org_id and c.id = e.channel_id
      join channel_orders o on o.org_id = e.org_id and o.id = e.order_id
     where e.org_id = ${orgId} and e.posting_status = 'exception'
       and (${channelId}::uuid is null or e.channel_id = ${channelId})
       and (${code}::text is null or e.exception_code = ${code})
       and (${kind}::text is null or e.kind = ${kind})
     order by e.occurred_at`))).rows;
  return rows.map((row) => ({
    eventId: row.event_id,
    orderId: row.order_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    externalNumber: row.external_number,
    kind: row.kind,
    externalId: row.external_id,
    occurredAt: row.occurred_at,
    code: row.code,
    reason: row.reason,
    remedy: row.remedy,
  }));
}

/**
 * Replay parked events after the operator fixed the cause: reset each to
 * pending, then post it through its own path. Fix-all-similar is a
 * code-scoped replay: every event parked under the same code goes again.
 * Counts posted, parked (still blocked) and waiting (deferred to cut-off,
 * payment or attribution); anything else propagates.
 */
export async function replayChannelEventExceptions(
  orgId: string,
  actor: string | null,
  channelId: string | null = null,
  code: string | null = null,
): Promise<{ replayed: number; posted: number; parked: number; waiting: number }> {
  return withOrg(orgId, async () => {
    const queued = await listChannelEventExceptions(orgId, channelId, code);
    let replayed = 0;
    let posted = 0;
    let parked = 0;
    let waiting = 0;
    for (const row of queued) {
      const live = await loadChannelEvent(orgId, row.eventId);
      if (!live || live.postingStatus !== "exception") continue;
      const reset = await db.execute(sql`
        update channel_order_events
           set posting_status = 'pending',
               posting_document_id = null,
               exception_code = null, exception_reason = null, exception_remedy = null,
               updated_by = ${actor}, updated_at = now()
         where org_id = ${orgId} and id = ${row.eventId} and posting_status = 'exception'`);
      if (reset.rowCount !== 1) continue;
      replayed += 1;
      const outcome = live.kind === "refund"
        ? await postChannelRefund(orgId, actor, row.eventId)
        : live.kind === "cancellation"
          ? await postChannelCancellation(orgId, actor, row.eventId)
          : await postChannelFulfilment(orgId, actor, row.eventId);
      if (outcome.status === "posted") posted += 1;
      else if (outcome.status === "exception") parked += 1;
      else waiting += 1;
    }
    return { replayed, posted, parked, waiting };
  });
}
