import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchWithConnectorRetry } from "./http-retry.ts";

/**
 * Shopify Admin GraphQL client: the only HTTP the Shopify connector makes.
 * One pinned quarterly API version, bearer auth over
 * `X-Shopify-Access-Token`, cursor pagination, bulk-operation exports for
 * full catalog reads, and Shopify's own cost throttle honored before the
 * shared 429/5xx retry loop. Money arrives as decimal strings and is never
 * parsed here — minor-unit conversion belongs to the commerce pack with the
 * currency exponent beside it.
 */

/** The single Admin API version every Shopify call pins. Bump in one place. */
export const SHOPIFY_API_VERSION = "2025-10";

/** Shop domains live here and nowhere else; anything else never gets a request. */
export const SHOPIFY_SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export const SHOPIFY_BASE_SCOPES = [
  "read_products",
  "read_inventory",
  "read_locations",
  "read_orders",
  "write_orders",
  "read_fulfillments",
  "write_fulfillments",
  "read_customers",
  "read_shopify_payments_payouts",
  "read_gift_cards",
  "read_discounts",
] as const;

/** Write scopes added only when catalog push is enabled at connect time. */
export const SHOPIFY_PUSH_SCOPES = ["write_products", "write_inventory"] as const;

export function shopifyScopes(pushCatalog: boolean): string[] {
  return [...SHOPIFY_BASE_SCOPES, ...(pushCatalog ? SHOPIFY_PUSH_SCOPES : [])];
}

function refuseShopDomain(shopDomain: unknown): never {
  throw new Error(
    `Shopify shop domain "${String(shopDomain)}" is not a myshopify.com storefront — enter the shop's xxx.myshopify.com domain from Shopify admin Settings`,
  );
}

export function normalizeShopDomain(shopDomain: unknown): string {
  const cleaned = typeof shopDomain === "string" ? shopDomain.trim().toLowerCase() : "";
  const bare = cleaned.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!SHOPIFY_SHOP_DOMAIN_RE.test(bare)) refuseShopDomain(shopDomain);
  return bare;
}

export interface ShopifyThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface ShopifyGraphqlEnvelope<T> {
  data: T;
  throttleStatus: ShopifyThrottleStatus | null;
  cost: { requested: number; actual: number } | null;
}

interface ShopifyErrorExtension {
  code?: unknown;
}

function isThrottled(errors: Array<{ extensions?: ShopifyErrorExtension }>): boolean {
  return errors.some((entry) => entry.extensions?.code === "THROTTLED");
}

/**
 * How long a THROTTLED call waits before its retry: the restore time for
 * the spent budget, bounded so a hostile throttleStatus cannot stall the
 * worker. Floor keeps a zero-restore response from hot-looping.
 */
export function throttleWaitMs(status: ShopifyThrottleStatus | null): number {
  const CAP_MS = 60_000;
  if (!status || !Number.isFinite(status.restoreRate) || status.restoreRate <= 0) return 5_000;
  const spent = Math.max(0, status.maximumAvailable - status.currentlyAvailable);
  const waitSeconds = spent / status.restoreRate;
  if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) return 5_000;
  return Math.min(CAP_MS, Math.max(1_000, Math.ceil(waitSeconds * 1000)));
}

export interface ShopifyClientOptions {
  shopDomain: string;
  accessToken: string;
  transport?: typeof fetch;
  sleepMs?: (ms: number) => Promise<void>;
  /** GraphQL-level THROTTLED retries after the first attempt. */
  maxThrottleRetries?: number;
  /** Bulk-operation status polls before refusing. */
  maxBulkPolls?: number;
  pollIntervalMs?: number;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class ShopifyClient {
  private readonly shop: string;
  private readonly token: string;
  private readonly transport: typeof fetch | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxThrottleRetries: number;
  private readonly maxBulkPolls: number;
  private readonly pollIntervalMs: number;

  constructor(options: ShopifyClientOptions) {
    this.shop = normalizeShopDomain(options.shopDomain);
    if (typeof options.accessToken !== "string" || options.accessToken.trim() === "") {
      throw new Error(
        "Shopify access token is missing — connect with OAuth or paste a custom-app Admin API token under Channels → Connect Shopify",
      );
    }
    this.token = options.accessToken;
    this.transport = options.transport;
    this.sleep = options.sleepMs ?? DEFAULT_SLEEP;
    this.maxThrottleRetries = options.maxThrottleRetries ?? 2;
    this.maxBulkPolls = options.maxBulkPolls ?? 150;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
  }

  get endpoint(): string {
    return `https://${this.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  }

  private async postGraphql(body: Record<string, unknown>): Promise<Response> {
    return fetchWithConnectorRetry(
      this.endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "X-Shopify-Access-Token": this.token,
        },
        body: JSON.stringify(body),
      },
      { describe: "Shopify", transport: this.transport },
    );
  }

  /**
   * One GraphQL call with Shopify's cost throttle honored: a THROTTLED
   * error sleeps the restore window (bounded) and retries instead of
   * failing the sync, up to the throttle budget. HTTP 429/5xx already
   * retry inside the shared connector loop.
   */
  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<ShopifyGraphqlEnvelope<T>> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.postGraphql({ query, variables: variables ?? {} });
      const payload = (await res.json()) as {
        data?: T;
        errors?: Array<{ message?: string; extensions?: ShopifyErrorExtension }>;
        extensions?: {
          cost?: {
            throttleStatus?: ShopifyThrottleStatus;
            requestedQueryCost?: unknown;
            actualQueryCost?: unknown;
          };
        };
      };
      const throttle = payload.extensions?.cost?.throttleStatus ?? null;
      const requested = payload.extensions?.cost?.requestedQueryCost;
      const actual = payload.extensions?.cost?.actualQueryCost;
      const cost =
        typeof requested === "number" && typeof actual === "number" ? { requested, actual } : null;
      const errors = payload.errors ?? [];
      if (isThrottled(errors)) {
        if (attempt >= this.maxThrottleRetries) {
          throw new Error(
            `Shopify API throttle budget spent after ${attempt + 1} attempts — the sync resumes on its next run; lower the catalog page size under Channels → Settings → Advanced if this repeats`,
          );
        }
        await this.sleep(throttleWaitMs(throttle));
        continue;
      }
      if (errors.length > 0) {
        const first = errors[0]?.message ?? "unknown GraphQL error";
        throw new Error(`Shopify Admin API refused the call: ${first} — correct the query or scopes and retry`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Shopify refused the credentials (HTTP ${res.status}) — reconnect the channel under Channels to refresh the access token`,
        );
      }
      if (payload.data === undefined) {
        throw new Error("Shopify answered without data or errors — retry the sync, and ask your administrator if it persists");
      }
      return { data: payload.data, throttleStatus: throttle, cost };
    }
  }

  /** Walk a Relay connection to its end, yielding every node exactly once. */
  async *paginate<T>(
    query: string,
    variables: Record<string, unknown>,
    pick: (data: unknown) => { edges: { node: T }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } },
  ): AsyncGenerator<T> {
    let after: string | null = null;
    for (;;) {
      const { data } = await this.graphql<unknown>(query, { ...variables, after });
      const connection = pick(data);
      for (const edge of connection.edges) yield edge.node;
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) return;
      after = connection.pageInfo.endCursor;
    }
  }

  /**
   * Run a bulk-operation export (full catalog reads) and stream every JSONL
   * result line to the sink. Polls with backoff to a bounded number of
   * status checks; a FAILED or CANCELED operation refuses by name.
   */
  async bulkQuery(
    bulkQuery: string,
    onLine: (line: Record<string, unknown>) => Promise<void> | void,
  ): Promise<{ objectCount: string | null }> {
    const started = await this.graphql<{
      bulkOperationRunQuery: {
        bulkOperation: { id: string; status: string } | null;
        userErrors: { field: string[]; message: string }[];
      };
    }>(
      `mutation shopifyBulkRun($query: String!) {
         bulkOperationRunQuery(query: $query) {
           bulkOperation { id status }
           userErrors { field message }
         }
       }`,
      { query: bulkQuery },
    );
    const userErrors = started.data.bulkOperationRunQuery.userErrors;
    if (userErrors.length > 0) {
      throw new Error(
        `Shopify refused the bulk export: ${userErrors[0]!.message} — narrow the bulk query and run the import again`,
      );
    }
    let url: string | null = null;
    let objectCount: string | null = null;
    for (let poll = 0; poll < this.maxBulkPolls; poll += 1) {
      const current = await this.graphql<{
        currentBulkOperation: { id: string; status: string; url: string | null; objectCount: string | null; errorCode: string | null } | null;
      }>(
        `{ currentBulkOperation(type: QUERY) { id status url objectCount errorCode } }`,
      );
      const operation = current.data.currentBulkOperation;
      if (!operation) {
        throw new Error("Shopify lost the bulk export — run the catalog import again");
      }
      if (operation.status === "COMPLETED") {
        url = operation.url;
        objectCount = operation.objectCount;
        break;
      }
      if (operation.status === "FAILED" || operation.status === "CANCELED") {
        throw new Error(
          `Shopify ${operation.status === "FAILED" ? "failed" : "canceled"} the bulk export${operation.errorCode ? ` (${operation.errorCode})` : ""} — run the catalog import again`,
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
    if (!url) {
      throw new Error(
        "Shopify bulk export did not finish in time — it keeps running at Shopify; poll Channels → Activity and re-import when it completes",
      );
    }
    const file = await fetchWithConnectorRetry(url, { headers: { authorization: `Bearer ${this.token}` } }, { describe: "Shopify", transport: this.transport });
    const text = await file.text();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("Shopify bulk file holds a corrupt line — run the catalog import again");
      }
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Shopify bulk file holds a corrupt line — run the catalog import again");
      }
      await onLine(parsed as Record<string, unknown>);
    }
    return { objectCount };
  }

  /** Live connectivity probe: the shop's identity and plan surface. */
  async shopIdentity(): Promise<{ name: string; myshopifyDomain: string; planName: string; currencyCode: string }> {
    const { data } = await this.graphql<{
      shop: { name: string; myshopifyDomain: string; plan: { displayName: string }; currencyCode: string };
    }>(`{ shop { name myshopifyDomain plan { displayName } currencyCode } }`);
    return {
      name: data.shop.name,
      myshopifyDomain: data.shop.myshopifyDomain,
      planName: data.shop.plan.displayName,
      currencyCode: data.shop.currencyCode,
    };
  }
}

export function buildShopifyInstallUrl(input: {
  shopDomain: string;
  clientId: string;
  scopes: readonly string[];
  redirectUri: string;
  state: string;
}): string {
  const shop = normalizeShopDomain(input.shopDomain);
  const params = new URLSearchParams({
    client_id: input.clientId,
    scope: input.scopes.join(","),
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

/**
 * Verify the OAuth callback HMAC: hex HMAC-SHA256 over the sorted
 * `key=value` query string (hmac itself excluded), compared constant-time.
 * Missing or wrong HMAC refuses — the code is never exchanged on it.
 */
export function verifyShopifyCallbackHmac(query: Record<string, string | undefined>, clientSecret: string): boolean {
  const received = query.hmac;
  if (!received || !/^[0-9a-f]+$/i.test(received)) return false;
  const message = Object.entries(query)
    .filter(([key, value]) => key !== "hmac" && key !== "signature" && value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = createHmac("sha256", clientSecret).update(message).digest("hex");
  const a = Buffer.from(received.toLowerCase(), "utf8");
  const b = Buffer.from(expected.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Exchange an authorization code for a long-lived Admin API token. */
export async function exchangeShopifyToken(input: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  code: string;
  transport?: typeof fetch;
}): Promise<{ accessToken: string; scope: string }> {
  const shop = normalizeShopDomain(input.shopDomain);
  if (!input.code) {
    throw new Error("Shopify OAuth callback carries no code — start the connection again under Channels → Connect Shopify");
  }
  const res = await fetchWithConnectorRetry(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
      }),
    },
    { describe: "Shopify", transport: input.transport },
  );
  if (res.status !== 200) {
    throw new Error(
      `Shopify refused the OAuth code exchange (HTTP ${res.status}) — start the connection again under Channels → Connect Shopify`,
    );
  }
  const payload = (await res.json()) as { access_token?: unknown; scope?: unknown };
  if (typeof payload.access_token !== "string" || payload.access_token === "") {
    throw new Error("Shopify OAuth exchange answered without a token — start the connection again under Channels → Connect Shopify");
  }
  return { accessToken: payload.access_token, scope: typeof payload.scope === "string" ? payload.scope : "" };
}
