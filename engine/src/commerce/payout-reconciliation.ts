import { sql } from "drizzle-orm";
import { isMatchableSettlementLineKind, setSettlementLineDocument } from "../payments/psp-settlement.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { db, withOrgContext } from "../platform/db.ts";
import { CommerceError } from "./errors.ts";

/**
 * Payout line matching. Every settlement line of a matchable kind resolves
 * to its native document through the same identity chain the channel
 * posting uses: the provider's order reference → the channel order → the
 * posted cash sale (or daily summary), refund → the posted cash refund.
 * Provider-level links in `external_links` win when they name a document
 * directly. A line that resolves to a posted document is linked; anything
 * else joins the needs-attention queue with the reason and the remedy, never
 * a guessed link. Stored links are re-verified on every pass so a deleted
 * or voided document surfaces instead of pointing at history.
 */

export type PayoutLineMatch =
  | {
    status: "matched";
    lineId: string;
    documentId: string;
    documentKind: string;
    documentNumber: string | null;
    via: "stored_link" | "channel_order" | "external_link";
  }
  | { status: "unmatched"; lineId: string; kind: string; reason: string; remedy: string }
  | { status: "not_applicable"; lineId: string; kind: string; reason: string };

export interface PayoutMatchResult {
  batchId: string;
  matched: number;
  unmatched: number;
  notApplicable: number;
  lines: PayoutLineMatch[];
}

type SettlementLineRow = {
  id: string;
  kind: string;
  external_ref: string | null;
  description: string | null;
  amount: string;
  currency: string | null;
  document_id: string | null;
  meta: Record<string, unknown> | null;
};

function refuse(code: string, message: string, remedy: string): never {
  throw new CommerceError(code, message, remedy, { field: null, status: 422 });
}

/** Shopify order ids travel as numeric strings or `gid://shopify/Order/<n>`; both read the same order. */
function orderIdCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const tail = trimmed.split("/").pop() ?? "";
  return tail !== trimmed && /^\d+$/.test(tail) ? [trimmed, tail] : [trimmed];
}

export type LineDocumentEvidence = {
  id: string;
  kind: string;
  documentNumber: string | null;
  status: string;
  currency: string | null;
  total: string | null;
};

/** One native document behind a settlement line, read for matching evidence. */
export async function readSettlementDocument(
  orgId: string,
  documentId: string,
): Promise<LineDocumentEvidence | null> {
  const row = (await db.execute<LineDocumentEvidence>(sql`
    select id, kind, document_number as "documentNumber", status, currency, total::text as total from documents
     where org_id = ${orgId} and id = ${documentId}
  `)).rows[0];
  return row ?? null;
}

async function postedDocument(
  orgId: string,
  documentId: string,
): Promise<LineDocumentEvidence | null> {
  return readSettlementDocument(orgId, documentId);
}

/**
 * Document ids the provider references claim directly through
 * `external_links`, distinct. Shared by the automatic matcher and the
 * assistance queue: both read the same identity, the matcher deciding
 * alone and the queue proposing with evidence. Missing documents stay in
 * the list so a dangling link still reads as missing, never as absent.
 */
export async function lineExternalDocumentIds(
  orgId: string,
  provider: string,
  refs: Array<string | null | undefined>,
): Promise<string[]> {
  const candidates = refs.filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (candidates.length === 0) return [];
  const links = (await db.execute<{ native_table: string; native_id: string }>(sql`
    select native_table, native_id from external_links
     where org_id = ${orgId} and provider = ${provider}
       and external_id in (${sql.join(candidates.map((candidate) => sql`${candidate}`), sql`, `)})
       and native_table = 'documents'
  `)).rows;
  return [...new Set(links.map((link) => link.native_id))];
}

export type LineSourceOrder = {
  id: string;
  channelId: string;
  externalId: string;
  externalNumber: string;
  postingStatus: string;
  postingDocumentId: string | null;
  summaryId: string | null;
};

/** Channel orders behind a settlement line's source order reference. */
export async function findLineSourceOrders(
  orgId: string,
  sourceOrderId: string,
): Promise<LineSourceOrder[]> {
  const ids = orderIdCandidates(sourceOrderId);
  if (ids.length === 0) return [];
  return (await db.execute<LineSourceOrder>(sql`
    select o.id, o.channel_id as "channelId", o.external_id as "externalId",
           o.external_number as "externalNumber", o.posting_status as "postingStatus",
           o.posting_document_id as "postingDocumentId", o.summary_id as "summaryId"
      from channel_orders o
      join sales_channels c on c.id = o.channel_id and c.org_id = o.org_id
     where o.org_id = ${orgId} and c.kind = 'shopify'
       and o.external_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
     order by o.id
  `)).rows;
}

/** The sale document id behind a channel order: per-order cash, else the posted summary, else null. */
export async function findOrderSaleDocumentId(
  orgId: string,
  order: { postingDocumentId: string | null; summaryId: string | null },
): Promise<string | null> {
  if (order.postingDocumentId) {
    return order.postingDocumentId;
  }
  if (order.summaryId) {
    const summary = (await db.execute<{ posting_document_id: string | null }>(sql`
      select posting_document_id from channel_daily_summaries
       where org_id = ${orgId} and id = ${order.summaryId}
    `)).rows[0];
    return summary?.posting_document_id ?? null;
  }
  return null;
}

/** Refund document ids behind a channel order, in event order. */
export async function findOrderRefundDocumentIds(
  orgId: string,
  orderId: string,
): Promise<string[]> {
  const events = (await db.execute<{ posting_document_id: string | null }>(sql`
    select posting_document_id from channel_order_events
     where org_id = ${orgId} and order_id = ${orderId}
       and posting_document_id is not null
  `)).rows;
  return [...new Set(events.map((event) => event.posting_document_id).filter((id): id is string => id !== null))];
}

async function resolveLineDocument(
  orgId: string,
  provider: string,
  line: SettlementLineRow,
): Promise<Omit<Extract<PayoutLineMatch, { status: "matched" }>, "lineId"> | Omit<Extract<PayoutLineMatch, { status: "unmatched" }>, "lineId" | "kind"> | null> {
  if (line.document_id) {
    const doc = await postedDocument(orgId, line.document_id);
    if (!doc) {
      return {
        status: "unmatched",
        reason: "linked_missing",
        remedy: "The linked document is gone from this organization; link the line to its replacement receipt.",
      };
    }
    if (doc.status !== "posted") {
      return {
        status: "unmatched",
        reason: "document_unposted",
        remedy: `Document ${doc.documentNumber ?? doc.id} is ${doc.status}; post it, then match the payout again.`,
      };
    }
    return {
      status: "matched",
      documentId: doc.id,
      documentKind: doc.kind,
      documentNumber: doc.documentNumber,
      via: "stored_link",
    };
  }
  if (!isMatchableSettlementLineKind(line.kind)) {
    return null;
  }
  const meta = line.meta ?? {};
  const distinct = await lineExternalDocumentIds(orgId, provider, [
    line.external_ref,
    typeof meta.sourceOrderId === "string" ? meta.sourceOrderId : null,
  ]);
  if (distinct.length > 0) {
    if (distinct.length > 1) {
      return {
        status: "unmatched",
        reason: "ambiguous_link",
        remedy: "Several documents claim this provider reference; link the line to the right receipt manually.",
      };
    }
    if (distinct.length === 1) {
      const doc = await postedDocument(orgId, distinct[0]!);
      if (!doc) {
        return {
          status: "unmatched",
          reason: "linked_missing",
          remedy: "The linked document is gone from this organization; link the line to its replacement receipt.",
        };
      }
      if (doc.status !== "posted") {
        return {
          status: "unmatched",
          reason: "document_unposted",
          remedy: `Document ${doc.documentNumber ?? doc.id} is ${doc.status}; post it, then match the payout again.`,
        };
      }
      return {
        status: "matched",
        documentId: doc.id,
        documentKind: doc.kind,
        documentNumber: doc.documentNumber,
        via: "external_link",
      };
    }
  }
  if (provider === "shopify_payments" && typeof meta.sourceOrderId === "string" && meta.sourceOrderId.trim() !== "") {
    const orders = await findLineSourceOrders(orgId, meta.sourceOrderId);
    if (orders.length === 0) {
      return {
        status: "unmatched",
        reason: "order_unknown",
        remedy: "The storefront order has not been ingested; ingest it under Channels → Orders, or link the receipt manually.",
      };
    }
    if (orders.length > 1) {
      return {
        status: "unmatched",
        reason: "ambiguous_order",
        remedy: "Several channels hold this order number; link the line to the right receipt manually.",
      };
    }
    const order = orders[0]!;
    if (line.kind === "refund" || line.kind === "dispute" || line.kind === "dispute_reversal") {
      const docs = await findOrderRefundDocumentIds(orgId, order.id);
      if (docs.length === 0) {
        return {
          status: "unmatched",
          reason: "refund_unposted",
          remedy: "The order's refund has not posted yet; post it from the channel order, then match the payout again.",
        };
      }
      if (docs.length > 1) {
        return {
          status: "unmatched",
          reason: "ambiguous_refund",
          remedy: "The order has several posted refunds; link the line to the right one manually.",
        };
      }
      const doc = await postedDocument(orgId, docs[0]!);
      if (!doc || doc.status !== "posted") {
        return {
          status: "unmatched",
          reason: "refund_unposted",
          remedy: "The order's refund is not posted; post it from the channel order, then match the payout again.",
        };
      }
      return {
        status: "matched",
        documentId: doc.id,
        documentKind: doc.kind,
        documentNumber: doc.documentNumber,
        via: "channel_order",
      };
    }
    const saleDocumentId = await findOrderSaleDocumentId(orgId, {
      postingDocumentId: order.postingDocumentId,
      summaryId: order.summaryId,
    });
    if (order.postingDocumentId) {
      const doc = saleDocumentId ? await postedDocument(orgId, saleDocumentId) : null;
      if (!doc || doc.status !== "posted") {
        return {
          status: "unmatched",
          reason: "order_unposted",
          remedy: "The channel order's document is not posted; post the order, then match the payout again.",
        };
      }
      return {
        status: "matched",
        documentId: doc.id,
        documentKind: doc.kind,
        documentNumber: doc.documentNumber,
        via: "channel_order",
      };
    }
    if (saleDocumentId) {
      const doc = await postedDocument(orgId, saleDocumentId);
      if (doc && doc.status === "posted") {
        return {
          status: "matched",
          documentId: doc.id,
          documentKind: doc.kind,
          documentNumber: doc.documentNumber,
          via: "channel_order",
        };
      }
    }
    return {
      status: "unmatched",
      reason: "order_unposted",
      remedy: "The channel order has no posted document yet; post it (or its daily summary), then match the payout again.",
    };
  }
  return {
    status: "unmatched",
    reason: "no_link",
    remedy: "No native document claims this provider reference; link the receipt manually, or mark the line as an adjustment.",
  };
}

/**
 * Match every line of a payout batch, linking what resolves to a posted
 * document. One line's failure never blocks the rest: it joins the queue
 * with its reason. Returns the per-line verdicts for the workspace.
 */
export async function matchPayoutLines(
  orgId: string,
  batchId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<PayoutMatchResult> {
  return withOrgContext(orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, orgId, "banking"))) {
      refuse(
        "payout_match_feature_off",
        "Payout reconciliation is disabled.",
        "Enable Banking in Company Settings → Features before matching payout lines.",
      );
    }
    const batch = (await db.execute<{ id: string; provider: string; subsidiary_id: string | null }>(sql`
      select id, provider, subsidiary_id from psp_settlement_batches
       where org_id = ${orgId} and id = ${batchId}
    `)).rows[0];
    if (!batch) {
      refuse(
        "payout_batch_missing",
        "The payout does not belong to this organization.",
        "Reload the payouts workspace and match a payout in this organization.",
      );
    }
    const lines = (await db.execute<SettlementLineRow>(sql`
      select id, kind, external_ref, description, amount::text, currency, document_id, meta
        from psp_settlement_lines
       where org_id = ${orgId} and batch_id = ${batchId}
       order by line_number
    `)).rows;
    const verdicts: PayoutLineMatch[] = [];
    for (const line of lines) {
      // Sequential lines share one workspace view: parallel links would
      // interleave their row locks and report stale verdicts.
      const resolved = await resolveLineDocument(orgId, batch.provider, line);
      if (!resolved || resolved.status !== "matched") {
        if (!resolved) {
          verdicts.push({ status: "not_applicable", lineId: line.id, kind: line.kind, reason: `${line.kind} lines never link to an order` });
        } else {
          verdicts.push({ status: "unmatched", lineId: line.id, kind: line.kind, reason: resolved.reason, remedy: resolved.remedy });
        }
        continue;
      }
      if (line.document_id === resolved.documentId) {
        verdicts.push({ lineId: line.id, ...resolved });
        continue;
      }
      try {
        await setSettlementLineDocument(orgId, batchId, line.id, resolved.documentId, actorId, allowedSubsidiaryIds);
        verdicts.push({ lineId: line.id, ...resolved });
      } catch (error) {
        verdicts.push({
          status: "unmatched",
          lineId: line.id,
          kind: line.kind,
          reason: "link_failed",
          remedy: error instanceof Error ? error.message.slice(0, 300) : "Linking failed; link the receipt manually.",
        });
      }
    }
    return {
      batchId,
      matched: verdicts.filter((verdict) => verdict.status === "matched").length,
      unmatched: verdicts.filter((verdict) => verdict.status === "unmatched").length,
      notApplicable: verdicts.filter((verdict) => verdict.status === "not_applicable").length,
      lines: verdicts,
    };
  });
}
