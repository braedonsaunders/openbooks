import { sql } from "drizzle-orm";
import { postChannelOrder } from "./order-posting.ts";
import { loadChannelOrder } from "./orders.ts";
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
