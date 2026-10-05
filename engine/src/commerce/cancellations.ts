import { sql } from "drizzle-orm";
import { CommerceError } from "./errors.ts";
import {
  loadChannelEvent,
  loadChannelOrder,
  markChannelEventException,
  markChannelEventIgnored,
  markChannelEventPosted,
  maybeCloseGoverningOrder,
} from "./orders.ts";
import { CHANNEL_REFUND_EXCEPTION_CODES, RefundPostException } from "./refunds.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { db, withOrg, withOrgTransaction } from "../platform/db.ts";
import { requestDocumentVoid, DocumentVoidError } from "../ledger/document-void.ts";

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

/** Cancellation refusals reuse the refund event vocabulary. */
export const CHANNEL_CANCELLATION_EXCEPTION_CODES = [...CHANNEL_REFUND_EXCEPTION_CODES] as const;

function park(
  code: (typeof CHANNEL_REFUND_EXCEPTION_CODES)[number],
  message: string,
  remedy: string,
): never {
  throw new RefundPostException(code, message, remedy);
}

/**
 * Post one stored cancellation event.
 *
 * A cancellation is never a document of its own — that would double-post
 * against the refund the storefront sends next:
 * - an order that never posted stays excluded (ingest parks it there) and
 *   the event closes with no document;
 * - an unpaid order that posted a sales order voids it (a controlled void
 *   with the storefront's cancellation as its reason);
 * - a paid order waits for its refund: the refund posts the cash refund and
 *   retires this event, so the money moves exactly once.
 * A replay never double-voids: a voided sales order closes the event, and
 * voiding is an attributed act — an unattended run leaves the event pending
 * for the operator instead of voiding in nobody's name.
 */
export async function postChannelCancellation(
  orgId: string,
  actor: string | null,
  eventId: string,
): Promise<{ status: string; documentId: string | null; code?: string }> {
  return withOrg(orgId, async () => {
    const event = await loadChannelEvent(orgId, eventId);
    if (!event) {
      throw new CommerceError(
        "channel_event_unknown",
        "The channel event does not belong to this organization.",
        "Choose an event from this organization's channel activity.",
        { field: "eventId" },
      );
    }
    if (event.kind !== "cancellation") {
      throw new CommerceError(
        "channel_event_wrong_kind",
        `Channel event ${event.externalId} is a ${event.kind}, not a cancellation.`,
        "Void unpaid orders from cancellation events and post money from refund events.",
        { field: "eventId" },
      );
    }
    if (event.postingStatus === "posted") return { status: "posted", documentId: event.postingDocumentId };
    if (event.postingStatus === "ignored") return { status: "ignored", documentId: null };
    try {
      const outcome = await withOrgTransaction(orgId, async () => {
        await acquireOrgFeatureGateLock(db, orgId);
        if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
          throw new CommerceError("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
        }
        const live = await loadChannelEvent(orgId, eventId);
        if (!live) throw new Error("Channel cancellation left while it posted");
        if (live.postingStatus === "posted") {
          return { status: "posted", documentId: live.postingDocumentId };
        }
        if (live.postingStatus === "ignored") {
          return { status: "ignored", documentId: null as string | null };
        }
        const order = await loadChannelOrder(orgId, live.orderId);
        if (!order) throw new Error("Channel cancellation order left while it posted");
        if (order.postingStatus === "pending") {
          const parked = await db.execute(sql`
            update channel_orders
               set posting_status = 'excluded', exclude_reason = 'Cancelled at the storefront before posting.',
                   updated_by = ${actor}, updated_at = now()
             where org_id = ${orgId} and id = ${order.id} and posting_status = 'pending'`);
          if (parked.rowCount !== 1) {
            throw new Error("Channel order cancellation matched no row; the order posted while it was cancelled");
          }
          await markChannelEventPosted(orgId, eventId, actor, null);
          return { status: "posted", documentId: null as string | null };
        }
        if (order.postingStatus === "excluded" || order.postingStatus === "exception") {
          // Nothing left to void and nothing left to post: the cancellation
          // closes, and the order keeps whatever state needs the operator.
          await markChannelEventPosted(orgId, eventId, actor, null);
          return { status: "posted", documentId: null as string | null };
        }
        if (!order.postingDocumentId) {
          // Summarized orders carry their document on the batch, not the
          // order: the money path below resolves it the same way.
          return cancelSummarizedOrder(orgId, actor, order.id, eventId);
        }
        const doc = (await db.execute<{ kind: string; status: string }>(sql`
          select kind, status from documents where org_id = ${orgId} and id = ${order.postingDocumentId}`)).rows[0];
        if (!doc) throw new Error("Channel cancellation document left while it posted");
        if (doc.kind === "sales_order") {
          if (doc.status === "voided") {
            await markChannelEventPosted(orgId, eventId, actor, null);
            return { status: "posted", documentId: null as string | null };
          }
          if (!actor) {
            // Voiding is an attributed act: the unattended run leaves the
            // event pending and the operator (or API caller) replays it.
            return { status: "pending", documentId: null as string | null };
          }
          let voided: { status: string };
          try {
            voided = await requestDocumentVoid({
              documentId: order.postingDocumentId!,
              orgId,
              actorId: actor,
              reason: `Cancelled at the storefront (order ${order.externalNumber}).`,
            });
          } catch (error) {
            if (error instanceof DocumentVoidError) {
              park(
                "cancellation_blocked",
                `Order ${order.externalNumber} cannot void: ${error.message}`,
                "Resolve the blocker named above, then replay the cancellation.",
              );
            }
            throw error;
          }
          if (voided.status !== "voided") {
            return { status: "pending", documentId: null as string | null };
          }
          await markChannelEventPosted(orgId, eventId, actor, null);
          return { status: "posted", documentId: null as string | null };
        }
        // A posted cash sale (or anything else with money on it) is the
        // refund's job: a posted sibling refund already retired this event,
        // otherwise it waits for the refund to arrive.
        const refunded = (await db.execute<{ id: string }>(sql`
          select id from channel_order_events
           where org_id = ${orgId} and order_id = ${order.id} and kind = 'refund' and posting_status = 'posted'
           limit 1`)).rows[0];
        if (refunded) {
          await markChannelEventIgnored(orgId, eventId, actor);
          return { status: "ignored", documentId: null as string | null };
        }
        return { status: "pending", documentId: null as string | null };
      });
      // A cancelled storefront-fulfilled order never fulfils: its governing
      // draft closes with the cancellation, even while the money waits for
      // the refund.
      await maybeCloseGoverningOrder(orgId, actor, event.orderId);
      return { status: outcome.status, documentId: outcome.documentId };
    } catch (error) {
      if (error instanceof RefundPostException) {
        await markChannelEventException(orgId, eventId, actor, {
          code: error.code,
          reason: error.message,
          remedy: error.remedy,
        });
        return { status: "exception", documentId: null, code: error.code };
      }
      throw error;
    }
  });
}

/**
 * A summarized order's sale lives on the batch document: when the batch
 * posted a cash sale the money path belongs to the refund, so the
 * cancellation waits for it (or retires behind it) like any paid order.
 */
async function cancelSummarizedOrder(
  orgId: string,
  actor: string | null,
  orderId: string,
  eventId: string,
): Promise<{ status: string; documentId: string | null }> {
  const refunded = (await db.execute<{ id: string }>(sql`
    select id from channel_order_events
     where org_id = ${orgId} and order_id = ${orderId} and kind = 'refund' and posting_status = 'posted'
     limit 1`)).rows[0];
  if (refunded) {
    await markChannelEventIgnored(orgId, eventId, actor);
    return { status: "ignored", documentId: null };
  }
  return { status: "pending", documentId: null };
}
