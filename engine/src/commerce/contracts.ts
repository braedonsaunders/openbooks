import { z } from "zod";

/**
 * The channel adapter contract. `commerce` is the only module that knows a
 * storefront exists: adapters translate provider objects into the
 * channel-neutral types below, and posting code never branches on a provider
 * name. A later change adds the first production adapter; tests register a
 * test adapter through `commerce/adapters.ts`.
 */

/** Storefront kinds the engine can route. Widened by later changes. */
export const CHANNEL_KINDS = ["shopify"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Lifecycle states of a channel connection. */
export const CHANNEL_STATUSES = [
  "draft",
  "connecting",
  "active",
  "paused",
  "disconnected",
  "error",
] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** Posting roles mapped per channel, gateway, and tax jurisdiction. */
export const CHANNEL_ACCOUNT_ROLES = [
  "gateway_clearing",
  "revenue",
  "discount",
  "shipping_income",
  "gift_card_liability",
  "sales_tax_liability",
  "rounding",
  "refund_clearing",
] as const;
export type ChannelAccountRole = (typeof CHANNEL_ACCOUNT_ROLES)[number];

/** A storefront product: the parent of its variants. */
export interface ChannelProduct {
  externalId: string;
  externalParentId: string | null;
  title: string;
  description: string | null;
  vendor: string | null;
  productType: string | null;
  status: string;
  updatedAt: string | null;
}

/** One purchasable variant of a storefront product. */
export interface ChannelVariant {
  externalId: string;
  productExternalId: string;
  sku: string | null;
  barcode: string | null;
  title: string;
  optionValues: Record<string, string>;
  /** ISO currency the price is quoted in. */
  currencyCode: string;
  /** Minor units in the variant currency. */
  priceMinor: bigint;
  compareAtPriceMinor: bigint | null;
  taxable: boolean;
  inventoryTracked: boolean;
  updatedAt: string | null;
}

/** A tax line on a channel order line: jurisdiction and who collected. */
export interface ChannelTaxLine {
  jurisdiction: string;
  /** Who collected the tax: the storefront, the marketplace, or OpenBooks. */
  collectedBy: string;
  /** Minor units in the shop currency. */
  amountMinor: bigint;
  ratePercent: string | null;
}

/** One order line: SKU first, variant link second, exception when neither maps. */
export interface ChannelOrderLine {
  sku: string | null;
  variantExternalId: string | null;
  title: string;
  quantity: string;
  /** Minor units each, in the shop currency. */
  priceMinor: bigint;
  discountMinor: bigint;
  /** Storefront discount code, mapped to a promotion at posting time. */
  discountCode: string | null;
  taxLines: ChannelTaxLine[];
  giftCard: boolean;
  promotionId: string | null;
}

/** One shipping line with its tender-agnostic charge. */
export interface ChannelShippingLine {
  title: string;
  /** Minor units in the shop currency. */
  amountMinor: bigint;
  discountMinor: bigint;
  taxLines: ChannelTaxLine[];
}

/** One tender: how the buyer paid, gateway by gateway. */
export interface ChannelTender {
  gateway: string;
  /** Minor units in the shop currency. */
  amountMinor: bigint;
  giftCardExternalId: string | null;
  authorizationRef: string | null;
}

/**
 * A channel order in neutral terms: external identity, both currencies,
 * totals in minor units, fulfilment and financial state, normalized lines,
 * shipping, and tenders. Posting code reads this, never provider payloads.
 */
export interface ChannelOrder {
  externalId: string;
  number: string;
  customerExternalId: string | null;
  /** Buyer contact snapshot for customer matching and the exception queue. */
  customerName: string | null;
  customerEmail: string | null;
  customerAddress: Record<string, unknown> | null;
  /** Storefront tags and source for the channel's exclusion rules. */
  tags: string[];
  source: string | null;
  shopCurrency: string;
  presentmentCurrency: string;
  /** Minor units in the shop currency. */
  subtotalMinor: bigint;
  taxMinor: bigint;
  shippingMinor: bigint;
  discountMinor: bigint;
  totalMinor: bigint;
  financialStatus: string;
  fulfilmentStatus: string;
  lines: ChannelOrderLine[];
  shippingLines: ChannelShippingLine[];
  tenders: ChannelTender[];
  orderedAt: string;
  cancelledAt: string | null;
}

/** A refund or cancellation against one channel order. */
export interface ChannelRefund {
  externalId: string;
  orderExternalId: string;
  reason: string | null;
  restock: boolean;
  /** Minor units refunded, in the shop currency. */
  totalMinor: bigint;
  lines: Array<{
    lineExternalId: string | null;
    sku: string | null;
    variantExternalId: string | null;
    quantity: string;
    amountMinor: bigint;
    /** Merchant tax slice of the line when the provider states it; otherwise pro-rated from the sale. */
    taxMinor: bigint | null;
    /** Whether these units go back on the shelf (location-mapped). */
    restock: boolean;
  }>;
  /** Shipping refunded through order adjustments, in the shop currency. */
  shippingMinor: bigint;
  tenders: Array<{ gateway: string; amountMinor: bigint }>;
  refundedAt: string;
}

/** A provider payout: settlement of gateway tenders to the bank. */
export interface ChannelPayout {
  externalId: string;
  gateway: string;
  /** Minor units in the payout currency. */
  amountMinor: bigint;
  feeMinor: bigint;
  currency: string;
  status: string;
  paidAt: string | null;
}

/** A verified inbound delivery, ready for the adapter's event handler. */
export interface ChannelInboundDelivery {
  eventId: string;
  topic: string;
  channelId: string;
  orgId: string;
  rawBody: Buffer;
  headers: Record<string, string>;
}

/** The outcome an adapter reports after handling one inbound event. */
export interface ChannelEventOutcome {
  action: "processed" | "ignored";
  /** Snapshot the Activity tab shows for this event. */
  resultRef: Record<string, unknown>;
}

/** Per-request context an adapter receives: tenant and actor. */
export interface ChannelContext {
  orgId: string;
  actorId: string;
}

/**
 * One workspace tab contributed by an adapter (Products, Orders, Exceptions,
 * and Payouts arrive with the order and payout surfaces). The shell renders
 * tabs in registration order after the built-in Overview, Activity, and
 * Settings tabs.
 */
export interface ChannelWorkspaceTab {
  key: string;
  /**
   * next-intl label key the shell translates. Keys are fully namespaced
   * (`channels.tabs.products`); the workspace translator is scoped to the
   * channels catalog, so the shell strips the `channels.` prefix before
   * resolving and renders the key path itself when no catalog entry
   * matches. A rendered key path means the adapter declaration or the
   * catalog is wrong, not the shell.
   */
  labelKey: string;
}

export interface SalesChannelAdapter {
  readonly kind: string;
  /** Zod schema validating the channel's `settings` jsonb. */
  describeSettings(): z.ZodType<unknown>;
  /**
   * Verify a provider delivery over its RAW bytes with a constant-time
   * signature compare. Returns the provider event id and topic, or throws a
   * CommerceError naming the failure (bad signature, missing headers). A
   * failed verification stores nothing.
   */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string>,
    secret: string,
  ): { eventId: string; topic: string };
  /** Live connectivity probe against the provider. Never throws: reports. */
  testConnection(ctx: ChannelContext, channelId: string): Promise<{ ok: boolean; detail: string }>;
  /** Translate and apply one verified delivery. Idempotent per event id. */
  handleEvent(delivery: ChannelInboundDelivery): Promise<ChannelEventOutcome>;
  /** Extra workspace tabs this adapter contributes. Catalog and location tabs arrive with the Shopify connector; order and payout tabs arrive with their surfaces. */
  workspaceTabs(): ChannelWorkspaceTab[];
}
