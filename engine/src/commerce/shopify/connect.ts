import { sql } from "drizzle-orm";
import {
  ShopifyClient,
  buildShopifyInstallUrl,
  exchangeShopifyToken,
  normalizeShopDomain,
  shopifyScopes,
  verifyShopifyCallbackHmac,
} from "../../connectors/shopify.ts";
import { upsertAccountMap } from "../account-maps.ts";
import { catalogMatchViaCounts, catalogQueueCounts, importShopifyCatalog } from "./catalog.ts";
import { listChannelLocations } from "../locations.ts";
import { loadShopifyChannel } from "./channel-access.ts";
import {
  createChannel,
  disconnectChannel,
  getChannel,
  markChannelActive,
  retryChannel,
  updateChannel,
} from "../channels.ts";
import { CommerceError } from "../errors.ts";
import { importShopifyLocations } from "./locations.ts";
import { ensureShopifySubscriptions, removeShopifySubscriptions } from "./subscriptions.ts";
import { orgFeatureEnabled } from "../../organization/org-feature-lock.ts";
import { isoDateOf } from "../../platform/civil-date.ts";
import { db, withOrgContext } from "../../platform/db.ts";
import { sealJson, unsealJson } from "../../platform/secrets.ts";

/**
 * Shopify connect: OAuth when the platform holds a Shopify app, otherwise
 * a custom-app Admin API token. Connecting registers the webhook
 * subscriptions, runs the first catalog and location import, and proposes
 * posting accounts — the operator reviews everything before syncing
 * starts. Nothing posts during connect.
 */

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";
export const SHOPIFY_OAUTH_COOKIE = "ob_shopify_oauth";
export const SHOPIFY_OAUTH_TTL_S = 10 * 60;

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new CommerceError(code, message, remedy, { field, status });
}

function shopifyAppCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = (process.env.SHOPIFY_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.SHOPIFY_CLIENT_SECRET ?? "").trim();
  if (clientId === "" || clientSecret === "") return null;
  return { clientId, clientSecret };
}

/** OAuth is available only when the platform holds a Shopify app; otherwise the token form is the only path. */
export function shopifyOAuthAvailable(): boolean {
  return shopifyAppCredentials() !== null;
}

export interface StartConnectInput {
  shop: string;
  mode: "oauth" | "token";
  accessToken?: string;
  webhookSecret?: string;
  pushCatalog?: boolean;
  /** Public web origin, for the OAuth redirect and webhook callback URLs. */
  webOrigin: string;
  transport?: typeof fetch;
}

export interface StartConnectResult {
  channelId: string;
  shop: string;
  mode: "oauth" | "token";
  /** OAuth only: open in a new tab to consent. */
  installUrl: string | null;
  /** OAuth only: sealed state for the callback plus the cookie nonce. */
  oauthState: string | null;
  oauthNonce: string | null;
}

export function mintShopifyOauthState(orgId: string, channelId: string): { state: string; nonce: string } {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
  const exp = Math.floor(Date.now() / 1000) + SHOPIFY_OAUTH_TTL_S;
  // Fixed seal scope (not the org): the state returns as an opaque query
  // param, so the org cannot be known before unsealing. The payload's own
  // orgId is validated after decryption, with the cookie nonce and expiry.
  return {
    state: sealJson({ orgId, channelId, nonce, exp }, { orgId: "system", purpose: "shopify.oauth.state" }),
    nonce,
  };
}

interface OauthState {
  orgId: string;
  channelId: string;
  nonce: string;
  exp: number;
}

function readShopifyOauthState(state: string): OauthState {
  let parsed: OauthState;
  try {
    parsed = unsealJson<OauthState>(state, { orgId: "system", purpose: "shopify.oauth.state" });
  } catch {
    refuse(
      "shopify_oauth_state_invalid",
      "The Shopify OAuth reply carries a state OpenBooks did not issue.",
      "Start the connection again under Channels → Connect Shopify.",
      "state",
    );
  }
  if (
    typeof parsed!.orgId !== "string" ||
    typeof parsed!.channelId !== "string" ||
    typeof parsed!.nonce !== "string" ||
    typeof parsed!.exp !== "number"
  ) {
    refuse(
      "shopify_oauth_state_invalid",
      "The Shopify OAuth reply carries a state OpenBooks did not issue.",
      "Start the connection again under Channels → Connect Shopify.",
      "state",
    );
  }
  if (parsed!.exp * 1000 < Date.now()) {
    refuse(
      "shopify_oauth_state_expired",
      "The Shopify OAuth reply arrived after its ten-minute window.",
      "Start the connection again under Channels → Connect Shopify.",
      "state",
    );
  }
  return parsed!;
}

function webhookCallbackUrl(webOrigin: string, channelId: string): string {
  return `${webOrigin.replace(/\/$/, "")}/api/channels/${channelId}/webhooks`;
}

function oauthCallbackUrl(webOrigin: string): string {
  return `${webOrigin.replace(/\/$/, "")}/api/channels/shopify/oauth/callback`;
}

/**
 * Begin connecting a shop. Token mode probes the token, registers
 * webhooks, imports, and leaves the channel connecting for review;
 * OAuth mode creates the draft channel and returns the install URL.
 */
export async function startShopifyConnect(
  orgId: string,
  actorId: string,
  input: StartConnectInput,
): Promise<StartConnectResult> {
  const shop = normalizeShopDomain(input.shop);
  const pushCatalog = input.pushCatalog ?? false;
  if (input.mode === "oauth" && !shopifyOAuthAvailable()) {
    refuse(
      "shopify_oauth_unavailable",
      "Shopify OAuth is not configured on this platform.",
      "Paste a custom-app Admin API access token and its client secret instead, or ask your administrator to configure the Shopify app.",
      "mode",
    );
  }
  const token = typeof input.accessToken === "string" ? input.accessToken.trim() : "";
  const appSecret = typeof input.webhookSecret === "string" ? input.webhookSecret.trim() : "";
  if (input.mode === "token" && token === "") {
    refuse(
      "shopify_token_missing",
      "A custom-app Admin API access token is required for token connect.",
      "Create a custom app in Shopify admin Apps → Develop apps, install it, and paste its Admin API access token.",
      "accessToken",
    );
  }
  if (input.mode === "token" && appSecret === "") {
    refuse(
      "shopify_webhook_secret_missing",
      "The custom app's client secret is required so webhook deliveries verify.",
      "Paste the client secret from the custom app's Configuration page alongside the token.",
      "webhookSecret",
    );
  }
  // No transaction spans the connect: each step below (create, subscribe,
  // import) runs its own short unit with its own feature recheck, so the
  // Shopify calls between them never hold a connection open.
  if (!(await orgFeatureEnabled(orgId, "salesChannels"))) {
    refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
  }
  {
    if (input.mode === "oauth") {
      const app = shopifyAppCredentials()!;
      const { channel } = await createChannel(orgId, actorId, {
        kind: "shopify",
        name: shop,
        currency: "XXX",
        externalAccount: shop,
        secrets: null,
        webhookSecret: app.clientSecret,
        settings: { pushCatalog },
      });
      const { state, nonce } = mintShopifyOauthState(orgId, channel.id);
      return {
        channelId: channel.id,
        shop,
        mode: "oauth" as const,
        installUrl: buildShopifyInstallUrl({
          shopDomain: shop,
          clientId: app.clientId,
          scopes: shopifyScopes(pushCatalog),
          redirectUri: oauthCallbackUrl(input.webOrigin),
          state,
        }),
        oauthState: state,
        oauthNonce: nonce,
      };
    }
    const probe = new ShopifyClient({ shopDomain: shop, accessToken: token, transport: input.transport });
    const identity = await probe.shopIdentity().catch((error: unknown) => {
      throw error instanceof CommerceError
        ? error
        : new CommerceError(
            "shopify_token_refused",
            "Shopify refused the access token.",
            "Check the token is installed for this shop and has the required scopes, then try again.",
            { field: "accessToken" },
          );
    });
    if (identity.myshopifyDomain.toLowerCase() !== shop) {
      refuse(
        "shopify_token_shop_mismatch",
        `The token belongs to ${identity.myshopifyDomain}, not ${shop}.`,
        "Paste the token installed for this shop.",
        "accessToken",
      );
    }
    const { channel } = await createChannel(orgId, actorId, {
      kind: "shopify",
      name: identity.name || shop,
      currency: identity.currencyCode,
      externalAccount: shop,
      secrets: { accessToken: token, mode: "token" },
      webhookSecret: appSecret,
      settings: { pushCatalog },
    });
    await finishShopifyConnect(orgId, actorId, channel.id, token, webhookCallbackUrl(input.webOrigin, channel.id), input.transport);
    return { channelId: channel.id, shop, mode: "token" as const, installUrl: null, oauthState: null, oauthNonce: null };
  }
}

/**
 * Finish a connection once its token is sealed: verify, subscribe,
 * import, and move to connecting for operator review. Shared by the
 * token path and the OAuth callback.
 */
async function finishShopifyConnect(
  orgId: string,
  actorId: string,
  channelId: string,
  accessToken: string,
  callbackUrl: string,
  transport?: typeof fetch,
): Promise<void> {
  const channel = await loadShopifyChannel(orgId, channelId);
  const client = new ShopifyClient({ shopDomain: channel.shop, accessToken, transport, apiVersion: channel.settings.apiVersion });
  const shop = await client.shopIdentity();
  if (shop.myshopifyDomain.toLowerCase() !== channel.shop.toLowerCase()) {
    refuse(
      "shopify_token_shop_mismatch",
      `The token belongs to ${shop.myshopifyDomain}, not ${channel.shop}.`,
      "Reconnect the channel for the right shop under Channels.",
      "channelId",
    );
  }
  await ensureShopifySubscriptions(client, callbackUrl);
  await importShopifyCatalog(orgId, actorId, channelId, { transport });
  await importShopifyLocations(orgId, actorId, channelId, { transport });
  if ((await getChannel(orgId, channelId)).status === "draft") {
    await retryChannel(orgId, actorId, channelId, "Connection verified; ready for review");
  }
}

export interface OAuthCallbackInput {
  query: Record<string, string | undefined>;
  cookieNonce: string | null;
  actorId: string;
  webOrigin: string;
  transport?: typeof fetch;
}

/**
 * Handle the Shopify OAuth callback: HMAC, state, nonce and actor are all
 * rechecked after the round-trip before the token is stored. Returns the
 * channel ready for review.
 */
export async function completeShopifyOAuth(
  orgId: string,
  input: OAuthCallbackInput,
): Promise<{ channelId: string }> {
  const app = shopifyAppCredentials();
  if (!app) {
    refuse(
      "shopify_oauth_unavailable",
      "Shopify OAuth is not configured on this platform.",
      "Paste a custom-app Admin API access token instead, or ask your administrator to configure the Shopify app.",
      "mode",
    );
  }
  const stateParam = input.query.state;
  if (!stateParam) {
    refuse(
      "shopify_oauth_state_missing",
      "The Shopify OAuth reply carries no state.",
      "Start the connection again under Channels → Connect Shopify.",
      "state",
    );
  }
  const state = readShopifyOauthState(stateParam);
  if (state.orgId !== orgId) {
    refuse(
      "shopify_oauth_org_mismatch",
      "The Shopify OAuth reply belongs to another organization.",
      "Start the connection again under Channels → Connect Shopify.",
      "state",
    );
  }
  if (!input.cookieNonce || input.cookieNonce !== state.nonce) {
    refuse(
      "shopify_oauth_nonce_mismatch",
      "The Shopify OAuth reply does not match this browser session.",
      "Start the connection again in the same browser window.",
      "state",
    );
  }
  const callbackQuery: Record<string, string | undefined> = { ...input.query };
  delete callbackQuery.state;
  if (!verifyShopifyCallbackHmac(callbackQuery, app!.clientSecret)) {
    refuse(
      "shopify_oauth_hmac_invalid",
      "The Shopify OAuth reply signature does not verify.",
      "Start the connection again under Channels → Connect Shopify.",
      "hmac",
    );
  }
  const shop = normalizeShopDomain(input.query.shop ?? "");
  const channel = await loadShopifyChannel(orgId, state.channelId);
  if (channel.shop !== shop) {
    refuse(
      "shopify_token_shop_mismatch",
      `Shopify authorized ${shop}, but this connection started for ${channel.shop}.`,
      "Start the connection again for the right shop.",
      "shop",
    );
  }
  const code = input.query.code;
  if (!code) {
    refuse(
      "shopify_oauth_code_missing",
      "Shopify approved the app but returned no authorization code.",
      "Start the connection again under Channels → Connect Shopify.",
      "code",
    );
  }
  const { accessToken } = await exchangeShopifyToken({
    shopDomain: shop,
    clientId: app!.clientId,
    clientSecret: app!.clientSecret,
    code,
    transport: input.transport,
  });
  // Each step below runs its own short unit; the Shopify calls between
  // them never hold a transaction open.
  const probe = new ShopifyClient({ shopDomain: shop, accessToken, transport: input.transport });
  const identity = await probe.shopIdentity();
  await updateChannel(orgId, input.actorId, state.channelId, {
    currency: identity.currencyCode,
    secrets: { accessToken, mode: "oauth" },
  });
  await finishShopifyConnect(
    orgId,
    input.actorId,
    state.channelId,
    accessToken,
    webhookCallbackUrl(input.webOrigin, state.channelId),
    input.transport,
  );
  return { channelId: state.channelId };
}

export interface AccountProposal {
  role: string;
  key: string;
  accountId: string | null;
  accountName: string | null;
  confidence: "high" | "medium" | "unmapped";
  note: string;
}

type PostableAccount = {
  id: string;
  name: string;
  type: string;
  currencyRestriction: string | null;
  subsidiaryId: string | null;
};

async function postableAccounts(orgId: string): Promise<PostableAccount[]> {
  return (
    await withOrgContext(orgId, () =>
      db.execute<PostableAccount>(sql`
        select id, name, type, currency_restriction as "currencyRestriction", subsidiary_id as "subsidiaryId"
          from accounts
         where org_id = ${orgId} and is_active and not is_summary`),
    )
  ).rows;
}

function compatible(account: PostableAccount, currency: string, subsidiaryId: string | null): boolean {
  if (account.currencyRestriction && account.currencyRestriction.toUpperCase() !== currency.toUpperCase()) return false;
  if (subsidiaryId && account.subsidiaryId && account.subsidiaryId !== subsidiaryId) return false;
  return true;
}

function nameHit(account: PostableAccount, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(account.name));
}

/**
 * Propose a complete posting configuration from the chart of accounts:
 * reconcilable bank and clearing accounts per gateway, income and
 * liability accounts by name, nothing invented. Every row the heuristics
 * cannot place returns unmapped for the operator instead of a guess.
 */
export async function proposeShopifyAccountMaps(orgId: string, channelId: string): Promise<AccountProposal[]> {
  const channel = await loadShopifyChannel(orgId, channelId);
  const subsidiary = (
    await withOrgContext(orgId, () =>
      db.execute<{ subsidiary_id: string | null }>(sql`
        select subsidiary_id from sales_channels where org_id = ${orgId} and id = ${channelId}`),
    )
  ).rows[0];
  const subsidiaryId = subsidiary?.subsidiary_id ?? null;
  const accounts = (await postableAccounts(orgId)).filter((account) => compatible(account, channel.currency, subsidiaryId));
  const proposals: AccountProposal[] = [];
  const pick = (predicates: ((account: PostableAccount) => boolean)[], note: string): PostableAccount | null => {
    for (const predicate of predicates) {
      const hit = accounts.find(predicate);
      if (hit) return hit;
    }
    void note;
    return null;
  };
  const clearingFor = (gateway: string, tokens: RegExp[]): AccountProposal => {
    const hit = pick(
      [
        (account) => account.type === "asset_bank" && nameHit(account, tokens),
        (account) => nameHit(account, [/clearing/]) && nameHit(account, tokens),
        (account) => account.type === "asset_bank",
      ],
      gateway,
    );
    return {
      role: "gateway_clearing",
      key: gateway,
      accountId: hit?.id ?? null,
      accountName: hit?.name ?? null,
      confidence: hit ? (nameHit(hit, tokens) ? "high" : "medium") : "unmapped",
      note: hit ? `Clears ${gateway} tenders to the bank.` : `No clearing account found for ${gateway}; choose where its tenders clear.`,
    };
  };
  proposals.push(clearingFor("shopify_payments", [/shopify/i]));
  proposals.push(clearingFor("paypal", [/paypal/i]));
  proposals.push(clearingFor("manual", [/manual|cash|till/i]));
  const single = (
    role: string,
    types: string[],
    patterns: RegExp[],
    note: string,
  ): AccountProposal => {
    const hit = pick(
      [(account) => types.includes(account.type) && nameHit(account, patterns), (account) => nameHit(account, patterns)],
      role,
    );
    return {
      role,
      key: "",
      accountId: hit?.id ?? null,
      accountName: hit?.name ?? null,
      confidence: hit ? (types.includes(hit.type) && nameHit(hit, patterns) ? "high" : "medium") : "unmapped",
      note: hit ? note : `No account found for ${role}; choose one before posting.`,
    };
  };
  proposals.push(single("revenue", ["income", "income_other"], [/sales|revenue|merchandise|product sales/i], "Credits order revenue."));
  proposals.push(single("discount", ["income", "income_other", "expense", "expense_other"], [/discount/i], "Books promotion discounts."));
  proposals.push(
    single("shipping_income", ["income", "income_other"], [/shipping|delivery|freight/i], "Credits collected shipping."),
  );
  proposals.push(
    single(
      "gift_card_liability",
      ["liability_payable", "liability_current_other", "liability_long_term"],
      [/gift/i],
      "Owes gift card balances to customers.",
    ),
  );
  proposals.push(
    single(
      "sales_tax_liability",
      ["liability_payable", "liability_current_other", "liability_long_term"],
      [/sales tax|vat|gst|hst|tax payable/i],
      "Owes collected sales tax to the authority.",
    ),
  );
  proposals.push(single("rounding", ["expense", "expense_other"], [/round/i], "Absorbs tender rounding differences."));
  proposals.push(
    single("refund_clearing", ["asset_bank", "asset_current_other"], [/refund|clearing/i], "Clears refunds back to tenders."),
  );
  return proposals;
}

export interface AcceptReviewInput {
  accountMaps: { role: string; key?: string; accountId: string }[];
  effectiveFrom?: string;
}

/**
 * Accept the connect review: store the operator's posting accounts and
 * activate the channel. Unmapped roles stay unmapped — posting refuses
 * by name until they are set, so accepting early never mis-posts.
 */
export async function acceptShopifyReview(
  orgId: string,
  actorId: string,
  channelId: string,
  input: AcceptReviewInput,
): Promise<{ channelId: string; maps: number }> {
  const channel = await loadShopifyChannel(orgId, channelId);
  const subsidiary = (
    await withOrgContext(orgId, () =>
      db.execute<{ subsidiary_id: string | null }>(sql`
        select subsidiary_id from sales_channels where org_id = ${orgId} and id = ${channelId}`),
    )
  ).rows[0];
  const accounts = await postableAccounts(orgId);
  const effectiveFrom = input.effectiveFrom ?? isoDateOf(new Date());
  let maps = 0;
  for (const map of input.accountMaps) {
    const account = accounts.find((entry) => entry.id === map.accountId);
    if (!account || !compatible(account, channel.currency, subsidiary?.subsidiary_id ?? null)) {
      refuse(
        "channel_map_account_unavailable",
        `Account ${map.accountId} cannot post for this channel (inactive, summary, or restricted).`,
        "Choose an active posting account in this organization.",
        "accountId",
      );
    }
    await upsertAccountMap(orgId, actorId, {
      channelId,
      role: map.role,
      key: map.key ?? "",
      accountId: map.accountId,
      effectiveFrom,
    });
    maps += 1;
  }
  await markChannelActive(orgId, actorId, channelId);
  return { channelId, maps };
}

export interface ReviewPayload {
  channel: { id: string; name: string; shop: string; status: string; currency: string };
  counts: { queued: number; matched: number; ignored: number };
  via: { bySku: number; byBarcode: number };
  locations: { total: number; mapped: number };
  proposals: AccountProposal[];
  oauthAvailable: boolean;
}

/** Everything the review screen shows: match counts, locations, and the proposed posting configuration. */
export async function shopifyReview(orgId: string, channelId: string): Promise<ReviewPayload> {
  const channel = await loadShopifyChannel(orgId, channelId);
  const [counts, via, locations] = await Promise.all([
    catalogQueueCounts(orgId, channelId),
    catalogMatchViaCounts(orgId, channelId),
    listChannelLocations(orgId, channelId),
  ]);
  return {
    channel: { id: channel.channelId, name: channel.name, shop: channel.shop, status: channel.status, currency: channel.currency },
    counts,
    via,
    locations: { total: locations.length, mapped: locations.filter((entry) => entry.stockLocationId).length },
    proposals: await proposeShopifyAccountMaps(orgId, channelId),
    oauthAvailable: shopifyOAuthAvailable(),
  };
}

/**
 * Disconnect a Shopify channel: remove its webhook subscriptions first,
 * then run the lifecycle disconnect. Subscription removal that fails
 * warns instead of blocking — the operator removes the remainder in
 * Shopify admin — because the channel must never stay active while its
 * app is gone.
 */
export async function disconnectShopify(
  orgId: string,
  actorId: string,
  channelId: string,
  reason: unknown,
  options: { transport?: typeof fetch } = {},
): Promise<{ channelId: string; webhookWarning: string | null }> {
  const channel = await loadShopifyChannel(orgId, channelId);
  let webhookWarning: string | null = null;
  try {
    const client = new ShopifyClient({ shopDomain: channel.shop, accessToken: channel.accessToken, transport: options.transport, apiVersion: channel.settings.apiVersion });
    const origin = process.env.OPENBOOKS_APP_URL ?? "";
    if (origin !== "") await removeShopifySubscriptions(client, webhookCallbackUrl(origin, channelId));
  } catch (error) {
    webhookWarning =
      error instanceof Error
        ? `Shopify webhook subscriptions may remain: ${error.message} Remove them in Shopify admin Settings → Notifications.`
        : "Shopify webhook subscriptions may remain. Remove them in Shopify admin Settings → Notifications.";
  }
  const why = typeof reason === "string" && reason.trim() !== "" ? reason.trim() : "Disconnected by the operator";
  await disconnectChannel(orgId, actorId, channelId, why);
  return { channelId, webhookWarning };
}
