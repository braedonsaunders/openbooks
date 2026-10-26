/**
 * Pure comparison of a paired intercompany sales document and purchase
 * document. The selling entity's document and the buying entity's mirror
 * must agree on currency, total and the quantity of every item; their
 * lifecycles are reported side by side so a voided or lagging counterpart is
 * visible. No database: the pairing service loads both documents and calls
 * this for the workspace, the reconciliation report and the pair drawer.
 */
import { toUnits } from "../money/money.ts";

export type PairKind = "order" | "invoice" | "credit";

export const SELLER_KIND: Readonly<Record<PairKind, string>> = {
  order: "sales_order",
  invoice: "customer_invoice",
  credit: "customer_credit",
};

export const BUYER_KIND: Readonly<Record<PairKind, string>> = {
  order: "purchase_order",
  invoice: "vendor_bill",
  credit: "vendor_credit",
};

/** The pair kind and side a document kind takes part in, or null. */
export function pairSideOf(kind: string): { pairKind: PairKind; side: "seller" | "buyer" } | null {
  for (const pairKind of Object.keys(SELLER_KIND) as PairKind[]) {
    if (SELLER_KIND[pairKind] === kind) return { pairKind, side: "seller" };
    if (BUYER_KIND[pairKind] === kind) return { pairKind, side: "buyer" };
  }
  return null;
}

export interface PairedDocumentSummary {
  documentId: string;
  documentNumber: string;
  status: string;
  currency: string;
  total: string;
  /** Quantity per item; lines without an item are compared through the total. */
  quantities: Record<string, string>;
}

export type PairMismatch =
  | { kind: "currency"; seller: string; buyer: string }
  | { kind: "amount"; seller: string; buyer: string; difference: string }
  | { kind: "quantity"; itemId: string; seller: string; buyer: string }
  | { kind: "voided"; side: "seller" | "buyer" };

export type PairSyncState = "in_sync" | "awaiting_counterpart" | "mismatched";

export interface PairComparison {
  state: PairSyncState;
  mismatches: PairMismatch[];
}

const POSTED_LIKE = new Set(["approved", "posted"]);

function units8(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^[-+]/, "").split(".");
  const result =
    BigInt(whole || "0") * 100_000_000n + BigInt((fraction + "00000000").slice(0, 8) || "0");
  return negative ? -result : result;
}

/**
 * Compare a pair. Mismatches are the economic disagreements; a pair whose
 * documents agree but whose lifecycles differ (an approved invoice against a
 * draft bill) is awaiting its counterpart rather than mismatched.
 */
export function comparePairedDocuments(
  seller: PairedDocumentSummary,
  buyer: PairedDocumentSummary,
): PairComparison {
  const mismatches: PairMismatch[] = [];
  if (seller.status === "voided") mismatches.push({ kind: "voided", side: "seller" });
  if (buyer.status === "voided") mismatches.push({ kind: "voided", side: "buyer" });
  if (seller.currency !== buyer.currency) {
    mismatches.push({ kind: "currency", seller: seller.currency, buyer: buyer.currency });
  } else {
    const difference = toUnits(seller.total) - toUnits(buyer.total);
    if (difference !== 0n) {
      const sign = difference < 0n ? "-" : "";
      const magnitude = difference < 0n ? -difference : difference;
      mismatches.push({
        kind: "amount",
        seller: seller.total,
        buyer: buyer.total,
        difference: `${sign}${magnitude / 10_000n}.${(magnitude % 10_000n).toString().padStart(4, "0")}`,
      });
    }
  }
  const items = [
    ...new Set([...Object.keys(seller.quantities), ...Object.keys(buyer.quantities)]),
  ].sort();
  for (const itemId of items) {
    const sold = seller.quantities[itemId] ?? "0";
    const bought = buyer.quantities[itemId] ?? "0";
    if (units8(sold) !== units8(bought))
      mismatches.push({ kind: "quantity", itemId, seller: sold, buyer: bought });
  }
  if (mismatches.length > 0) return { state: "mismatched", mismatches };
  const sellerLive = POSTED_LIKE.has(seller.status);
  const buyerLive = POSTED_LIKE.has(buyer.status);
  return { state: sellerLive === buyerLive ? "in_sync" : "awaiting_counterpart", mismatches };
}
