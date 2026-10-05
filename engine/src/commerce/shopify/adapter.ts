import { sql } from "drizzle-orm";
import { ShopifyClient } from "../../connectors/shopify.ts";
import { registerChannelAdapter, registeredChannelKinds } from "../adapters.ts";
import type {
  ChannelContext,
  ChannelEventOutcome,
  ChannelInboundDelivery,
  ChannelWorkspaceTab,
  SalesChannelAdapter,
} from "../contracts.ts";
import { disconnectChannelByProvider } from "../channels.ts";
import {
  normalizeWebhookProduct,
  retireCatalogProduct,
  upsertCatalogProduct,
} from "./catalog.ts";
import { loadShopifyChannel, shopifySettingsSchema } from "./channel-access.ts";
import { CommerceError } from "../errors.ts";
import { applyLocationWebhook } from "./locations.ts";
import { shopifyDeliveryShop, verifyShopifyWebhook } from "./webhooks.ts";
import { db, withOrg } from "../../platform/db.ts";

/**
 * The Shopify storefront adapter: HMAC verification, catalog and location
 * webhooks, compliance deliveries, and the uninstall signal. Order,
 * refund, fulfilment and payout topics are stored but left for a later
 * change that posts them — this adapter says so per delivery instead of
 * dropping them.
 */

const LATER_CHANGE = "kept for the channel order surface a later change adds; the delivery stays stored and replays then";

const DEFERRED_TOPICS = [
  "orders/create",
  "orders/updated",
  "orders/cancelled",
  "orders/delete",
  "orders/edited",
  "orders/fulfilled",
  "orders/paid",
  "orders/partially_fulfilled",
  "refunds/create",
  "fulfillments/create",
  "fulfillments/update",
  "fulfillment_orders",
  "disputes/create",
  "disputes/update",
  "shopify_payments/payouts",
  "gift_cards/create",
  "gift_cards/update",
];

function refuse(code: string, message: string, remedy: string, field: string | null = null): never {
  throw new CommerceError(code, message, remedy, { field });
}

function parseBody(rawBody: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    refuse(
      "shopify_body_unreadable",
      "The Shopify delivery body is not readable JSON.",
      "Ask Shopify to resend the webhook from Settings → Notifications.",
      "topic",
    );
  }
}

async function writeComplianceAudit(
  orgId: string,
  channelId: string,
  topic: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'sales_channels', ${channelId}, 'update',
      ${JSON.stringify({ before: null, after: { topic, ...detail }, reason: "Shopify mandatory compliance webhook" })}::jsonb, null)`);
}

function customerNeedles(payload: Record<string, unknown>): string[] {
  const customer = (payload.customer ?? {}) as Record<string, unknown>;
  const needles: string[] = [];
  for (const value of [customer.id, customer.email, customer.phone]) {
    if (typeof value === "string" && value.trim() !== "") needles.push(value.trim());
    else if (typeof value === "number") needles.push(String(value));
  }
  return [...new Set(needles)];
}

/**
 * Erase stored inbound bodies mentioning the customer, replacing each
 * with a tombstone that keeps the row (dedupe key intact) while carrying
 * no personal data. A tombstoned delivery processes to `ignored`, so a
 * pending event that has not run yet can never resurrect the data.
 */
async function redactCustomerBodies(orgId: string, channelId: string, needles: string[]): Promise<number> {
  if (needles.length === 0) return 0;
  const tombstone = JSON.stringify({
    redacted: "customers_redact",
    redactedAt: new Date().toISOString(),
  });
  const conditions = needles.map((needle) => sql`convert_from(raw_body, 'UTF8') like ${`%${needle}%`}`);
  const combined = conditions.reduce((left, right) => sql`${left} or ${right}`);
  const updated = await db.execute(sql`
    update integration_inbound_events
       set raw_body = ${Buffer.from(tombstone, "utf8")},
           error = 'Redacted for a Shopify customer erasure request.',
           updated_at = now()
     where org_id = ${orgId} and channel_id = ${channelId}
       and convert_from(raw_body, 'UTF8') not like '%"redacted":%'
       and (${combined})`);
  return updated.rowCount ?? 0;
}

async function redactChannelBodies(orgId: string, channelId: string, marker: string): Promise<number> {
  const tombstone = JSON.stringify({ redacted: marker, redactedAt: new Date().toISOString() });
  const updated = await db.execute(sql`
    update integration_inbound_events
       set raw_body = ${Buffer.from(tombstone, "utf8")},
           error = 'Redacted for a Shopify shop erasure request.',
           updated_at = now()
     where org_id = ${orgId} and channel_id = ${channelId}
       and convert_from(raw_body, 'UTF8') not like '%"redacted":%'`);
  return updated.rowCount ?? 0;
}

async function handleCompliance(
  orgId: string,
  channelId: string,
  topic: string,
  payload: Record<string, unknown>,
): Promise<ChannelEventOutcome> {
  const customer = (payload.customer ?? {}) as Record<string, unknown>;
  if (topic === "customers/data_request") {
    await writeComplianceAudit(orgId, channelId, topic, {
      customerId: customer.id ?? null,
      email: customer.email ?? null,
    });
    return {
      action: "processed",
      resultRef: {
        compliance: "customers_data_request",
        customerId: customer.id ?? null,
        email: customer.email ?? null,
        controllerAction:
          "Collect this customer's channel deliveries under Channels → Activity and answer them within 30 days; this audit row is the controller's record of the request.",
      },
    };
  }
  if (topic === "customers/redact") {
    const needles = customerNeedles(payload);
    const redacted = await redactCustomerBodies(orgId, channelId, needles);
    await writeComplianceAudit(orgId, channelId, topic, {
      customerId: customer.id ?? null,
      email: customer.email ?? null,
      bodiesRedacted: redacted,
    });
    return {
      action: "processed",
      resultRef: {
        compliance: "customers_redact",
        customerId: customer.id ?? null,
        bodiesRedacted: redacted,
        controllerAction:
          needles.length === 0
            ? "The delivery names no customer identifiers, so nothing could be matched; confirm the customer with Shopify and record the erasure for the controller."
            : "Matching stored deliveries were tombstoned; confirm no later order surface holds this customer and record the erasure for the controller.",
      },
    };
  }
  // shop/redact: erase every stored delivery for the shop after uninstall.
  const redacted = await redactChannelBodies(orgId, channelId, "shop_redact");
  await writeComplianceAudit(orgId, channelId, topic, { bodiesRedacted: redacted });
  return {
    action: "processed",
    resultRef: {
      compliance: "shop_redact",
      bodiesRedacted: redacted,
      controllerAction:
        "Every stored delivery for this shop was tombstoned; confirm no later order surface holds this shop's customers and record the erasure for the controller.",
    },
  };
}

const shopifyAdapter: SalesChannelAdapter = {
  kind: "shopify",

  describeSettings() {
    return shopifySettingsSchema;
  },

  verifyWebhook(rawBody: Buffer, headers: Record<string, string>, secret: string) {
    return verifyShopifyWebhook(rawBody, headers, secret);
  },

  async testConnection(ctx: ChannelContext, channelId: string) {
    try {
      const channel = await loadShopifyChannel(ctx.orgId, channelId);
      const client = new ShopifyClient({ shopDomain: channel.shop, accessToken: channel.accessToken });
      const shop = await client.shopIdentity();
      if (shop.myshopifyDomain.toLowerCase() !== channel.shop.toLowerCase()) {
        return {
          ok: false,
          detail: `The token belongs to ${shop.myshopifyDomain}, not ${channel.shop} — reconnect the channel for the right shop under Channels.`,
        };
      }
      return {
        ok: true,
        detail: `Connected to ${shop.name} (${shop.planName}), pricing in ${shop.currencyCode}.`,
      };
    } catch (error) {
      const detail =
        error instanceof CommerceError
          ? `${error.message} ${error.remedy}`
          : "The Shopify storefront did not answer — retry, and check the shop domain under Channels → Settings.";
      return { ok: false, detail };
    }
  },

  async handleEvent(delivery: ChannelInboundDelivery): Promise<ChannelEventOutcome> {
    const { orgId, channelId } = delivery;
    return withOrg(orgId, async () => {
      const channel = await loadShopifyChannel(orgId, channelId);
      const claimedShop = shopifyDeliveryShop(delivery.headers);
      if (!claimedShop) {
        refuse(
          "shopify_shop_missing",
          "The Shopify delivery carries no X-Shopify-Shop-Domain header.",
          "Accept deliveries only from Shopify webhook subscriptions, which always send the shop domain.",
          null,
        );
      }
      if (claimedShop.toLowerCase() !== channel.shop.toLowerCase()) {
        refuse(
          "shopify_shop_mismatch",
          `The delivery claims shop "${claimedShop}" but channel "${channel.name}" connects ${channel.shop}.`,
          "Check the webhook subscriptions in Shopify admin point at this channel's inbound URL, not another store's.",
          null,
        );
      }
      const body = parseBody(delivery.rawBody);
      if (typeof body.redacted === "string") {
        return {
          action: "ignored",
          resultRef: { redacted: body.redacted, reason: "Tombstoned for a Shopify erasure request; the personal data is gone." },
        };
      }
      const topic = delivery.topic;
      if (topic === "products/create" || topic === "products/update") {
        const { product, variants } = normalizeWebhookProduct(body, channel.currency);
        const outcome = await upsertCatalogProduct(orgId, null, channel, product, variants);
        return {
          action: "processed",
          resultRef: {
            product: product.title,
            variants: outcome.variants,
            matchedBySku: outcome.matchedBySku,
            matchedByBarcode: outcome.matchedByBarcode,
            queued: outcome.queued,
            conflicts: outcome.conflicts,
          },
        };
      }
      if (topic === "products/delete") {
        const { product } = normalizeWebhookProduct(body, channel.currency);
        const retired = await retireCatalogProduct(orgId, null, channelId, product.externalId);
        return { action: "processed", resultRef: { product: product.title, ...retired } };
      }
      if (topic === "inventory_levels/update") {
        const item = (body.inventory_item_id ?? body.inventoryItemId ?? null) as unknown;
        return {
          action: "processed",
          resultRef: {
            recorded: true,
            inventoryItemId: typeof item === "number" || typeof item === "string" ? String(item) : null,
            available: (body.available ?? null) as unknown,
            note: "The level is recorded on this event; stock reconciliation with the storefront arrives with the inventory push surface a later change adds.",
          },
        };
      }
      if (topic === "locations/create" || topic === "locations/update" || topic === "locations/delete") {
        const applied = await applyLocationWebhook(orgId, null, channel, topic, body);
        return { action: "processed", resultRef: applied };
      }
      if (topic === "app/uninstalled") {
        await disconnectChannelByProvider(orgId, channelId, "Shopify reported the app uninstalled");
        return {
          action: "processed",
          resultRef: {
            disconnected: true,
            note: "The channel is disconnected; its history stays. Reconnecting is a new channel.",
          },
        };
      }
      if (topic === "customers/data_request" || topic === "customers/redact" || topic === "shop/redact") {
        return handleCompliance(orgId, channelId, topic, body);
      }
      if ((DEFERRED_TOPICS as readonly string[]).includes(topic) || topic.startsWith("orders/") || topic.startsWith("fulfillments/")) {
        return { action: "ignored", resultRef: { topic, reason: LATER_CHANGE } };
      }
      return {
        action: "ignored",
        resultRef: { topic, reason: "This connector handles no such topic; the delivery stays stored for review." },
      };
    });
  },

  workspaceTabs(): ChannelWorkspaceTab[] {
    return [
      { key: "products", labelKey: "channels.tabs.products" },
      { key: "locations", labelKey: "channels.tabs.locations" },
    ];
  },
};

/**
 * Register the Shopify adapter exactly once per process. The inbound
 * inbox calls this before routing (never at import time): production
 * workers arrive with no adapter installed, while tests that register
 * their own kind double keep it — the first registration wins either
 * way, and a real second Shopify adapter still refuses loudly at its
 * own register call.
 */
export function ensureShopifyAdapterRegistered(): void {
  try {
    registerChannelAdapter(shopifyAdapter);
  } catch (error) {
    if (error instanceof CommerceError && error.code === "channel_adapter_duplicate") return;
    throw error;
  }
}

export function installedChannelKinds(): string[] {
  ensureShopifyAdapterRegistered();
  return registeredChannelKinds();
}


