import "server-only";
import { z } from "zod";
import {
  CHANNEL_ACCOUNT_ROLES,
  acceptShopifyReview,
  approveExceptionSuggestion,
  bulkDecideCatalogMatches,
  catalogQueueCounts,
  channelAdapter,
  channelAttention,
  createChannel,
  decideCatalogMatch,
  decimalToMinorUnits,
  disconnectChannel,
  disconnectShopify,
  ensureShopifyAdapterRegistered,
  getChannel,
  importShopifyCatalog,
  importShopifyLocations,
  linkExternal,
  listAccountMaps,
  listCatalogQueue,
  listChannelLocations,
  listChannelOrderEvents,
  listChannelExceptions,
  listChannelEventExceptions,
  listInboundEvents,
  listInventoryConflicts,
  listItemInventoryPolicies,
  listLocationSyncStates,
  listSyncPairs,
  listExternalLinks,
  loadShopifyChannel,
  minorUnitsForCurrency,
  pauseChannel,
  postChannelOrder,
  proposeShopifyAccountMaps,
  pushInventoryPair,
  pushItemToShopify,
  recomputeOrderEconomics,
  recordChannelAdSpend,
  rejectExceptionSuggestion,
  replayChannelEventExceptions,
  replayChannelExceptions,
  replayEvent,
  resolveAllInventoryConflicts,
  resolveInventoryConflict,
  resumeChannel,
  retryChannel,
  setPostingPolicy,
  shopifyReview,
  suggestExceptionFix,
  startShopifyConnect,
  unlinkChannelLocation,
  unlinkExternal,
  updateChannel,
  upsertAccountMap,
  upsertChannelLocation,
  upsertItemInventoryPolicy,
  listChannels,
  registeredChannelKinds,
  SHOPIFY_WEBHOOK_TOPICS,
} from "@openbooks/engine/commerce";
import { appBaseUrl } from "@openbooks/engine/flows";
import { can } from "@/lib/authz";
import { readEntityListPage } from "@/lib/list/entity-reader";
import { loadChannelOrderDrawer } from "@/app/(app)/channels/order-detail";
import {
  channelAccountsRefusal,
  channelAssignmentRefusal,
  channelsInScope,
  guardChannelOrderScope,
  guardChannelScope,
} from "@/lib/channel-scope";
import { ApplicationError } from "./errors";
import {
  DATE,
  IDEMPOTENCY_KEY,
  mutationTool,
  readTool,
  requireUnrestrictedScope,
  UUID,
} from "./subscription-tools-shared";
import type { ApplicationContext } from "./context";
import type { ApplicationToolDefinition } from "./tool-definition";

const roles = z.enum(CHANNEL_ACCOUNT_ROLES).describe("Accounting role being mapped.");
const accountMap = z.object({
  role: roles,
  key: z
    .string()
    .max(120)
    .optional()
    .describe("Optional key for a role that has multiple mappings."),
  accountId: UUID,
});

async function routeRefusal(response: Response | null, resource: string): Promise<void> {
  if (!response) return;
  const status = response.status;
  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    remedy?: unknown;
    field?: unknown;
  };
  const message = typeof body.error === "string" ? body.error : `${resource} not found`;
  const details: Record<string, unknown> = {};
  if (typeof body.remedy === "string") details.remedy = body.remedy;
  if (typeof body.field === "string") details.field = body.field;
  if (status === 404) throw new ApplicationError("not_found", message, 404, details);
  if (status === 403) throw new ApplicationError("forbidden", message, 403, details);
  throw new ApplicationError("invalid_input", message, status, details);
}

async function assertChannel(context: ApplicationContext, channelId: string): Promise<void> {
  await routeRefusal(await guardChannelScope(context.authz, channelId), "channel");
}

async function assertChannelOrder(context: ApplicationContext, orderId: string): Promise<void> {
  await routeRefusal(await guardChannelOrderScope(context.authz, orderId), "record");
}

async function assertChannelAssignment(
  context: ApplicationContext,
  subsidiaryId: string | null | undefined,
) {
  await routeRefusal(channelAssignmentRefusal(context.authz, subsidiaryId), "subsidiary");
}

async function assertAccounts(context: ApplicationContext, accountIds: readonly string[]) {
  await routeRefusal(await channelAccountsRefusal(context.authz, accountIds), "account");
}

function entityRead(result: Awaited<ReturnType<typeof readEntityListPage>>) {
  if (!result.ok) {
    const status =
      result.error === "forbidden"
        ? 403
        : result.error === "feature_disabled" || result.error === "unknown_record_type"
          ? 404
          : result.error === "stale_scope"
            ? 409
            : 422;
    const code =
      status === 403
        ? "forbidden"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : "invalid_input";
    throw new ApplicationError(code, result.error, status, {
      remedy: result.remedy,
      ...(result.field ? { field: result.field } : {}),
    });
  }
  return result;
}

export const SUBSCRIPTION_CHANNEL_TOOLS: ApplicationToolDefinition[] = [
  readTool({
    name: "list_sales_channels",
    title: "List Sales Channels",
    description:
      "List configured sales channels visible to this user, including connector kind and current activity counts. Use channel ids with channel configuration and sync commands.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({}),
    execute: async (context) => {
      const channels = channelsInScope(context.authz, await listChannels(context.authz.user.orgId));
      const allAttention = await channelAttention(context.authz.user.orgId);
      const attention = Object.fromEntries(
        channels.map((channel) => [
          channel.id,
          allAttention[channel.id] ?? { failed: 0, dead: 0, lastReceivedAt: null },
        ]),
      );
      return { ok: true, channels, kinds: registeredChannelKinds(), attention, href: "/channels" };
    },
  }),
  readTool({
    name: "get_sales_channel",
    title: "Get Sales Channel",
    description:
      "Read channel settings and Shopify catalog queue counts before changing its configuration. Find the channel id with list_sales_channels.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({ channelId: UUID }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const channel = await getChannel(context.authz.user.orgId, input.channelId);
      return {
        ok: true,
        channel,
        counts:
          channel.kind === "shopify"
            ? await catalogQueueCounts(context.authz.user.orgId, channel.id)
            : null,
        webhookTopics: channel.kind === "shopify" ? [...SHOPIFY_WEBHOOK_TOPICS] : [],
        href: `/channels/${channel.id}`,
      };
    },
  }),
  readTool({
    name: "list_channel_orders",
    title: "List Channel Orders",
    description:
      "List imported storefront orders and their posting state so an agent can find ids for event reads, economics recomputation and replay. Use list_channel_exceptions for the exception reason and remedy.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({
      search: z
        .string()
        .max(200)
        .optional()
        .describe("Optional search across order number and customer."),
      sort: z
        .enum(["number", "channel", "ordered", "total", "status"])
        .optional()
        .describe("Order list sort field."),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction."),
      page: z.number().int().min(1).max(10000).optional().describe("One-based result page."),
      perPage: z.number().int().min(5).max(100).optional().describe("Rows per page."),
    }),
    execute: async (context, input) => ({
      ...entityRead(
        await readEntityListPage({
          recordType: "channel_order",
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          q: input.search,
          sort: input.sort,
          dir: input.direction,
          page: input.page,
          perPage: input.perPage,
        }),
      ),
      href: "/channels/orders",
    }),
  }),
  readTool({
    name: "get_channel_order",
    title: "Get Channel Order",
    description:
      "Read one imported order, its normalized lines, posting document and event timeline. Find the order id with list_channel_orders or list_channel_exceptions.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({ orderId: UUID }),
    execute: async (context, input) => {
      await assertChannelOrder(context, input.orderId);
      const order = await loadChannelOrderDrawer(
        context.authz.user.orgId,
        input.orderId,
        can(context.authz, "channels.manage"),
      );
      if (!order) throw new ApplicationError("not_found", "channel order not found", 404);
      return { ok: true, order, href: `/channels/orders?order=${input.orderId}` };
    },
  }),
  mutationTool({
    name: "create_sales_channel",
    title: "Create Sales Channel",
    description:
      "Create a channel configuration for a supported connector. Use list_sales_channels to inspect existing channels; restricted users must assign it to an accessible subsidiary.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      kind: z.string().trim().min(1).max(80).describe("Connector kind from list_sales_channels."),
      name: z.string().trim().min(1).max(200).describe("Operator-facing channel name."),
      subsidiaryId: UUID.nullable()
        .optional()
        .describe("Subsidiary that owns the channel's accounting activity."),
      currency: z
        .string()
        .trim()
        .regex(/^[A-Z]{3}$/)
        .describe("Uppercase ISO 4217 channel currency."),
      externalAccount: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Provider account or shop identifier."),
      secrets: z
        .record(z.string(), z.json())
        .nullable()
        .optional()
        .describe("Provider credentials or secret configuration."),
      webhookSecret: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .nullable()
        .optional()
        .describe("Optional secret for signed inbound webhooks."),
      settings: z
        .record(z.string(), z.json())
        .nullable()
        .optional()
        .describe("Connector-specific JSON settings."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannelAssignment(context, input.subsidiaryId);
      const { idempotencyKey: _key, ...body } = input;
      const result = await createChannel(context.authz.user.orgId, context.authz.user.id, {
        kind: body.kind,
        name: body.name,
        subsidiaryId: body.subsidiaryId ?? null,
        currency: body.currency,
        externalAccount: body.externalAccount,
        secrets: body.secrets ?? null,
        webhookSecret: body.webhookSecret ?? null,
        settings: body.settings ?? {},
      });
      return {
        ok: true,
        ...result,
        status: result.channel.status,
        href: `/channels/${result.channel.id}`,
      };
    },
  }),
  mutationTool({
    name: "connect_shopify_store",
    title: "Connect Shopify Store",
    description:
      "Connect a Shopify store using an access token or begin its OAuth authorization flow. This contacts Shopify; the channel must be configured by an unrestricted channel manager.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    openWorld: true,
    inputSchema: z.object({
      shop: z.string().trim().min(1).max(255).describe("Shopify shop domain."),
      mode: z
        .enum(["oauth", "token"])
        .describe("Use OAuth authorization or a supplied access token."),
      accessToken: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .nullable()
        .optional()
        .describe("Shopify access token for token mode."),
      webhookSecret: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .nullable()
        .optional()
        .describe("Optional webhook signing secret."),
      pushCatalog: z.boolean().optional().describe("Whether matched catalog items may be pushed."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const result = await startShopifyConnect(context.authz.user.orgId, context.authz.user.id, {
        shop: input.shop,
        mode: input.mode,
        accessToken: input.accessToken ?? undefined,
        webhookSecret: input.webhookSecret ?? undefined,
        pushCatalog: input.pushCatalog,
        webOrigin: appBaseUrl(),
      });
      if (result.mode === "token") {
        return {
          ok: true,
          ...result,
          review: await shopifyReview(context.authz.user.orgId, result.channelId),
          href: `/channels/${result.channelId}`,
        };
      }
      return { ok: true, ...result, href: `/channels/${result.channelId}` };
    },
  }),
  mutationTool({
    name: "update_sales_channel",
    title: "Update Sales Channel",
    description:
      "Update the channel name, subsidiary, currency, secrets, webhook secret or connector settings. Find the channel id with list_sales_channels.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z
      .object({
        channelId: UUID,
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Operator-facing channel name."),
        subsidiaryId: UUID.nullable().optional().describe("New owning subsidiary."),
        currency: z
          .string()
          .trim()
          .regex(/^[A-Z]{3}$/)
          .optional()
          .describe("Uppercase ISO 4217 channel currency."),
        secrets: z
          .record(z.string(), z.json())
          .nullable()
          .optional()
          .describe("Provider credential changes."),
        webhookSecret: z
          .string()
          .trim()
          .min(1)
          .max(4096)
          .nullable()
          .optional()
          .describe("New inbound signing secret."),
        settings: z
          .record(z.string(), z.json())
          .optional()
          .describe("Connector-specific setting changes."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (body) =>
          Object.entries(body).some(
            ([key, value]) =>
              key !== "channelId" && key !== "idempotencyKey" && value !== undefined,
          ),
        "Provide at least one channel setting to update.",
      ),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      if (input.subsidiaryId !== undefined)
        await assertChannelAssignment(context, input.subsidiaryId);
      const channel = await updateChannel(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
        {
          name: input.name,
          subsidiaryId: input.subsidiaryId,
          currency: input.currency,
          secrets: input.secrets ?? undefined,
          webhookSecret: input.webhookSecret ?? undefined,
          settings: input.settings,
        },
      );
      return { ok: true, channel, status: channel.status, href: `/channels/${channel.id}` };
    },
  }),
  mutationTool({
    name: "pause_sales_channel",
    title: "Pause Sales Channel",
    description:
      "Pause inbound and scheduled processing for a channel with an audit reason. Find the channel id with list_sales_channels.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      reason: z.string().trim().min(1).max(1000).describe("Reason for pausing this connector."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const channel = await pauseChannel(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
        input.reason,
      );
      return { ok: true, channel, status: channel.status, href: `/channels/${channel.id}` };
    },
  }),
  mutationTool({
    name: "resume_sales_channel",
    title: "Resume Sales Channel",
    description:
      "Resume a paused channel after its connection and posting configuration are ready. Find the channel id with list_sales_channels.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      reason: z.string().trim().min(1).max(1000).describe("Reason for resuming this connector."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const channel = await resumeChannel(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
        input.reason,
      );
      return { ok: true, channel, status: channel.status, href: `/channels/${channel.id}` };
    },
  }),
  mutationTool({
    name: "disconnect_sales_channel",
    title: "Disconnect Sales Channel",
    description:
      "Disconnect a channel and stop future synchronization; Shopify disconnection also removes storefront webhook subscriptions. Find the channel id with list_sales_channels.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    destructive: true,
    openWorld: true,
    inputSchema: z.object({
      channelId: UUID,
      reason: z.string().trim().min(1).max(1000).describe("Reason for disconnecting the channel."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const orgId = context.authz.user.orgId;
      const channelBefore = await getChannel(orgId, input.channelId);
      const result =
        channelBefore.kind === "shopify"
          ? await disconnectShopify(orgId, context.authz.user.id, input.channelId, input.reason)
          : await disconnectChannel(orgId, context.authz.user.id, input.channelId, input.reason);
      const channel = await getChannel(orgId, input.channelId);
      return {
        ok: true,
        ...result,
        channel,
        status: channel.status,
        href: `/channels/${channel.id}`,
      };
    },
  }),
  mutationTool({
    name: "retry_sales_channel",
    title: "Retry Sales Channel",
    description:
      "Retry a failed channel connection or scheduled synchronization after correcting its configuration. Find the channel id with list_sales_channels.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      reason: z.string().trim().min(1).max(1000).describe("Reason for retrying the channel."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const channel = await retryChannel(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
        input.reason,
      );
      return { ok: true, channel, status: channel.status, href: `/channels/${channel.id}` };
    },
  }),
  readTool({
    name: "test_sales_channel_connection",
    title: "Test Sales Channel Connection",
    description:
      "Test Shopify credentials and store access without changing channel state. Find the channel id with list_sales_channels; this calls Shopify.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    openWorld: true,
    inputSchema: z.object({ channelId: UUID }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      ensureShopifyAdapterRegistered();
      const adapter = channelAdapter("shopify");
      return {
        ...(await adapter.testConnection(
          { orgId: context.authz.user.orgId, actorId: context.authz.user.id },
          input.channelId,
        )),
        href: `/channels/${input.channelId}`,
      };
    },
  }),
  readTool({
    name: "list_shopify_account_map_suggestions",
    title: "List Shopify Account Map Suggestions",
    description:
      "Read proposed Shopify account mappings and current effective mappings before accepting a channel review. Find the channel id with list_sales_channels.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({ channelId: UUID }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const [maps, proposals] = await Promise.all([
        listAccountMaps(context.authz.user.orgId, input.channelId),
        proposeShopifyAccountMaps(context.authz.user.orgId, input.channelId),
      ]);
      return { ok: true, maps, proposals, href: `/channels/${input.channelId}` };
    },
  }),
  mutationTool({
    name: "save_sales_channel_account_map",
    title: "Save Sales Channel Account Map",
    description:
      "Set an effective-dated channel posting account for one accounting role. Find channel and account ids with list_sales_channels and accounting reads.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      role: roles,
      key: z
        .string()
        .max(120)
        .optional()
        .describe("Optional key for a role with multiple mappings."),
      accountId: UUID,
      effectiveFrom: DATE,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      await assertAccounts(context, [input.accountId]);
      const map = await upsertAccountMap(context.authz.user.orgId, context.authz.user.id, {
        channelId: input.channelId,
        role: input.role,
        key: input.key ?? "",
        accountId: input.accountId,
        effectiveFrom: input.effectiveFrom,
      });
      return { ok: true, map, href: `/channels/${input.channelId}` };
    },
  }),
  mutationTool({
    name: "record_channel_ad_spend",
    title: "Record Channel Ad Spend",
    description:
      "Record a channel's marketing spend for a business date and source; reimporting the same source restates that date. Find channel ids with list_sales_channels.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      spendDate: DATE,
      amountMajor: z
        .string()
        .regex(/^\d+(\.\d{1,4})?$/)
        .describe("Exact decimal amount in major currency units."),
      currency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .describe("Three-letter ISO currency code."),
      source: z
        .string()
        .trim()
        .max(120)
        .nullable()
        .optional()
        .describe("Provider or import source; defaults to manual."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const currency = input.currency.trim().toUpperCase();
      const minorUnits = await minorUnitsForCurrency(currency);
      const amountMinor = decimalToMinorUnits(input.amountMajor, minorUnits);
      const { spendId } = await recordChannelAdSpend(
        context.authz.user.orgId,
        context.authz.user.id,
        {
          channelId: input.channelId,
          spendDate: input.spendDate,
          amountMinor,
          currency,
          source: input.source?.trim() || "manual",
        },
      );
      return { ok: true, spendId, href: `/channels/${input.channelId}` };
    },
  }),
  readTool({
    name: "list_channel_catalog_queue",
    title: "List Channel Catalog Queue",
    description:
      "List Shopify product rows awaiting matching or review. Find entry ids for match decisions with this command.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      status: z
        .enum(["queued", "matched", "ignored"])
        .optional()
        .describe("Optional queue status filter."),
      search: z.string().max(200).optional().describe("Optional product search."),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum entries to return."),
      offset: z.number().int().min(0).optional().describe("Number of entries to skip."),
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const query = {
        status: input.status,
        search: input.search,
        limit: input.limit,
        offset: input.offset,
      };
      const [queue, counts] = await Promise.all([
        listCatalogQueue(context.authz.user.orgId, input.channelId, query),
        catalogQueueCounts(context.authz.user.orgId, input.channelId),
      ]);
      return { ok: true, ...queue, counts, href: `/channels/${input.channelId}` };
    },
  }),
  mutationTool({
    name: "import_shopify_catalog",
    title: "Import Shopify Catalog",
    description:
      "Fetch and refresh Shopify catalog products into the match queue. This calls Shopify; find channel ids with list_sales_channels and review results with list_channel_catalog_queue.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    openWorld: true,
    inputSchema: z.object({
      channelId: UUID,
      mode: z
        .enum(["auto", "paginated", "bulk"])
        .optional()
        .describe("Import strategy; the connector chooses automatically when omitted."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const result = await importShopifyCatalog(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
        { mode: input.mode },
      );
      const counts = await catalogQueueCounts(context.authz.user.orgId, input.channelId);
      return { ok: true, ...result, counts, href: `/channels/${input.channelId}` };
    },
  }),
  mutationTool({
    name: "decide_shopify_catalog_match",
    title: "Decide Shopify Catalog Match",
    description:
      "Match, create or ignore one Shopify catalog queue entry. Find its entry id with list_channel_catalog_queue; native ids come from item reads.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      entryId: UUID,
      decision: z
        .discriminatedUnion("kind", [
          z.object({
            kind: z
              .literal("match")
              .describe("Link the queue entry to an existing item or item family."),
            nativeTable: z.enum(["items", "item_families"]).describe("Native record table."),
            nativeId: UUID,
          }),
          z.object({
            kind: z.literal("create_item").describe("Create and link a new item."),
            itemKind: z.string().max(100).optional().describe("Item kind."),
            code: z.string().max(100).optional().describe("Item code."),
            name: z.string().max(200).optional().describe("Item name."),
          }),
          z.object({
            kind: z.literal("create_family").describe("Create and link a new item family."),
            familyKind: z.string().max(100).optional().describe("Family kind."),
            code: z.string().max(100).optional().describe("Family code."),
          }),
          z.object({
            kind: z.literal("ignore").describe("Ignore this product."),
            reason: z.string().trim().min(1).max(500).describe("Reason for ignoring the product."),
          }),
          z.object({
            kind: z.literal("unmatch").describe("Remove a prior match."),
            reason: z.string().trim().min(1).max(500).describe("Reason for changing the match."),
          }),
        ])
        .describe("Catalog match, item creation or ignore decision."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const result = await decideCatalogMatch(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
        input.entryId,
        input.decision,
      );
      return { ok: true, ...result, href: `/channels/${input.channelId}` };
    },
  }),
  mutationTool({
    name: "bulk_decide_shopify_catalog_matches",
    title: "Bulk Decide Shopify Catalog Matches",
    description:
      "Apply one match, create or ignore decision to selected Shopify catalog entries. Find entry ids with list_channel_catalog_queue; each result reports row-level refusal.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      entryIds: z.array(UUID).max(200).describe("Catalog entries receiving the same decision."),
      decision: z
        .discriminatedUnion("kind", [
          z.object({
            kind: z.literal("match"),
            nativeTable: z
              .enum(["items", "item_families"])
              .describe("Native table receiving the match."),
            nativeId: UUID,
          }),
          z.object({
            kind: z.literal("create_item"),
            itemKind: z.string().max(100).optional().describe("Supported native item kind."),
            code: z.string().max(100).optional().describe("Optional item code."),
            name: z.string().max(200).optional().describe("New item name."),
          }),
          z.object({
            kind: z.literal("create_family"),
            familyKind: z
              .string()
              .max(100)
              .optional()
              .describe("Supported native item family kind."),
            code: z.string().max(100).optional().describe("Optional family code."),
          }),
          z.object({
            kind: z.literal("ignore"),
            reason: z
              .string()
              .trim()
              .min(1)
              .max(500)
              .describe("Reason for ignoring the imported entry."),
          }),
          z.object({
            kind: z.literal("unmatch"),
            reason: z
              .string()
              .trim()
              .min(1)
              .max(500)
              .describe("Reason for removing an existing match."),
          }),
        ])
        .describe("Decision to apply to every selected entry."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const result = await bulkDecideCatalogMatches(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
        input.entryIds,
        input.decision,
      );
      return { ok: true, ...result, href: `/channels/${input.channelId}` };
    },
  }),
  mutationTool({
    name: "push_item_to_shopify",
    title: "Push Item to Shopify",
    description:
      "Push the selected item's price or title to its matched Shopify variant. Find item ids with item reads and the channel id with list_sales_channels; this calls Shopify.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    openWorld: true,
    inputSchema: z.object({
      channelId: UUID,
      itemId: UUID,
      fields: z
        .array(z.enum(["price", "title"]))
        .max(2)
        .optional()
        .describe("Fields to push; the connector default applies when omitted."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const result = await pushItemToShopify(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
        input.itemId,
        { fields: input.fields },
      );
      return { ok: true, ...result, href: `/channels/${input.channelId}` };
    },
  }),
  readTool({
    name: "list_channel_inventory_state",
    title: "List Channel Inventory State",
    description:
      "Read location sync state, inventory conflicts and item policies for one channel. Find conflict ids to resolve with this command.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({ channelId: UUID }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const [states, conflicts, policies] = await Promise.all([
        listLocationSyncStates(context.authz.user.orgId, input.channelId),
        listInventoryConflicts(context.authz.user.orgId, input.channelId),
        listItemInventoryPolicies(context.authz.user.orgId, input.channelId),
      ]);
      return { ok: true, states, conflicts, policies, href: `/channels/${input.channelId}` };
    },
  }),
  mutationTool({
    name: "resolve_channel_inventory_conflict",
    title: "Resolve Channel Inventory Conflict",
    description:
      "Resolve one Shopify versus OpenBooks stock conflict by choosing the authoritative side. Find conflict ids with list_channel_inventory_state.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      conflictId: UUID,
      resolution: z
        .enum(["pushed_openbooks", "accepted_shopify"])
        .describe("Choose the value that should remain authoritative."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const resolved = await resolveInventoryConflict(
        context.authz.user.orgId,
        context.authz.user.id,
        input.conflictId,
        input.resolution,
      );
      return { ok: true, resolved, href: `/channels/${input.channelId}` };
    },
  }),
  mutationTool({
    name: "resolve_all_channel_inventory_conflicts",
    title: "Resolve All Channel Inventory Conflicts",
    description:
      "Resolve every inventory conflict for a channel using the selected authoritative side. Review the queue first with list_channel_inventory_state.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      resolution: z
        .enum(["pushed_openbooks", "accepted_shopify"])
        .describe("Choose the value that should remain authoritative."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const result = await resolveAllInventoryConflicts(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
        input.resolution,
      );
      return {
        ok: true,
        resolved: result.resolved,
        failed: result.failed,
        href: `/channels/${input.channelId}`,
      };
    },
  }),
  mutationTool({
    name: "set_channel_inventory_policy",
    title: "Set Channel Inventory Policy",
    description:
      "Set an item's channel buffer, zero-stock selling rule or sync setting. Find item and channel ids with item reads and list_sales_channels.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      itemId: UUID,
      bufferQuantity: z
        .string()
        .trim()
        .min(1)
        .max(30)
        .nullable()
        .optional()
        .describe("Exact decimal stock buffer."),
      stopSellingAtZero: z
        .boolean()
        .nullable()
        .optional()
        .describe("Whether the storefront item should stop selling at zero stock."),
      syncInventory: z.boolean().optional().describe("Whether inventory sync is enabled."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      await upsertItemInventoryPolicy(context.authz.user.orgId, context.authz.user.id, {
        channelId: input.channelId,
        itemId: input.itemId,
        bufferQuantity: input.bufferQuantity ?? null,
        stopSellingAtZero: input.stopSellingAtZero ?? null,
        syncInventory: input.syncInventory,
      });
      return {
        ok: true,
        channelId: input.channelId,
        itemId: input.itemId,
        href: `/channels/${input.channelId}`,
      };
    },
  }),
  mutationTool({
    name: "clear_channel_inventory_policy",
    title: "Clear Channel Inventory Policy",
    description:
      "Clear the explicit channel policy for an item so the standard sync defaults apply. Find item and channel ids with item reads and list_sales_channels.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({ channelId: UUID, itemId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    destructive: true,
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      await upsertItemInventoryPolicy(context.authz.user.orgId, context.authz.user.id, {
        channelId: input.channelId,
        itemId: input.itemId,
        bufferQuantity: null,
        stopSellingAtZero: null,
        syncInventory: true,
      });
      return {
        ok: true,
        channelId: input.channelId,
        itemId: input.itemId,
        href: `/channels/${input.channelId}`,
      };
    },
  }),
  mutationTool({
    name: "push_channel_inventory_now",
    title: "Push Channel Inventory Now",
    description:
      "Synchronize selected stock locations or items to Shopify immediately. Find sync pairs with list_channel_inventory_state; this calls Shopify.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    openWorld: true,
    inputSchema: z.object({
      channelId: UUID,
      stockLocationId: UUID.nullable().optional().describe("Optional stock location filter."),
      itemId: UUID.nullable().optional().describe("Optional item filter."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const access = await loadShopifyChannel(context.authz.user.orgId, input.channelId);
      const pairs = (await listSyncPairs(context.authz.user.orgId, input.channelId)).filter(
        (pair) =>
          (!input.stockLocationId || pair.stockLocationId === input.stockLocationId) &&
          (!input.itemId || pair.itemId === input.itemId),
      );
      const outcomes = [];
      for (const pair of pairs) {
        const result = await pushInventoryPair(
          context.authz.user.orgId,
          context.authz.user.id,
          access,
          pair,
        );
        outcomes.push({
          itemId: pair.itemId,
          stockLocationId: pair.stockLocationId,
          result: result.result,
          ...(result.result === "pushed" || result.result === "converged"
            ? { quantity: result.quantity }
            : {}),
        });
      }
      return { ok: true, outcomes, href: `/channels/${input.channelId}` };
    },
  }),
  readTool({
    name: "list_channel_external_links",
    title: "List Channel External Links",
    description:
      "List external identity mappings for one object type and channel. Find channel ids with list_sales_channels and choose an object type from the supported channel records.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      objectType: z.string().min(1).max(80).describe("External object type to list."),
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const channel = await getChannel(context.authz.user.orgId, input.channelId);
      const links = await listExternalLinks(context.authz.user.orgId, {
        provider: channel.kind,
        externalAccount: channel.externalAccount,
        objectType: input.objectType,
      });
      return { ok: true, links, href: `/channels/${channel.id}` };
    },
  }),
  mutationTool({
    name: "link_channel_external_record",
    title: "Link Channel External Record",
    description:
      "Link a provider object id to an existing native item, customer or document. Find channel ids with list_sales_channels and native ids with their module reads.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      objectType: z.string().min(1).max(80).describe("Provider object type."),
      externalId: z.string().trim().min(1).max(200).describe("External system object id."),
      externalParentId: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .nullable()
        .optional()
        .describe("Optional external parent id."),
      nativeTable: z.string().trim().min(1).max(80).describe("Native record table."),
      nativeId: UUID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const channel = await getChannel(context.authz.user.orgId, input.channelId);
      const link = await linkExternal(
        context.authz.user.orgId,
        context.authz.user.id,
        {
          channelId: input.channelId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          provider: channel.kind,
          externalAccount: channel.externalAccount,
          objectType: input.objectType,
          externalId: input.externalId,
          externalParentId: input.externalParentId ?? null,
          nativeTable: input.nativeTable,
          nativeId: input.nativeId,
        },
        "salesChannels",
      );
      return { ok: true, link, href: `/channels/${channel.id}` };
    },
  }),
  mutationTool({
    name: "unlink_channel_external_record",
    title: "Unlink Channel External Record",
    description:
      "Remove an external identity mapping with an audit reason. Find mapping ids and external ids with list_channel_external_links.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    destructive: true,
    inputSchema: z.object({
      channelId: UUID,
      objectType: z.string().min(1).max(80).describe("Provider object type."),
      externalId: z.string().trim().min(1).max(200).describe("External system object id."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .describe("Reason for unlinking the external identity."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const channel = await getChannel(context.authz.user.orgId, input.channelId);
      await unlinkExternal(
        context.authz.user.orgId,
        context.authz.user.id,
        {
          provider: channel.kind,
          externalAccount: channel.externalAccount,
          objectType: input.objectType,
          externalId: input.externalId,
        },
        input.reason,
        "salesChannels",
      );
      return {
        ok: true,
        channelId: channel.id,
        status: "unlinked",
        href: `/channels/${channel.id}`,
      };
    },
  }),
  readTool({
    name: "list_channel_locations",
    title: "List Channel Locations",
    description:
      "Read imported storefront locations and their stock-location mappings. Find location identifiers before updating or unlinking a location.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({ channelId: UUID }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      return {
        ok: true,
        locations: await listChannelLocations(context.authz.user.orgId, input.channelId),
        href: `/channels/${input.channelId}`,
      };
    },
  }),
  mutationTool({
    name: "import_shopify_locations",
    title: "Import Shopify Locations",
    description:
      "Fetch Shopify locations and add missing local mappings without moving existing operator mappings. Find the channel id with list_sales_channels; this calls Shopify.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    openWorld: true,
    inputSchema: z.object({ channelId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const result = await importShopifyLocations(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
      );
      return { ok: true, ...result, href: `/channels/${input.channelId}` };
    },
  }),
  mutationTool({
    name: "map_channel_location",
    title: "Map Channel Location",
    description:
      "Map an external storefront location to a stock location and set fulfillment and inventory behavior. Find channel and stock-location ids with list_sales_channels and inventory reads.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      externalLocationId: z.string().trim().min(1).max(120).describe("External location id."),
      externalName: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Location name returned by the channel."),
      stockLocationId: UUID.nullable().optional().describe("Native stock location mapping."),
      syncInventory: z.boolean().optional().describe("Whether inventory sync is enabled."),
      fulfilsOrders: z.boolean().optional().describe("Whether this location fulfills orders."),
      bufferQuantity: z
        .string()
        .trim()
        .min(1)
        .max(30)
        .nullable()
        .optional()
        .describe("Exact decimal inventory buffer."),
      stopSellingAtZero: z
        .boolean()
        .optional()
        .describe("Whether items stop selling at zero stock."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const location = await upsertChannelLocation(
        context.authz.user.orgId,
        context.authz.user.id,
        {
          channelId: input.channelId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          externalLocationId: input.externalLocationId,
          externalName: input.externalName,
          stockLocationId: input.stockLocationId ?? null,
          syncInventory: input.syncInventory,
          fulfilsOrders: input.fulfilsOrders,
          bufferQuantity: input.bufferQuantity ?? null,
          stopSellingAtZero: input.stopSellingAtZero,
        },
      );
      return { ok: true, location, href: `/channels/${input.channelId}` };
    },
  }),
  mutationTool({
    name: "unlink_channel_location",
    title: "Unlink Channel Location",
    description:
      "Remove an external location mapping with a reason. Find external location ids with list_channel_locations.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    destructive: true,
    inputSchema: z.object({
      channelId: UUID,
      externalLocationId: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe("External location id from list_channel_locations."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .describe("Reason for removing the location mapping."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      await unlinkChannelLocation(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
        input.externalLocationId,
        input.reason,
      );
      return {
        ok: true,
        channelId: input.channelId,
        status: "unlinked",
        href: `/channels/${input.channelId}`,
      };
    },
  }),
  mutationTool({
    name: "set_channel_posting_policy",
    title: "Set Channel Posting Policy",
    description:
      "Write a new effective-dated policy for channel order posting; existing orders retain their original accounting. Find channel and account ids with list_sales_channels and accounting reads.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      mode: z
        .enum(["per_order", "daily_summary"])
        .describe("Post one document per order or aggregate a daily summary."),
      unpaidCreatesSalesOrder: z
        .boolean()
        .optional()
        .describe("Create sales orders for unpaid orders."),
      guestCustomerPartyId: UUID.nullable()
        .optional()
        .describe("Fallback customer for guest orders."),
      createPromotionOnMatchMiss: z
        .boolean()
        .optional()
        .describe("Whether a match miss may create a promotion record."),
      cutoffTz: z
        .string()
        .max(60)
        .optional()
        .describe("IANA timezone used for daily summary cutoff."),
      excludedTags: z
        .array(z.string().max(120))
        .max(100)
        .optional()
        .describe("Order tags excluded from posting."),
      excludedSources: z
        .array(z.string().max(120))
        .max(100)
        .optional()
        .describe("Order sources excluded from posting."),
      effectiveFrom: DATE,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const policy = await setPostingPolicy(context.authz.user.orgId, context.authz.user.id, {
        channelId: input.channelId,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        mode: input.mode,
        unpaidCreatesSalesOrder: input.unpaidCreatesSalesOrder,
        guestCustomerPartyId: input.guestCustomerPartyId,
        createPromotionOnMatchMiss: input.createPromotionOnMatchMiss,
        cutoffTz: input.cutoffTz,
        excludedTags: input.excludedTags,
        excludedSources: input.excludedSources,
        effectiveFrom: input.effectiveFrom,
      });
      return {
        ok: true,
        effectiveFrom: policy.effectiveFrom,
        mode: policy.mode,
        href: `/channels/${input.channelId}`,
      };
    },
  }),
  readTool({
    name: "get_shopify_channel_review",
    title: "Get Shopify Channel Review",
    description:
      "Read the Shopify connection review, including imported locations and proposed posting accounts. Find channel ids with list_sales_channels.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({ channelId: UUID }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      return {
        ok: true,
        review: await shopifyReview(context.authz.user.orgId, input.channelId),
        href: `/channels/${input.channelId}`,
      };
    },
  }),
  mutationTool({
    name: "accept_shopify_channel_review",
    title: "Accept Shopify Channel Review",
    description:
      "Accept the imported Shopify setup by saving account mappings and starting synchronization. Review first with get_shopify_channel_review; this may call Shopify to register webhooks.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    openWorld: true,
    inputSchema: z.object({
      channelId: UUID,
      accountMaps: z
        .array(accountMap)
        .max(100)
        .describe("Effective-dated posting accounts to approve."),
      effectiveFrom: DATE.optional().describe("First day the approved account mappings apply."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      await assertAccounts(
        context,
        input.accountMaps.map((map) => map.accountId),
      );
      const accepted = await acceptShopifyReview(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId,
        { accountMaps: input.accountMaps, effectiveFrom: input.effectiveFrom },
      );
      const review = await shopifyReview(context.authz.user.orgId, input.channelId);
      return {
        ok: true,
        ...accepted,
        review,
        status: "active",
        href: `/channels/${input.channelId}`,
      };
    },
  }),
  readTool({
    name: "list_channel_inbound_events",
    title: "List Channel Inbound Events",
    description:
      "Read the verified inbound event queue for a channel and find event ids for replay. Find channel ids with list_sales_channels.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      limit: z.number().int().min(1).max(500).optional().describe("Maximum events to return."),
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const events = await listInboundEvents(
        context.authz.user.orgId,
        input.channelId,
        input.limit ?? 100,
      );
      return { ok: true, events, href: `/channels/${input.channelId}` };
    },
  }),
  readTool({
    name: "list_channel_order_events",
    title: "List Channel Order Events",
    description:
      "Read event history for one imported channel order. Find order ids with list_channel_exceptions.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({ orderId: UUID }),
    execute: async (context, input) => {
      await assertChannelOrder(context, input.orderId);
      const events = await listChannelOrderEvents(context.authz.user.orgId, input.orderId);
      return { ok: true, events, href: "/channels/orders" };
    },
  }),
  mutationTool({
    name: "replay_channel_inbound_event",
    title: "Replay Channel Inbound Event",
    description:
      "Reprocess one verified inbound event after correcting its exception. Find its event id with list_channel_inbound_events and provide an audit reason.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID,
      eventId: UUID,
      reason: z.string().trim().min(1).max(1000).describe("Reason for replaying the event."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannel(context, input.channelId);
      const event = await replayEvent(
        context.authz.user.orgId,
        context.authz.user.id,
        input.eventId,
        input.reason,
        input.channelId,
      );
      return { ok: true, event, status: event.status, href: `/channels/${input.channelId}` };
    },
  }),
  readTool({
    name: "list_channel_exceptions",
    title: "List Channel Exceptions",
    description:
      "List parked channel orders with their exception code, reason and remedy. Use the returned order ids to approve, reject, recompute or replay an order.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID.nullable().optional().describe("Limit to one accessible channel."),
      code: z.string().max(60).nullable().optional().describe("Limit to one exception code."),
    }),
    execute: async (context, input) => {
      if (input.channelId) await assertChannel(context, input.channelId);
      const rows = await listChannelExceptions(
        context.authz.user.orgId,
        input.channelId ?? null,
        input.code ?? null,
      );
      const visibleIds = new Set(
        channelsInScope(context.authz, await listChannels(context.authz.user.orgId)).map(
          (channel) => channel.id,
        ),
      );
      const exceptions = rows.filter((row) => visibleIds.has(row.channelId));
      return { ok: true, exceptions, href: "/channels/exceptions" };
    },
  }),
  readTool({
    name: "list_channel_event_exceptions",
    title: "List Channel Event Exceptions",
    description:
      "List parked refund, cancellation and fulfillment events with their exception code, reason and remedy. Use event ids to replay one event or filter by a shared code.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID.nullable().optional().describe("Limit to one accessible channel."),
      code: z.string().max(60).nullable().optional().describe("Optional exception code filter."),
    }),
    execute: async (context, input) => {
      if (input.channelId) await assertChannel(context, input.channelId);
      const rows = await listChannelEventExceptions(
        context.authz.user.orgId,
        input.channelId ?? null,
        input.code ?? null,
      );
      const visibleIds = new Set(
        channelsInScope(context.authz, await listChannels(context.authz.user.orgId)).map(
          (channel) => channel.id,
        ),
      );
      return {
        ok: true,
        exceptions: rows.filter((row) => visibleIds.has(row.channelId)),
        href: "/channels/exceptions",
      };
    },
  }),
  readTool({
    name: "get_channel_exception_suggestion",
    title: "Get Channel Exception Suggestion",
    description:
      "Read the deterministic ranked fix candidates for a parked channel order before approving a suggestion. Find order ids and exception reasons with list_channel_exceptions.",
    permission: "channels.read",
    featureKey: "salesChannels",
    inputSchema: z.object({ orderId: UUID }),
    execute: async (context, input) => {
      await assertChannelOrder(context, input.orderId);
      const suggestion = await suggestExceptionFix(
        context.authz.user.orgId,
        input.orderId,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, suggestion, href: "/channels/exceptions" };
    },
  }),
  mutationTool({
    name: "approve_channel_exception_suggestion",
    title: "Approve Channel Exception Suggestion",
    description:
      "Approve a currently offered exception fix and optionally apply it to similar orders. Find exception order ids with list_channel_exceptions; the engine recomputes the proposed rank before applying it.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      orderId: UUID,
      rank: z
        .number()
        .int()
        .min(0)
        .max(20)
        .describe("Candidate rank currently offered by the order read."),
      applyToSimilar: z.boolean().describe("Apply the same verified mapping to similar orders."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannelOrder(context, input.orderId);
      const result = await approveExceptionSuggestion(
        context.authz.user.orgId,
        context.authz.user.id,
        input.orderId,
        {
          rank: input.rank,
          applyToSimilar: input.applyToSimilar,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
      );
      return { ok: true, ...result, href: "/channels/exceptions" };
    },
  }),
  mutationTool({
    name: "reject_channel_exception_suggestion",
    title: "Reject Channel Exception Suggestion",
    description:
      "Reject an offered exception fix with an audit reason and leave the order parked. Find exception order ids with list_channel_exceptions.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    destructive: true,
    inputSchema: z.object({
      orderId: UUID,
      reason: z.string().trim().min(1).max(2000).describe("Reason for rejecting the proposed fix."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await assertChannelOrder(context, input.orderId);
      await rejectExceptionSuggestion(
        context.authz.user.orgId,
        context.authz.user.id,
        input.orderId,
        input.reason,
      );
      return {
        ok: true,
        orderId: input.orderId,
        status: "exception",
        href: "/channels/exceptions",
      };
    },
  }),
  mutationTool({
    name: "replay_channel_order_exceptions",
    title: "Replay Channel Order Exceptions",
    description:
      "Replay parked channel orders after correcting their shared cause, optionally limited to one channel or exception code. Review the affected orders with list_channel_exceptions.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID.nullable()
        .optional()
        .describe("Optional channel filter; without one this spans all subsidiaries."),
      code: z.string().max(60).nullable().optional().describe("Optional exception code filter."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      if (input.channelId) await assertChannel(context, input.channelId);
      else requireUnrestrictedScope(context);
      const result = await replayChannelExceptions(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId ?? null,
        input.code ?? null,
      );
      return { ok: true, ...result, href: "/channels/exceptions" };
    },
  }),
  mutationTool({
    name: "replay_channel_event_exceptions",
    title: "Replay Channel Event Exceptions",
    description:
      "Replay parked refund, cancellation and fulfillment events after correcting their shared cause. Use list_channel_inbound_events to inspect event failures; a global replay requires unrestricted subsidiary access.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({
      channelId: UUID.nullable()
        .optional()
        .describe("Optional channel filter; without one this spans all subsidiaries."),
      code: z
        .string()
        .max(60)
        .nullable()
        .optional()
        .describe("Optional event exception code filter."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      if (input.channelId) await assertChannel(context, input.channelId);
      else requireUnrestrictedScope(context);
      const result = await replayChannelEventExceptions(
        context.authz.user.orgId,
        context.authz.user.id,
        input.channelId ?? null,
        input.code ?? null,
      );
      return { ok: true, ...result, href: "/channels/exceptions" };
    },
  }),
  mutationTool({
    name: "recompute_channel_order_economics",
    title: "Recompute Channel Order Economics",
    description:
      "Recompute margin facts for one channel order after late cost data arrives; the operation preserves restatement history. Find order ids with list_channel_exceptions.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({ orderId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    execute: async (context, input) => {
      await assertChannelOrder(context, input.orderId);
      const outcome = await recomputeOrderEconomics(
        context.authz.user.orgId,
        context.authz.user.id,
        input.orderId,
      );
      return {
        ok: true,
        inserted: outcome.inserted,
        retired: outcome.retired,
        href: "/channels/orders",
      };
    },
  }),
  mutationTool({
    name: "replay_channel_order",
    title: "Replay Channel Order",
    description:
      "Reprocess one parked channel order through its native posting workflow after fixing the exception. Find order ids and remedies with list_channel_exceptions.",
    permission: "channels.manage",
    featureKey: "salesChannels",
    inputSchema: z.object({ orderId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    execute: async (context, input) => {
      await assertChannelOrder(context, input.orderId);
      const outcome = await postChannelOrder(
        context.authz.user.orgId,
        context.authz.user.id,
        input.orderId,
        { forcePerOrder: true },
      );
      return {
        ok: true,
        status: outcome.status,
        documentId: outcome.documentId,
        href: outcome.documentId
          ? `/sales-orders?order=${outcome.documentId}`
          : "/channels/exceptions",
      };
    },
  }),
];
