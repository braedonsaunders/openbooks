import { ShopifyClient } from "../../connectors/shopify.ts";

/**
 * Shopify webhook subscriptions: the topics the adapter handles, kept in
 * sync with the channel's inbound URL. Order, refund, fulfilment and
 * payout topics are deliberately NOT subscribed — a later change owns
 * those handlers and their subscriptions.
 */

export const SHOPIFY_WEBHOOK_TOPICS = [
  "products/create",
  "products/update",
  "products/delete",
  "inventory_levels/update",
  "locations/create",
  "locations/update",
  "locations/delete",
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
  "app/uninstalled": "APP_UNINSTALLED",
  "customers/data_request": "CUSTOMERS_DATA_REQUEST",
  "customers/redact": "CUSTOMERS_REDACT",
  "shop/redact": "SHOP_REDACT",
};

export interface ShopifySubscription {
  id: string;
  topic: string;
  callbackUrl: string | null;
}

const LIST_QUERY = `{ webhookSubscriptions(first: 250) {
  edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
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
    const endpoint = (node.endpoint ?? {}) as { callbackUrl?: unknown };
    out.push({
      id: String(node.id ?? ""),
      topic: String(node.topic ?? ""),
      callbackUrl: typeof endpoint.callbackUrl === "string" ? endpoint.callbackUrl : null,
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
      { topic: TOPIC_ENUM[topic], webhookSubscription: { callbackUrl, format: "JSON" } },
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
