import { sql } from "drizzle-orm";
import { ShopifyClient } from "../connectors/shopify.ts";
import { listAvailableToPromise } from "../inventory/availability.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { db, withBypassContext, withOrg, withOrgContext } from "../platform/db.ts";
import { CommerceError } from "./errors.ts";
import { loadShopifyChannel, type ShopifyChannelAccess } from "./shopify/channel-access.ts";
import {
  decidePushOutcome,
  readShopifyAvailable,
  resolveShopifyInventoryItemId,
  sellableQuantity,
  setShopifyAvailable,
  setVariantSellablePolicy,
} from "./shopify/inventory-push.ts";

/**
 * Storefront inventory sync: available-to-sell flows from OpenBooks to
 * Shopify per mapped location, and a quantity Shopify changed on its own
 * waits in the conflict queue instead of being overwritten.
 *
 * Two rhythms share one push path. Stock movements emit
 * `inventory.available_changed` through the outbound webhook outbox; the
 * scan reads those rows as its fast lane (coalesced per pair, debounced so
 * a burst of movements settles into one push). Pairs with no fresh event
 * still reconcile on staleness, which is how an outside change with no
 * local movement is caught. OpenBooks stays the book of record throughout:
 * accepting Shopify only rebases the baseline, never native stock.
 */

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

/** A burst of movements settles into one push after this long. */
export const INVENTORY_PUSH_DEBOUNCE_MS = 60_000;
/** A pair with no movement still reconciles against the storefront this often. */
export const INVENTORY_RECONCILE_STALE_MS = 4 * 60 * 60 * 1_000;
/** Pairs pushed for one channel in one scan tick. */
export const INVENTORY_SYNC_BATCH_LIMIT = 200;

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new CommerceError(code, message, remedy, { field, status });
}

async function requireFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
    refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
  }
}

export interface SyncPair {
  channelId: string;
  stockLocationId: string;
  stockLocationCode: string;
  externalLocationId: string;
  externalName: string;
  itemId: string;
  itemCode: string | null;
  itemName: string;
  variantExternalId: string;
  bufferQuantity: string;
  stopSellingAtZero: boolean;
  syncEnabled: boolean;
}

type SyncPairDbRow = Record<string, unknown> & {
  stock_location_id: string;
  stock_location_code: string | null;
  external_location_id: string;
  external_name: string;
  item_id: string;
  item_code: string | null;
  item_name: string;
  variant_external_id: string;
  location_buffer: string;
  location_stop: boolean;
  policy_buffer: string | null;
  policy_stop: boolean | null;
  policy_sync: boolean | null;
};

function toPair(channelId: string, row: SyncPairDbRow): SyncPair {
  return {
    channelId,
    stockLocationId: row.stock_location_id,
    stockLocationCode: row.stock_location_code ?? row.external_name,
    externalLocationId: row.external_location_id,
    externalName: row.external_name,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    variantExternalId: row.variant_external_id,
    bufferQuantity: row.policy_buffer ?? row.location_buffer,
    stopSellingAtZero: row.policy_stop ?? row.location_stop,
    syncEnabled: row.policy_sync ?? true,
  };
}

/**
 * Every mapped pair for a channel: a synced location with native stock
 * times a variant linked to a native item, with the per-item override
 * resolved over the location policy. Unmapped locations and unlinked
 * variants never appear — there is nothing truthful to push for them.
 */
export async function listSyncPairs(orgId: string, channelId: string): Promise<SyncPair[]> {
  const rows = (await db.execute<SyncPairDbRow>(sql`
    select l.stock_location_id, sl.code as stock_location_code,
           l.external_location_id, l.external_name,
           v.native_id as item_id, i.code as item_code, i.name as item_name,
           v.external_id as variant_external_id,
           l.buffer_quantity::text as location_buffer, l.stop_selling_at_zero as location_stop,
           p.buffer_quantity::text as policy_buffer,
           p.stop_selling_at_zero as policy_stop, p.sync_inventory as policy_sync
      from sales_channel_locations l
      join sales_channels c on c.org_id = l.org_id and c.id = l.channel_id
      join stock_locations sl on sl.org_id = l.org_id and sl.id = l.stock_location_id
      join external_links v on v.org_id = l.org_id and v.provider = 'shopify'
       and v.external_account = c.external_account and v.object_type = 'variant'
       and v.native_table = 'items'
      join items i on i.org_id = l.org_id and i.id = v.native_id
      left join channel_item_inventory_policies p on p.org_id = l.org_id
       and p.channel_id = l.channel_id and p.item_id = v.native_id
     where l.org_id = ${orgId} and l.channel_id = ${channelId}
       and l.sync_inventory and l.stock_location_id is not null
     order by l.external_name, i.code`)).rows;
  return rows.map((row) => toPair(channelId, row));
}

interface PushStateDbRow extends Record<string, unknown> {
  shopify_inventory_item_id: string | null;
  last_pushed_quantity: number | null;
  last_shopify_quantity: number | null;
  last_inventory_policy: string | null;
  last_pushed_at: string | null;
  last_status: string;
  last_error: string | null;
}

async function readPushState(orgId: string, pair: SyncPair): Promise<PushStateDbRow | null> {
  return (await db.execute<PushStateDbRow>(sql`
    select shopify_inventory_item_id, last_pushed_quantity, last_shopify_quantity,
           last_inventory_policy, last_pushed_at::text, last_status, last_error
      from channel_inventory_push_states
     where org_id = ${orgId} and channel_id = ${pair.channelId}
       and stock_location_id = ${pair.stockLocationId} and item_id = ${pair.itemId}`)).rows[0] ?? null;
}

/** The pair's latest resolved conflict, if any: what the operator last signed off. */
async function latestResolvedConflict(
  orgId: string,
  pair: SyncPair,
): Promise<{ resolution: string | null; openbooks_quantity: number; shopify_quantity: number } | null> {
  return (await db.execute<{
    resolution: string | null;
    openbooks_quantity: number;
    shopify_quantity: number;
  }>(sql`
    select resolution, openbooks_quantity, shopify_quantity
      from channel_inventory_conflicts
     where org_id = ${orgId} and channel_id = ${pair.channelId}
       and stock_location_id = ${pair.stockLocationId} and item_id = ${pair.itemId}
       and status = 'resolved'
     order by resolved_at desc nulls last, updated_at desc limit 1`)).rows[0] ?? null;
}

/** An open conflict blocks the pair: the operator's decision comes first. */
async function openConflict(orgId: string, pair: SyncPair): Promise<{ id: string } | null> {
  return (await db.execute<{ id: string }>(sql`
    select id from channel_inventory_conflicts
     where org_id = ${orgId} and channel_id = ${pair.channelId}
       and stock_location_id = ${pair.stockLocationId} and item_id = ${pair.itemId}
       and status = 'open' limit 1`)).rows[0] ?? null;
}

/**
 * Pairs due this tick: never pushed, stale past reconciliation, or moved
 * locally since the last push (debounced). An availability event for the
 * item with no location also marks every location of that item — a
 * movement the location cannot place still changes what it can sell.
 */
export async function listDueSyncPairs(
  orgId: string,
  channelId: string,
  now: Date = new Date(),
  limit: number = INVENTORY_SYNC_BATCH_LIMIT,
): Promise<SyncPair[]> {
  const debounceAgo = new Date(now.getTime() - INVENTORY_PUSH_DEBOUNCE_MS).toISOString();
  const staleAgo = new Date(now.getTime() - INVENTORY_RECONCILE_STALE_MS).toISOString();
  const rows = (await db.execute<SyncPairDbRow>(sql`
    select l.stock_location_id, sl.code as stock_location_code,
           l.external_location_id, l.external_name,
           v.native_id as item_id, i.code as item_code, i.name as item_name,
           v.external_id as variant_external_id,
           l.buffer_quantity::text as location_buffer, l.stop_selling_at_zero as location_stop,
           p.buffer_quantity::text as policy_buffer,
           p.stop_selling_at_zero as policy_stop, p.sync_inventory as policy_sync
      from sales_channel_locations l
      join sales_channels c on c.org_id = l.org_id and c.id = l.channel_id
      join stock_locations sl on sl.org_id = l.org_id and sl.id = l.stock_location_id
      join external_links v on v.org_id = l.org_id and v.provider = 'shopify'
       and v.external_account = c.external_account and v.object_type = 'variant'
       and v.native_table = 'items'
      join items i on i.org_id = l.org_id and i.id = v.native_id
      left join channel_item_inventory_policies p on p.org_id = l.org_id
       and p.channel_id = l.channel_id and p.item_id = v.native_id
      left join channel_inventory_push_states s on s.org_id = l.org_id
       and s.channel_id = l.channel_id and s.stock_location_id = l.stock_location_id
       and s.item_id = v.native_id
     where l.org_id = ${orgId} and l.channel_id = ${channelId}
       and l.sync_inventory and l.stock_location_id is not null
       and coalesce(p.sync_inventory, true)
       and not exists (
         select 1 from channel_inventory_conflicts k
          where k.org_id = l.org_id and k.channel_id = l.channel_id
            and k.stock_location_id = l.stock_location_id and k.item_id = v.native_id
            and k.status = 'open')
       and (s.id is null or s.last_pushed_at is null or s.last_pushed_at < ${staleAgo}
         or exists (
           select 1 from webhook_events e
            where e.org_id = l.org_id and e.event_type = 'inventory.available_changed'
              and e.payload ->> 'itemId' = v.native_id::text
              and (e.payload ->> 'stockLocationId' is null
                or e.payload ->> 'stockLocationId' = l.stock_location_id::text)
              and e.occurred_at > s.last_pushed_at and e.occurred_at < ${debounceAgo}::timestamptz))
     order by s.last_pushed_at nulls first
     limit ${limit}`)).rows;
  return rows.map((row) => toPair(channelId, row));
}

function shopifyLocationGid(externalLocationId: string): string {
  return `gid://shopify/Location/${externalLocationId}`;
}

function shopifyVariantGid(variantExternalId: string): string {
  return `gid://shopify/ProductVariant/${variantExternalId}`;
}

/** The audit pointer Shopify stores beside the adjustment. */
function pushReferenceUri(pair: SyncPair): string {
  return `openbooks:channel-inventory:${pair.channelId}:${pair.itemId}:${pair.stockLocationId}`;
}

async function writePushState(
  orgId: string,
  actor: string | null,
  pair: SyncPair,
  state: {
    inventoryItemId: string | null;
    pushed: number;
    shopify: number;
    policy: "deny" | "continue";
    status: "ok" | "conflict" | "error";
    error: string | null;
    at: Date;
  },
): Promise<void> {
  // A retry racing the first write refreshes the same pair row: the natural
  // key (channel, stock location, item) identifies one baseline.
  const updated = await db.execute(sql`
    insert into channel_inventory_push_states
      (org_id, channel_id, stock_location_id, item_id, shopify_inventory_item_id,
       last_pushed_quantity, last_shopify_quantity, last_inventory_policy,
       last_pushed_at, last_status, last_error, created_by, updated_by)
    values (${orgId}, ${pair.channelId}, ${pair.stockLocationId}, ${pair.itemId},
      ${state.inventoryItemId}, ${state.pushed}, ${state.shopify}, ${state.policy},
      ${state.at}, ${state.status}, ${state.error}, ${actor}, ${actor})
    on conflict (org_id, channel_id, stock_location_id, item_id) do update set
      shopify_inventory_item_id = excluded.shopify_inventory_item_id,
      last_pushed_quantity = excluded.last_pushed_quantity,
      last_shopify_quantity = excluded.last_shopify_quantity,
      last_inventory_policy = excluded.last_inventory_policy,
      last_pushed_at = excluded.last_pushed_at,
      last_status = excluded.last_status,
      last_error = excluded.last_error,
      updated_by = excluded.updated_by, updated_at = now()`);
  if ((updated.rowCount ?? 0) !== 1) {
    throw new Error("Channel inventory push state matched no row; the baseline was lost");
  }
}

async function openInventoryConflict(
  orgId: string,
  actor: string | null,
  pair: SyncPair,
  openbooks: number,
  shopify: number,
  inventoryItemGid: string,
): Promise<void> {
  // A repeat scan while the operator decides refreshes the quantities on
  // the open row instead of stacking conflicts: one open row per pair.
  const updated = await db.execute(sql`
    insert into channel_inventory_conflicts
      (org_id, channel_id, stock_location_id, item_id,
       openbooks_quantity, shopify_quantity, created_by, updated_by)
    values (${orgId}, ${pair.channelId}, ${pair.stockLocationId}, ${pair.itemId},
      ${openbooks}, ${shopify}, ${actor}, ${actor})
    on conflict (org_id, channel_id, stock_location_id, item_id)
      where status = 'open'
      do update set openbooks_quantity = excluded.openbooks_quantity,
                      shopify_quantity = excluded.shopify_quantity,
                      updated_by = excluded.updated_by, updated_at = now()`);
  if ((updated.rowCount ?? 0) !== 1) {
    throw new Error("Channel inventory conflict matched no row; the conflict was lost");
  }
  await writePushState(orgId, actor, pair, {
    inventoryItemId: inventoryItemGid,
    pushed: openbooks,
    shopify,
    policy: pair.stopSellingAtZero ? "deny" : "continue",
    status: "conflict",
    error: `Shopify holds ${shopify} while OpenBooks computes ${openbooks}; resolve the conflict under Channels → Locations & stock.`,
    at: new Date(),
  });
}

export type PairPushOutcome =
  | { result: "pushed"; quantity: number }
  | { result: "converged"; quantity: number }
  | { result: "conflict"; openbooks: number; shopify: number }
  | { result: "skipped"; reason: string };

export interface PushPairOptions {
  transport?: typeof fetch;
}

/**
 * Push one mapped pair: compute available to promise at the mapped stock
 * location (kits derive from their components inside), hold back the
 * buffer, and set the storefront quantity with the last read as the
 * compare. A pair the operator paused skips; a pair with an open conflict
 * waits for the decision; anything Shopify refuses lands on the state row
 * with its remedy instead of failing the scan.
 */
export async function pushInventoryPair(
  orgId: string,
  actor: string | null,
  channel: ShopifyChannelAccess,
  pair: SyncPair,
  options: PushPairOptions = {},
): Promise<PairPushOutcome> {
  if (!pair.syncEnabled) return { result: "skipped", reason: "paused for this item" };
  if (!channel.subsidiaryId) {
    refuse(
      "channel_subsidiary_missing",
      `Channel "${channel.name}" names no subsidiary, so available to promise has no legal entity to measure.`,
      "Choose the subsidiary under Channels → Settings, then push again.",
      "subsidiaryId",
    );
  }
  const blocked = await openConflict(orgId, pair);
  if (blocked) return { result: "skipped", reason: "an open conflict waits for a decision" };
  const [terms] = await listAvailableToPromise(db, orgId, {
    subsidiaryId: channel.subsidiaryId,
    stockLocationIds: [pair.stockLocationId],
    itemIds: [pair.itemId],
  });
  if (!terms) {
    refuse(
      "channel_inventory_item_unstocked",
      `"${pair.itemName}" carries no stock: it has no inventory costing profile.`,
      "Add an inventory costing profile on the item's Inventory costing section, then push again.",
      null,
    );
  }
  const { pushQuantity } = sellableQuantity(terms.available, pair.bufferQuantity);
  const client = new ShopifyClient({
    shopDomain: channel.shop,
    accessToken: channel.accessToken,
    transport: options.transport,
  });
  const state = await readPushState(orgId, pair);
  const inventoryItemGid =
    state?.shopify_inventory_item_id?.trim() ||
    (await resolveShopifyInventoryItemId(client, shopifyVariantGid(pair.variantExternalId)));
  const locationGid = shopifyLocationGid(pair.externalLocationId);
  const live = await readShopifyAvailable(client, inventoryItemGid, locationGid);
  const policy: "deny" | "continue" = pair.stopSellingAtZero ? "deny" : "continue";
  // An accepted conflict stays accepted while neither side moves: the
  // resolved row carries the quantities the operator signed off, so an
  // event that nets to the same computed quantity does not re-push over
  // the accepted storefront level.
  const accepted = await latestResolvedConflict(orgId, pair);
  if (
    accepted?.resolution === "accepted_shopify" &&
    accepted.openbooks_quantity === pushQuantity &&
    accepted.shopify_quantity === live.quantity
  ) {
    await writePushState(orgId, actor, pair, {
      inventoryItemId: inventoryItemGid,
      pushed: live.quantity ?? pushQuantity,
      shopify: live.quantity ?? pushQuantity,
      policy,
      status: "ok",
      error: null,
      at: new Date(),
    });
    return { result: "converged", quantity: pushQuantity };
  }
  const decision = decidePushOutcome({
    computed: pushQuantity,
    live: live.quantity,
    pushed: state?.last_pushed_quantity ?? null,
    lastShopify: state?.last_shopify_quantity ?? null,
  });
  if (decision.action === "converged") {
    await writePushState(orgId, actor, pair, {
      inventoryItemId: inventoryItemGid,
      pushed: state?.last_pushed_quantity ?? pushQuantity,
      shopify: live.quantity ?? state?.last_shopify_quantity ?? pushQuantity,
      policy,
      status: "ok",
      error: null,
      at: new Date(),
    });
    return { result: "converged", quantity: pushQuantity };
  }
  if (decision.action === "conflict") {
    await openInventoryConflict(orgId, actor, pair, pushQuantity, decision.live, inventoryItemGid);
    return { result: "conflict", openbooks: pushQuantity, shopify: decision.live };
  }
  try {
    await setShopifyAvailable(client, {
      inventoryItemGid,
      locationGid,
      quantity: pushQuantity,
      compareQuantity: decision.compareQuantity,
      referenceUri: pushReferenceUri(pair),
    });
  } catch (error) {
    if (error instanceof CommerceError && error.code === "channel_inventory_push_refused") {
      const refreshed = await readShopifyAvailable(client, inventoryItemGid, locationGid);
      await openInventoryConflict(
        orgId,
        actor,
        pair,
        pushQuantity,
        refreshed.quantity ?? decision.compareQuantity ?? pushQuantity,
        inventoryItemGid,
      );
      return {
        result: "conflict",
        openbooks: pushQuantity,
        shopify: refreshed.quantity ?? decision.compareQuantity ?? pushQuantity,
      };
    }
    throw error;
  }
  if ((state?.last_inventory_policy ?? null) !== policy) {
    await setVariantSellablePolicy(client, shopifyVariantGid(pair.variantExternalId), pair.stopSellingAtZero);
  }
  await writePushState(orgId, actor, pair, {
    inventoryItemId: inventoryItemGid,
    pushed: pushQuantity,
    shopify: pushQuantity,
    policy,
    status: "ok",
    error: null,
    at: new Date(),
  });
  return { result: "pushed", quantity: pushQuantity };
}

export interface ChannelSyncSummary {
  channelId: string;
  pushed: number;
  converged: number;
  conflicts: number;
  skipped: number;
  errors: number;
}

export interface CommerceChannelSyncOptions extends PushPairOptions {
  now?: Date;
  limit?: number;
}

/**
 * The scheduler scan body for kind `commerce_channel_sync`: due pairs for
 * every active Shopify channel with synced locations, oldest baseline
 * first. One pair's failure parks on its state row and the scan moves on —
 * a refused pair must not hold the channel's other pairs hostage. Running
 * the scan twice with no movement pushes nothing the second time.
 */
export async function runCommerceChannelSyncScan(
  options: CommerceChannelSyncOptions = {},
): Promise<ChannelSyncSummary[]> {
  const summaries: ChannelSyncSummary[] = [];
  // bypass: scheduler-tick — the inventory scan crosses organizations
  // before each row's organization is known.
  const channels = await withBypassContext(() => db.execute<{ org_id: string; id: string }>(sql`
    select c.org_id, c.id from sales_channels c
     where c.kind = 'shopify' and c.status = 'active'
       and exists (
         select 1 from sales_channel_locations l
          where l.org_id = c.org_id and l.channel_id = c.id
            and l.sync_inventory and l.stock_location_id is not null)
     limit 50`)).then((result) => result.rows);
  for (const channel of channels) {
    const summary: ChannelSyncSummary = {
      channelId: channel.id,
      pushed: 0,
      converged: 0,
      conflicts: 0,
      skipped: 0,
      errors: 0,
    };
    try {
      await withOrgContext(channel.org_id, async () => {
        const access = await loadShopifyChannel(channel.org_id, channel.id);
        const due = await listDueSyncPairs(channel.org_id, channel.id, options.now, options.limit);
        for (const pair of due) {
          try {
            const outcome = await pushInventoryPair(channel.org_id, null, access, pair, options);
            if (outcome.result === "pushed") summary.pushed += 1;
            else if (outcome.result === "converged") summary.converged += 1;
            else if (outcome.result === "conflict") summary.conflicts += 1;
            else summary.skipped += 1;
          } catch (error) {
            summary.errors += 1;
            await recordPairError(channel.org_id, pair, error);
          }
        }
      });
    } catch {
      continue;
    }
    summaries.push(summary);
  }
  return summaries;
}

async function recordPairError(orgId: string, pair: SyncPair, error: unknown): Promise<void> {
  const state = await readPushState(orgId, pair);
  const message =
    error instanceof CommerceError
      ? `${error.message} ${error.remedy}`
      : "The stock push failed before Shopify answered — the scan retries automatically.";
  try {
    await writePushState(orgId, null, pair, {
      inventoryItemId: state?.shopify_inventory_item_id?.trim() || null,
      pushed: state?.last_pushed_quantity ?? 0,
      shopify: state?.last_shopify_quantity ?? 0,
      policy: (state?.last_inventory_policy === "continue" ? "continue" : "deny") as "deny" | "continue",
      status: "error",
      error: message.slice(0, 500),
      at: new Date(),
    });
  } catch {
    // The state row itself is unwritable; the scan already counted the error.
  }
}

export interface InventoryConflictRow {
  id: string;
  channelId: string;
  channelName: string;
  stockLocationId: string;
  stockLocationCode: string;
  externalName: string;
  itemId: string;
  itemCode: string | null;
  itemName: string;
  openbooksQuantity: number;
  shopifyQuantity: number;
  createdAt: string;
}

type InventoryConflictDbRow = Record<string, unknown> & {
  id: string;
  channel_id: string;
  channel_name: string;
  stock_location_id: string;
  stock_location_code: string | null;
  external_name: string;
  item_id: string;
  item_code: string | null;
  item_name: string;
  openbooks_quantity: number;
  shopify_quantity: number;
  created_at: string;
};

/**
 * The Needs-attention queue for stock: every open conflict with both
 * quantities and the location names that tell two conflicts apart. Oldest
 * first, so the queue drains in the order the storefront diverged.
 */
export async function listInventoryConflicts(
  orgId: string,
  channelId: string | null = null,
): Promise<InventoryConflictRow[]> {
  const rows = (await withOrgContext(orgId, () => db.execute<InventoryConflictDbRow>(sql`
    select k.id, k.channel_id, c.name as channel_name, k.stock_location_id,
           sl.code as stock_location_code, l.external_name,
           k.item_id, i.code as item_code, i.name as item_name,
           k.openbooks_quantity, k.shopify_quantity, k.created_at::text as created_at
      from channel_inventory_conflicts k
      join sales_channels c on c.org_id = k.org_id and c.id = k.channel_id
      join sales_channel_locations l on l.org_id = k.org_id and l.channel_id = k.channel_id
       and l.stock_location_id = k.stock_location_id
      join stock_locations sl on sl.org_id = k.org_id and sl.id = k.stock_location_id
      join items i on i.org_id = k.org_id and i.id = k.item_id
     where k.org_id = ${orgId} and k.status = 'open'
       and (${channelId}::uuid is null or k.channel_id = ${channelId})
     order by k.created_at`))).rows;
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    stockLocationId: row.stock_location_id,
    stockLocationCode: row.stock_location_code ?? row.external_name,
    externalName: row.external_name,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    openbooksQuantity: row.openbooks_quantity,
    shopifyQuantity: row.shopify_quantity,
    createdAt: row.created_at,
  }));
}

async function writeAudit(
  orgId: string,
  table: string,
  rowId: string,
  action: string,
  actor: string | null,
  before: unknown,
  after: unknown,
  reason: string | null,
): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}, ${action},
      ${JSON.stringify({ before, after, reason })}::jsonb, ${actor})`);
}

/**
 * Resolve one open conflict. Pushing OpenBooks force-sets the computed
 * quantity with a fresh compare, so a change that landed while the
 * operator decided re-conflicts instead of being overwritten. Accepting
 * Shopify rebases the baseline to the storefront quantity and records the
 * decision — native stock is never touched either way — and the pair stays
 * quiet until either side moves again.
 */
export async function resolveInventoryConflict(
  orgId: string,
  actor: string | null,
  conflictId: string,
  resolution: "pushed_openbooks" | "accepted_shopify",
  options: PushPairOptions = {},
): Promise<{ resolution: string; quantity: number }> {
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    const conflict = (await db.execute<{
      id: string;
      channel_id: string;
      stock_location_id: string;
      item_id: string;
      openbooks_quantity: number;
      shopify_quantity: number;
    }>(sql`
      select id, channel_id, stock_location_id, item_id,
             openbooks_quantity, shopify_quantity
        from channel_inventory_conflicts
       where org_id = ${orgId} and id = ${conflictId} and status = 'open'`)).rows[0];
    if (!conflict) {
      refuse(
        "channel_inventory_conflict_missing",
        "The stock conflict is already resolved or belongs to another channel.",
        "Reload the conflict queue under Channels → Locations & stock.",
        "conflictId",
      );
    }
    const access = await loadShopifyChannel(orgId, conflict.channel_id);
    const pairs = await listSyncPairs(orgId, conflict.channel_id);
    const pair = pairs.find(
      (candidate) =>
        candidate.stockLocationId === conflict.stock_location_id && candidate.itemId === conflict.item_id,
    );
    if (!pair) {
      refuse(
        "channel_inventory_pair_missing",
        "The conflict's item or location is no longer mapped for pushes.",
        "Re-link the variant and map the location under Channels, then resolve the conflict again.",
        null,
      );
    }
    const client = new ShopifyClient({
      shopDomain: access.shop,
      accessToken: access.accessToken,
      transport: options.transport,
    });
    const state = await readPushState(orgId, pair);
    const inventoryItemGid =
      state?.shopify_inventory_item_id?.trim() ||
      (await resolveShopifyInventoryItemId(client, shopifyVariantGid(pair.variantExternalId)));
    const locationGid = shopifyLocationGid(pair.externalLocationId);
    const live = await readShopifyAvailable(client, inventoryItemGid, locationGid);
    if (resolution === "accepted_shopify") {
      if (live.quantity === null) {
        refuse(
          "channel_inventory_level_missing",
          "Shopify no longer carries a level for this item at this location, so there is nothing to accept.",
          "Push OpenBooks instead to recreate the level, or re-import the locations.",
          null,
        );
      }
      await writePushState(orgId, actor, pair, {
        inventoryItemId: inventoryItemGid,
        pushed: live.quantity,
        shopify: live.quantity,
        policy: pair.stopSellingAtZero ? "deny" : "continue",
        status: "ok",
        error: null,
        at: new Date(),
      });
      const closed = await db.execute(sql`
        update channel_inventory_conflicts
           set status = 'resolved', resolution = 'accepted_shopify',
               resolved_at = now(), resolved_by = ${actor},
               updated_by = ${actor}, updated_at = now()
         where org_id = ${orgId} and id = ${conflict.id} and status = 'open'`);
      if ((closed.rowCount ?? 0) !== 1) {
        throw new Error("Channel inventory conflict matched no row; the resolution was lost");
      }
      await writeAudit(orgId, "channel_inventory_conflicts", conflict.id, "update", actor, { status: "open" }, { status: "resolved", resolution: "accepted_shopify" }, "Operator accepted the storefront quantity");
      return { resolution, quantity: live.quantity };
    }
    if (live.quantity !== null && live.quantity !== conflict.shopify_quantity) {
      await openInventoryConflict(orgId, actor, pair, conflict.openbooks_quantity, live.quantity, inventoryItemGid);
      refuse(
        "channel_inventory_conflict_moved",
        `Shopify moved again while the conflict waited (now ${live.quantity}); the queue shows the fresh quantities.`,
        "Decide again from the refreshed conflict row under Channels → Locations & stock.",
        null,
      );
    }
    await setShopifyAvailable(client, {
      inventoryItemGid,
      locationGid,
      quantity: conflict.openbooks_quantity,
      compareQuantity: live.quantity,
      referenceUri: pushReferenceUri(pair),
    });
    await writePushState(orgId, actor, pair, {
      inventoryItemId: inventoryItemGid,
      pushed: conflict.openbooks_quantity,
      shopify: conflict.openbooks_quantity,
      policy: pair.stopSellingAtZero ? "deny" : "continue",
      status: "ok",
      error: null,
      at: new Date(),
    });
    const closed = await db.execute(sql`
      update channel_inventory_conflicts
         set status = 'resolved', resolution = 'pushed_openbooks',
             resolved_at = now(), resolved_by = ${actor},
             updated_by = ${actor}, updated_at = now()
       where org_id = ${orgId} and id = ${conflict.id} and status = 'open'`);
    if ((closed.rowCount ?? 0) !== 1) {
      throw new Error("Channel inventory conflict matched no row; the resolution was lost");
    }
    await writeAudit(orgId, "channel_inventory_conflicts", conflict.id, "update", actor, { status: "open" }, { status: "resolved", resolution: "pushed_openbooks" }, "Operator pushed the OpenBooks quantity");
    return { resolution, quantity: conflict.openbooks_quantity };
  });
}

/**
 * Fix-all-similar for the queue: resolve every open conflict of the
 * channel with the same remedy. One conflict that moved underneath fails
 * that row and the rest still resolve; the counts say what happened.
 */
export async function resolveAllInventoryConflicts(
  orgId: string,
  actor: string | null,
  channelId: string,
  resolution: "pushed_openbooks" | "accepted_shopify",
  options: PushPairOptions = {},
): Promise<{ resolved: number; failed: number }> {
  const open = await listInventoryConflicts(orgId, channelId);
  let resolved = 0;
  let failed = 0;
  for (const conflict of open) {
    try {
      await resolveInventoryConflict(orgId, actor, conflict.id, resolution, options);
      resolved += 1;
    } catch {
      failed += 1;
    }
  }
  return { resolved, failed };
}

export interface LocationSyncState {
  stockLocationId: string;
  stockLocationCode: string;
  externalLocationId: string;
  externalName: string;
  syncInventory: boolean;
  bufferQuantity: string;
  stopSellingAtZero: boolean;
  mappedPairs: number;
  lastPushedAt: string | null;
  openConflicts: number;
  errorPairs: number;
  pendingPairs: number;
}

/**
 * Per-location sync state for the Locations & stock tab: the policy, the
 * last push across its pairs, and the drift counts that tell the operator
 * where attention is owed.
 */
export async function listLocationSyncStates(
  orgId: string,
  channelId: string,
): Promise<LocationSyncState[]> {
  const rows = (await withOrgContext(orgId, () => db.execute<
    Record<string, unknown> & {
      stock_location_id: string | null;
      stock_location_code: string | null;
      external_location_id: string;
      external_name: string;
      sync_inventory: boolean;
      buffer_quantity: string;
      stop_selling_at_zero: boolean;
      mapped_pairs: string;
      last_pushed_at: string | null;
      open_conflicts: string;
      error_pairs: string;
      pending_pairs: string;
    }
  >(sql`
    select l.stock_location_id, sl.code as stock_location_code,
           l.external_location_id, l.external_name, l.sync_inventory,
           l.buffer_quantity::text as buffer_quantity,
           l.stop_selling_at_zero,
           count(distinct v.native_id)::text as mapped_pairs,
           max(s.last_pushed_at)::text as last_pushed_at,
           count(distinct case when k.status = 'open' then k.id end)::text as open_conflicts,
           count(distinct case when s.last_status = 'error' then s.item_id end)::text as error_pairs,
           count(distinct case when s.id is null then v.native_id end)::text as pending_pairs
      from sales_channel_locations l
      join sales_channels c on c.org_id = l.org_id and c.id = l.channel_id
      left join stock_locations sl on sl.org_id = l.org_id and sl.id = l.stock_location_id
      left join external_links v on v.org_id = l.org_id and v.provider = 'shopify'
       and v.external_account = c.external_account and v.object_type = 'variant'
       and v.native_table = 'items'
      left join channel_inventory_push_states s on s.org_id = l.org_id
       and s.channel_id = l.channel_id and s.stock_location_id = l.stock_location_id
       and s.item_id = v.native_id
      left join channel_inventory_conflicts k on k.org_id = l.org_id
       and k.channel_id = l.channel_id and k.stock_location_id = l.stock_location_id
       and k.item_id = v.native_id and k.status = 'open'
     where l.org_id = ${orgId} and l.channel_id = ${channelId}
     group by l.stock_location_id, sl.code, l.external_location_id, l.external_name,
              l.sync_inventory, l.buffer_quantity, l.stop_selling_at_zero
     order by l.external_name`))).rows;
  return rows.map((row) => ({
    stockLocationId: row.stock_location_id ?? "",
    stockLocationCode: row.stock_location_code ?? row.external_name,
    externalLocationId: row.external_location_id,
    externalName: row.external_name,
    syncInventory: row.sync_inventory,
    bufferQuantity: row.buffer_quantity,
    stopSellingAtZero: row.stop_selling_at_zero,
    mappedPairs: Number(row.mapped_pairs),
    lastPushedAt: row.last_pushed_at,
    openConflicts: Number(row.open_conflicts),
    errorPairs: Number(row.error_pairs),
    pendingPairs: Number(row.pending_pairs),
  }));
}

export interface ItemChannelStockRow {
  channelId: string;
  channelName: string;
  externalLocationId: string;
  externalName: string;
  stockLocationCode: string;
  available: string;
  bufferQuantity: string;
  stopSellingAtZero: boolean;
  sellable: number;
  availabilityError: string | null;
  lastPushedQuantity: number | null;
  lastShopifyQuantity: number | null;
  lastPushedAt: string | null;
  lastStatus: string;
  conflict: { openbooksQuantity: number; shopifyQuantity: number } | null;
}

/**
 * One item's storefront stock across every channel and location: the live
 * available to promise beside the last push, for the item drawer's channel
 * section. Read-only; policy changes happen from the channel side.
 */
export async function listItemChannelStock(orgId: string, itemId: string): Promise<ItemChannelStockRow[]> {
  const pairs = (await withOrgContext(orgId, () => db.execute<
    Record<string, unknown> & {
      channel_id: string;
      channel_name: string;
      subsidiary_id: string | null;
      stock_location_id: string;
      stock_location_code: string | null;
      external_location_id: string;
      external_name: string;
      location_buffer: string;
      policy_buffer: string | null;
      policy_stop: boolean | null;
      policy_sync: boolean | null;
      location_stop: boolean;
      pushed: number | null;
      shopify: number | null;
      pushed_at: string | null;
      status: string | null;
      conflict_openbooks: number | null;
      conflict_shopify: number | null;
    }
  >(sql`
    select c.id as channel_id, c.name as channel_name, c.subsidiary_id,
           l.stock_location_id, sl.code as stock_location_code,
           l.external_location_id, l.external_name,
           l.buffer_quantity::text as location_buffer,
           p.buffer_quantity::text as policy_buffer,
           p.stop_selling_at_zero as policy_stop, p.sync_inventory as policy_sync,
           l.stop_selling_at_zero as location_stop,
           s.last_pushed_quantity as pushed, s.last_shopify_quantity as shopify,
           s.last_pushed_at::text as pushed_at, s.last_status as status,
           k.openbooks_quantity as conflict_openbooks, k.shopify_quantity as conflict_shopify
      from sales_channel_locations l
      join sales_channels c on c.org_id = l.org_id and c.id = l.channel_id
      join external_links v on v.org_id = l.org_id and v.provider = 'shopify'
       and v.external_account = c.external_account and v.object_type = 'variant'
       and v.native_table = 'items' and v.native_id = ${itemId}
      left join stock_locations sl on sl.org_id = l.org_id and sl.id = l.stock_location_id
      left join channel_item_inventory_policies p on p.org_id = l.org_id
       and p.channel_id = l.channel_id and p.item_id = v.native_id
      left join channel_inventory_push_states s on s.org_id = l.org_id
       and s.channel_id = l.channel_id and s.stock_location_id = l.stock_location_id
       and s.item_id = v.native_id
      left join channel_inventory_conflicts k on k.org_id = l.org_id
       and k.channel_id = l.channel_id and k.stock_location_id = l.stock_location_id
       and k.item_id = v.native_id and k.status = 'open'
     where l.org_id = ${orgId} and l.sync_inventory and l.stock_location_id is not null
       and coalesce(p.sync_inventory, true)
     order by c.name, l.external_name`))).rows;
  const out: ItemChannelStockRow[] = [];
  for (const row of pairs) {
    // A pair the engine cannot measure names its cause instead of
    // reporting a zero that reads as correctly nil.
    let available = "0.0000";
    const channelSubsidiary = row.subsidiary_id;
    let availabilityError: string | null = channelSubsidiary
      ? null
      : `Channel "${row.channel_name}" names no subsidiary, so available to promise has no legal entity to measure.`;
    if (channelSubsidiary) {
      try {
        const [terms] = await withOrgContext(orgId, () =>
          listAvailableToPromise(db, orgId, {
            subsidiaryId: channelSubsidiary,
            stockLocationIds: [row.stock_location_id],
            itemIds: [itemId],
          }),
        );
        if (terms) available = terms.available;
        else availabilityError = "This item carries no stock: it has no inventory costing profile.";
      } catch (error) {
        availabilityError =
          error instanceof CommerceError || error instanceof Error
            ? error.message
            : "Available to promise could not be measured for this location.";
      }
    }
    const buffer = row.policy_buffer ?? row.location_buffer;
    let sellable = 0;
    try {
      sellable = availabilityError ? 0 : sellableQuantity(available, buffer).pushQuantity;
    } catch {
      sellable = 0;
    }
    out.push({
      channelId: row.channel_id,
      channelName: row.channel_name,
      externalLocationId: row.external_location_id,
      externalName: row.external_name,
      stockLocationCode: row.stock_location_code ?? row.external_name,
      available,
      bufferQuantity: buffer,
      stopSellingAtZero: row.policy_stop ?? row.location_stop,
      sellable,
      availabilityError,
      lastPushedQuantity: row.pushed,
      lastShopifyQuantity: row.shopify,
      lastPushedAt: row.pushed_at,
      lastStatus: row.status ?? "pending",
      conflict:
        row.conflict_openbooks === null || row.conflict_shopify === null
          ? null
          : { openbooksQuantity: row.conflict_openbooks, shopifyQuantity: row.conflict_shopify },
    });
  }
  return out;
}

export interface ItemPolicyRow {
  itemId: string;
  itemCode: string | null;
  itemName: string;
  bufferQuantity: string | null;
  stopSellingAtZero: boolean | null;
  syncInventory: boolean;
}

/** Every per-item override on a channel, with item labels, for the advanced policy editor. */
export async function listItemInventoryPolicies(orgId: string, channelId: string): Promise<ItemPolicyRow[]> {
  const rows = (await withOrgContext(orgId, () => db.execute<
    Record<string, unknown> & {
      item_id: string;
      item_code: string | null;
      item_name: string;
      buffer_quantity: string | null;
      stop_selling_at_zero: boolean | null;
      sync_inventory: boolean;
    }
  >(sql`
    select p.item_id, i.code as item_code, i.name as item_name,
           p.buffer_quantity::text as buffer_quantity,
           p.stop_selling_at_zero, p.sync_inventory
      from channel_item_inventory_policies p
      join items i on i.org_id = p.org_id and i.id = p.item_id
     where p.org_id = ${orgId} and p.channel_id = ${channelId}
     order by i.code`))).rows;
  return rows.map((row) => ({
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    bufferQuantity: row.buffer_quantity,
    stopSellingAtZero: row.stop_selling_at_zero,
    syncInventory: row.sync_inventory,
  }));
}

export interface ItemInventoryPolicyInput {
  channelId: string;
  itemId: string;
  /** Null clears the override back to the location value. */
  bufferQuantity?: string | null;
  stopSellingAtZero?: boolean | null;
  syncInventory?: boolean;
}

function cleanDecimal(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    refuse(
      "channel_inventory_buffer_invalid",
      "The keep-back buffer is not a quantity OpenBooks can hold.",
      "Enter the buffer as whole units (for example 2), or clear it to inherit the location value.",
      "bufferQuantity",
    );
  }
  return value.trim();
}

/**
 * Save a per-item override of the location policy. All-null clears the row
 * back to full inheritance; a write that changes nothing still succeeds,
 * because the operator's intent (inherit) is already true.
 */
export async function upsertItemInventoryPolicy(
  orgId: string,
  actor: string | null,
  input: ItemInventoryPolicyInput,
): Promise<void> {
  const buffer = cleanDecimal(input.bufferQuantity ?? null);
  const stop = input.stopSellingAtZero ?? null;
  const sync = input.syncInventory ?? true;
  await withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    const channel = (await db.execute<{ id: string }>(sql`
      select id from sales_channels where org_id = ${orgId} and id = ${input.channelId}`)).rows[0];
    if (!channel) {
      refuse(
        "channel_not_found",
        "The sales channel does not belong to this organization.",
        "Choose a channel in this organization, or connect it first under Channels.",
        "channelId",
      );
    }
    const item = (await db.execute<{ id: string }>(sql`
      select id from items where org_id = ${orgId} and id = ${input.itemId}`)).rows[0];
    if (!item) {
      refuse(
        "channel_inventory_item_missing",
        "The item does not belong to this organization.",
        "Choose an item in this organization.",
        "itemId",
      );
    }
    if (buffer !== null) sellableQuantity("0.0000", buffer);
    if (buffer === null && stop === null && sync) {
      // Clearing an override that was never set already holds: full
      // inheritance is true with zero rows, so the delete's row count is
      // not the success signal here — the end state is.
      await db.execute(sql`
        delete from channel_item_inventory_policies
         where org_id = ${orgId} and channel_id = ${input.channelId} and item_id = ${input.itemId}`);
      return;
    }
    // Re-saving an override is expected and benign: the item's row carries
    // the latest decision, so a repeat delivery refreshes it in place.
    const written = await db.execute(sql`
      insert into channel_item_inventory_policies
        (org_id, channel_id, item_id, buffer_quantity, stop_selling_at_zero,
         sync_inventory, created_by, updated_by)
      values (${orgId}, ${input.channelId}, ${input.itemId},
        ${buffer}, ${stop}, ${sync}, ${actor}, ${actor})
      on conflict (org_id, channel_id, item_id) do update set
        buffer_quantity = excluded.buffer_quantity,
        stop_selling_at_zero = excluded.stop_selling_at_zero,
        sync_inventory = excluded.sync_inventory,
        updated_by = excluded.updated_by, updated_at = now()`);
    if ((written.rowCount ?? 0) !== 1) {
      throw new Error("Channel item policy matched no row; the override was lost");
    }
  });
}
