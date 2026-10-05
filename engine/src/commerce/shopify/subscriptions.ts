import { ShopifyClient } from "../../connectors/shopify.ts";

/**
 * Shopify webhook subscriptions: exactly the topics the channel adapter
 * handles, kept in sync with the channel's inbound URL. Order and refund
 * topics feed ingestion and posting, fulfilment topics feed tracking, and
 * the remainder feed catalog, inventory, locations and compliance. A topic
 * with no handler is never subscribed — an unread delivery is a lost one.
 * https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic
 */

export const SHOPIFY_WEBHOOK_TOPICS = [
  "products/create",
  "products/update",
  "products/delete",
  "inventory_levels/update",
  "locations/create",
  "locations/update",
  "locations/delete",
  "orders/create",
  "orders/updated",
  "orders/edited",
  "orders/paid",
  "orders/partially_fulfilled",
  "orders/fulfilled",
  "orders/cancelled",
  "orders/delete",
  "refunds/create",
  "fulfillments/create",
  "fulfillments/update",
  "app/uninstalled",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

const TOPIC_ENUM: Record<string, string> = {
  "products/create": "PRODUCTS_CREATE",
  "products/update": "PRODUCTS_UPDATE",
  "products/delete": "PRODUCTS_DELETE",
  "inventory_levels/update": "INVENTORY_LEVELS_UPDATE",
  "locations/create": "LOCATIONS_CREATE",
  "locations/update": "LOCATIONS_UPDATE",
  "locations/delete": "LOCATIONS_DELETE",
  "orders/create": "ORDERS_CREATE",
  "orders/updated": "ORDERS_UPDATED",
  "orders/edited": "ORDERS_EDITED",
  "orders/paid": "ORDERS_PAID",
  "orders/partially_fulfilled": "ORDERS_PARTIALLY_FULFILLED",
  "orders/fulfilled": "ORDERS_FULFILLED",
  "orders/cancelled": "ORDERS_CANCELLED",
  "orders/delete": "ORDERS_DELETE",
  "refunds/create": "REFUNDS_CREATE",
  "fulfillments/create": "FULFILLMENTS_CREATE",
  "fulfillments/update": "FULFILLMENTS_UPDATE",
  "app/uninstalled": "APP_UNINSTALLED",
  "customers/data_request": "CUSTOMERS_DATA_REQUEST",
  "customers/redact": "CUSTOMERS_REDACT",
  "shop/redact": "SHOP_REDACT",
};

const ENUM_TO_TOPIC: Record<string, string> = Object.fromEntries(
  Object.entries(TOPIC_ENUM).map(([topic, value]) => [value, topic]),
);

/**
 * Normalize a topic as the API reports it. `webhookSubscription.topic` is
 * a WebhookSubscriptionTopic enum (PRODUCTS_CREATE) while deliveries arrive
 * as REST paths (products/create); both compare as the REST path.
 * https://shopify.dev/docs/api/admin-graphql/latest/objects/WebhookSubscription
 */
export function normalizeSubscriptionTopic(topic: unknown): string {
  if (typeof topic !== "string" || topic.length === 0) return "";
  if (topic.includes("/")) return topic;
  return ENUM_TO_TOPIC[topic] ?? topic;
}

export interface ShopifySubscription {
  id: string;
  topic: string;
  callbackUrl: string | null;
}

const LIST_QUERY = `{ webhookSubscriptions(first: 250) {
  edges { node { id topic uri } }
  pageInfo { hasNextPage }
} }`;

export async function listShopifySubscriptions(client: ShopifyClient): Promise<ShopifySubscription[]> {
  const out: ShopifySubscription[] = [];
  for await (const node of client.paginate<Record<string, unknown>>(
    `query shopifySubscriptions($after: String) ${LIST_QUERY}`,
    {},
    (data) =>
      (data as { webhookSubscriptions: { edges: { node: Record<string, unknown> }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } })
        .webhookSubscriptions,
  )) {
    const uri = typeof node.uri === "string" ? node.uri : null;
    out.push({
      id: String(node.id ?? ""),
      topic: normalizeSubscriptionTopic(node.topic),
      callbackUrl: uri,
    });
  }
  return out;
}

/**
 * Create every missing handled-topic subscription pointing at the
 * channel's inbound URL. Subscriptions for the same topic pointing
 * elsewhere are left alone — another environment may own them.
 */
export async function ensureShopifySubscriptions(
  client: ShopifyClient,
  callbackUrl: string,
): Promise<{ created: string[]; existing: string[] }> {
  const current = await listShopifySubscriptions(client);
  const owned = new Set(
    current.filter((sub) => sub.callbackUrl === callbackUrl).map((sub) => sub.topic),
  );
  const created: string[] = [];
  const existing: string[] = [];
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    if (owned.has(topic)) {
      existing.push(topic);
      continue;
    }
    const { data } = await client.graphql<{
      webhookSubscriptionCreate: {
        webhookSubscription: { id: string } | null;
        userErrors: { field: string[]; message: string }[];
      };
    }>(
      `mutation shopifySubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
         webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
           webhookSubscription { id }
           userErrors { field message }
         }
       }`,
      // WebhookSubscriptionInput takes the delivery address as `uri`
      // (`callbackUrl` is deprecated); format stays JSON.
      // https://shopify.dev/docs/api/admin-graphql/latest/input-objects/WebhookSubscriptionInput
      { topic: TOPIC_ENUM[topic], webhookSubscription: { uri: callbackUrl, format: "JSON" } },
    );
    const errors = data.webhookSubscriptionCreate.userErrors;
    if (errors.length > 0 || !data.webhookSubscriptionCreate.webhookSubscription) {
      throw new Error(
        `Shopify refused the ${topic} subscription: ${errors[0]?.message ?? "no subscription returned"} — subscribe it by hand in Shopify admin Settings → Notifications, pointing at the channel webhook URL`,
      );
    }
    created.push(topic);
  }
  return { created, existing };
}

/** Remove every subscription pointing at the channel's inbound URL. */
export async function removeShopifySubscriptions(
  client: ShopifyClient,
  callbackUrl: string,
): Promise<{ removed: string[] }> {
  const current = await listShopifySubscriptions(client);
  const removed: string[] = [];
  for (const sub of current.filter((entry) => entry.callbackUrl === callbackUrl)) {
    const { data } = await client.graphql<{
      webhookSubscriptionDelete: {
        deletedWebhookSubscriptionId: string | null;
        userErrors: { field: string[]; message: string }[];
      };
    }>(
      `mutation shopifySubscriptionDelete($id: ID!) {
         webhookSubscriptionDelete(id: $id) {
           deletedWebhookSubscriptionId
           userErrors { field message }
         }
       }`,
      { id: sub.id },
    );
    if (data.webhookSubscriptionDelete.deletedWebhookSubscriptionId) removed.push(sub.topic);
  }
  return { removed };
}
