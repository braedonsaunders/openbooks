/** Storefront channels, channel orders and catalog mapping for the web layer. */
export { CommerceError } from "./errors.ts";
export {
  createChannel,
  disconnectChannel,
  getChannel,
  listChannels,
  pauseChannel,
  resumeChannel,
  retryChannel,
  updateChannel,
} from "./channels.ts";
export {
  channelAttention,
  listInboundEvents,
  receiveInboundEvent,
  replayEvent,
} from "./inbound.ts";
export {
  channelAdapter,
  registeredChannelKinds,
  workspaceTabsFor,
} from "./adapters.ts";
export { CHANNEL_ACCOUNT_ROLES } from "./contracts.ts";
export {
  linkExternal,
  listExternalLinks,
  listLinksByNative,
  unlinkExternal,
} from "./external-links.ts";
export { listAccountMaps, upsertAccountMap } from "./account-maps.ts";
export {
  approveExceptionSuggestion,
  approvePayoutSuggestion,
  exceptionGroupKey,
  normalizeExceptionSku,
  rejectExceptionSuggestion,
  similarExceptionOrderIds,
  similarPayoutLineIds,
  skuMatchScore,
  suggestExceptionFix,
  suggestPayoutLineFix,
  titleMatchScore,
  type PayoutLineSuggestion,
} from "./exception-assistance.ts";
export {
  listChannelLocations,
  unlinkChannelLocation,
  upsertChannelLocation,
} from "./locations.ts";
export {
  listDueSyncPairs,
  listInventoryConflicts,
  listItemChannelStock,
  listItemInventoryPolicies,
  listLocationSyncStates,
  listSyncPairs,
  pushInventoryPair,
  resolveAllInventoryConflicts,
  resolveInventoryConflict,
  runCommerceChannelSyncScan,
  upsertItemInventoryPolicy,
  type InventoryConflictRow,
  type ItemChannelStockRow,
  type ItemPolicyRow,
  type LocationSyncState,
  type SyncPair,
} from "./inventory-sync.ts";
export {
  acceptShopifyReview,
  completeShopifyOAuth,
  disconnectShopify,
  proposeShopifyAccountMaps,
  shopifyReview,
  SHOPIFY_OAUTH_COOKIE,
  startShopifyConnect,
} from "./shopify/connect.ts";
export {
  bulkDecideCatalogMatches,
  catalogQueueCounts,
  decideCatalogMatch,
  importShopifyCatalog,
  listCatalogQueue,
  pushItemToShopify,
  similarCatalogEntries,
} from "./shopify/catalog.ts";
export {
  matchPayoutLines,
  type PayoutLineMatch,
  type PayoutMatchResult,
} from "./payout-reconciliation.ts";
export { SHOPIFY_WEBHOOK_TOPICS } from "./shopify/subscriptions.ts";
export { loadShopifyChannel, type ShopifyChannelAccess } from "./shopify/channel-access.ts";
export { importShopifyLocations } from "./shopify/locations.ts";
export { ensureShopifyAdapterRegistered } from "./shopify/adapter.ts";
export { loadChannelOrder, listChannelOrderEvents } from "./orders.ts";
export { reviveFulfilmentPayload } from "./fulfilments.ts";
export { reviveRefundPayload } from "./refunds.ts";
export { getPostingPolicy, listPostingPolicies, setPostingPolicy } from "./posting-policies.ts";
export type { ChannelPostingPolicy } from "./posting-policies.ts";
export { replayChannelExceptions, replayChannelEventExceptions } from "./exceptions.ts";
export { postChannelOrder } from "./order-posting.ts";
export {
  decimalToMinorUnits,
  getChannelMarginSummary,
  getOrderEconomics,
  minorUnitsForCurrency,
  recomputeOrderEconomics,
  recordChannelAdSpend,
} from "./economics.ts";
export type { ChannelMarginSummary, EconomicsFact, OrderEconomics } from "./economics.ts";
