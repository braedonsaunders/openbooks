import { sql } from "drizzle-orm";
import { ShopifyClient } from "../../connectors/shopify.ts";
import { loadShopifyChannel, type ShopifyChannelAccess } from "./channel-access.ts";
import { CommerceError } from "../errors.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../../organization/org-feature-lock.ts";
import { db, withOrg, withOrgContext } from "../../platform/db.ts";

/**
 * Shopify locations: the storefront's fulfilment points mapped to native
 * stock locations. Import stores every Shopify location and auto-matches
 * unambiguous names; the operator maps the rest on the Locations tab.
 * An unmapped location parks orders in the exception queue — it never
 * invents a stock movement.
 */

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new CommerceError(code, message, remedy, { field, status });
}

async function requireFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
    refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
  }
}

export interface ShopifyLocationNode {
  externalId: string;
  name: string;
  active: boolean;
}

const LOCATIONS_QUERY = `query shopifyLocations($after: String) {
  locations(first: 100, after: $after) {
    edges {
      node { id name active }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export interface LocationImportResult {
  locations: number;
  autoMatched: number;
  ambiguous: { shopifyName: string; candidates: string[] }[];
}

export async function importShopifyLocations(
  orgId: string,
  actorId: string | null,
  channelId: string,
  options: { transport?: typeof fetch } = {},
): Promise<LocationImportResult> {
  // Pages stream from Shopify between short per-location write units, so
  // the import never holds a transaction open across network calls.
  if (!(await orgFeatureEnabled(orgId, "salesChannels"))) {
    refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
  }
  const channel = await loadShopifyChannel(orgId, channelId);
  const client = new ShopifyClient({
    shopDomain: channel.shop,
    accessToken: channel.accessToken,
    transport: options.transport,
  });
  const result: LocationImportResult = { locations: 0, autoMatched: 0, ambiguous: [] };
  for await (const node of client.paginate<Record<string, unknown>>(
    LOCATIONS_QUERY,
    {},
    (data) =>
      (data as { locations: { edges: { node: Record<string, unknown> }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } })
        .locations,
  )) {
    const { numericId, name } = normalizeLocationNode(node);
    const matched = await withOrg(orgId, async () => {
      await acquireOrgFeatureGateLock(db, orgId);
      await requireFeature(orgId);
      return upsertChannelLocation(orgId, actorId, channel, numericId, name);
    });
    result.locations += 1;
    if (matched === "matched") result.autoMatched += 1;
    else if (matched !== "unmapped") result.ambiguous.push(matched);
  }
  return result;
}

function normalizeLocationNode(node: Record<string, unknown>): { numericId: string; name: string } {
  const raw = typeof node.id === "string" ? node.id : "";
  const numericId = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw.trim();
  const name = typeof node.name === "string" && node.name.trim() !== "" ? node.name.trim() : `Location ${numericId}`;
  if (!/^\d+$/.test(numericId)) {
    refuse(
      "shopify_location_unreadable",
      "Shopify sent a location without a usable id.",
      "Re-import the locations; if this repeats, the storefront sent a location OpenBooks cannot identify.",
      "externalLocationId",
    );
  }
  return { numericId, name };
}

type UpsertMatch = "matched" | "unmapped" | { shopifyName: string; candidates: string[] };

async function upsertChannelLocation(
  orgId: string,
  actorId: string | null,
  channel: ShopifyChannelAccess,
  externalLocationId: string,
  externalName: string,
): Promise<UpsertMatch> {
  // A re-import racing the first store is an expected unique-key collision;
  // re-read below to return the winner instead of dropping the write.
  const inserted = await db.execute<{ id: string }>(sql`
    insert into sales_channel_locations
      (org_id, channel_id, external_location_id, external_name, created_by, updated_by)
    values (${orgId}, ${channel.channelId}, ${externalLocationId}, ${externalName}, ${actorId}, ${actorId})
    on conflict (org_id, channel_id, external_location_id) do nothing
    returning id`);
  const id =
    inserted.rows[0]?.id ??
    (
      await db.execute<{ id: string }>(sql`
        select id from sales_channel_locations
         where org_id = ${orgId} and channel_id = ${channel.channelId}
           and external_location_id = ${externalLocationId}`)
    ).rows[0]?.id;
  if (!id) throw new Error("Channel location store returned no row; the location was lost");
  const renamed = await db.execute<{ stock_location_id: string | null }>(sql`
    update sales_channel_locations
       set external_name = ${externalName}, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and id = ${id}
     returning stock_location_id`);
  if (renamed.rows.length !== 1) {
    throw new Error("Channel location refresh matched no row; the location left while it imported");
  }
  if (renamed.rows[0]?.stock_location_id) return "matched";
  const candidates = await findStockCandidates(orgId, externalName);
  if (candidates.length === 1 && candidates[0]) {
    const mapped = await db.execute(sql`
      update sales_channel_locations
         set stock_location_id = ${candidates[0].id}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${id} and stock_location_id is null`);
    if ((mapped.rowCount ?? 0) === 1) return "matched";
    return "matched";
  }
  if (candidates.length > 1) {
    return { shopifyName: externalName, candidates: candidates.map((candidate) => candidate.label) };
  }
  return "unmapped";
}

interface StockCandidate {
  id: string;
  label: string;
}

/**
 * Exactly one stock location whose code or dimension name equals the
 * Shopify name (case-insensitive) auto-matches; zero or several leave the
 * row for the operator instead of guessing.
 */
async function findStockCandidates(orgId: string, shopifyName: string): Promise<StockCandidate[]> {
  const rows = (
    await db.execute<{ id: string; code: string; name: string }>(sql`
      select sl.id, sl.code, l.name
        from stock_locations sl
        join locations l on l.org_id = sl.org_id and l.id = sl.location_id
       where sl.org_id = ${orgId} and sl.is_active
         and (lower(sl.code) = lower(${shopifyName}) or lower(l.name) = lower(${shopifyName}))`)
  ).rows;
  return rows.map((row) => ({ id: row.id, label: `${row.name} (${row.code})` }));
}

export interface ChannelLocationRow {
  id: string;
  externalLocationId: string;
  externalName: string;
  stockLocationId: string | null;
  stockLabel: string | null;
  syncInventory: boolean;
  fulfilsOrders: boolean;
}

export async function listChannelLocations(orgId: string, channelId: string): Promise<ChannelLocationRow[]> {
  const rows = (
    await withOrgContext(orgId, () =>
      db.execute<{
        id: string;
        external_location_id: string;
        external_name: string;
        stock_location_id: string | null;
        stock_code: string | null;
        stock_name: string | null;
        sync_inventory: boolean;
        fulfils_orders: boolean;
      }>(sql`
        select scl.id, scl.external_location_id, scl.external_name, scl.stock_location_id,
               sl.code as stock_code, l.name as stock_name, scl.sync_inventory, scl.fulfils_orders
          from sales_channel_locations scl
          left join stock_locations sl
            on sl.org_id = scl.org_id and sl.id = scl.stock_location_id
          left join locations l
            on l.org_id = sl.org_id and l.id = sl.location_id
         where scl.org_id = ${orgId} and scl.channel_id = ${channelId}
         order by scl.external_name`),
    )
  ).rows;
  return rows.map((row) => ({
    id: row.id,
    externalLocationId: row.external_location_id,
    externalName: row.external_name,
    stockLocationId: row.stock_location_id,
    stockLabel: row.stock_location_id ? `${row.stock_name ?? "?"} (${row.stock_code ?? "?"})` : null,
    syncInventory: row.sync_inventory,
    fulfilsOrders: row.fulfils_orders,
  }));
}

export interface MapLocationInput {
  stockLocationId: string | null;
  syncInventory?: boolean;
  fulfilsOrders?: boolean;
}

/**
 * Map a storefront location to its stock location with its sync flags.
 * A null stock location unmaps but keeps the row; the update must hit or
 * it refuses instead of reporting a silent success.
 */
export async function mapChannelLocation(
  orgId: string,
  actorId: string,
  channelId: string,
  externalLocationId: string,
  input: MapLocationInput,
): Promise<ChannelLocationRow> {
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    await loadShopifyChannel(orgId, channelId);
    if (input.stockLocationId) {
      const stock = (
        await db.execute<{ id: string }>(sql`
          select id from stock_locations where org_id = ${orgId} and id = ${input.stockLocationId}`)
      ).rows[0];
      if (!stock) {
        refuse(
          "channel_location_stock_unavailable",
          "The stock location does not belong to this organization.",
          "Choose a stock location in this organization, or leave the Shopify location unmapped.",
          "stockLocationId",
        );
      }
    }
    const updated = await db.execute<{
      id: string;
      external_location_id: string;
      external_name: string;
      stock_location_id: string | null;
      sync_inventory: boolean;
      fulfils_orders: boolean;
    }>(sql`
      update sales_channel_locations
         set stock_location_id = ${input.stockLocationId},
             sync_inventory = ${input.syncInventory ?? true},
             fulfils_orders = ${input.fulfilsOrders ?? false},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and channel_id = ${channelId}
         and external_location_id = ${externalLocationId}
       returning id, external_location_id, external_name, stock_location_id, sync_inventory, fulfils_orders`);
    if (updated.rows.length !== 1 || !updated.rows[0]) {
      refuse(
        "channel_location_not_found",
        `Shopify location "${externalLocationId}" is not imported for this channel.`,
        "Re-import the locations under Channels, then map the location.",
        "externalLocationId",
      );
    }
    const row = updated.rows[0];
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'sales_channel_locations', ${row.id}, 'update',
        ${JSON.stringify({ before: null, after: row, reason: "Operator location mapping" })}::jsonb, ${actorId})`);
    const listed = await listChannelLocations(orgId, channelId);
    const current = listed.find((entry) => entry.id === row.id);
    if (!current) throw new Error("Channel location mapping lost its row; the mapping was not stored");
    return current;
  });
}

/**
 * Apply a Shopify locations webhook: create/update upserts the row (never
 * touching the operator's mapping), delete removes the row only while it
 * is still unmapped — a mapped row keeps its link and reports the
 * deletion for the operator to resolve.
 */
export async function applyLocationWebhook(
  orgId: string,
  actorId: string | null,
  channel: ShopifyChannelAccess,
  topic: string,
  payload: Record<string, unknown>,
): Promise<{ action: string; externalLocationId: string }> {
  const raw = typeof payload.id === "string" ? payload.id : typeof payload.id === "number" ? String(payload.id) : "";
  const numericId = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw.trim();
  if (!/^\d+$/.test(numericId)) {
    refuse(
      "shopify_location_unreadable",
      "The Shopify location delivery holds no usable location id.",
      "Ask Shopify to resend the webhook from Settings → Notifications.",
      "topic",
    );
  }
  if (topic === "locations/delete") {
    const deleted = await db.execute<{ id: string; stock_location_id: string | null }>(sql`
      delete from sales_channel_locations
       where org_id = ${orgId} and channel_id = ${channel.channelId}
         and external_location_id = ${numericId} and stock_location_id is null
       returning id, stock_location_id`);
    if ((deleted.rowCount ?? 0) === 1) return { action: "removed", externalLocationId: numericId };
    const mapped = (
      await db.execute<{ id: string }>(sql`
        select id from sales_channel_locations
         where org_id = ${orgId} and channel_id = ${channel.channelId}
           and external_location_id = ${numericId}`)
    ).rows[0];
    if (mapped) {
      return { action: "kept_mapped", externalLocationId: numericId };
    }
    return { action: "unknown", externalLocationId: numericId };
  }
  const name =
    typeof payload.name === "string" && payload.name.trim() !== ""
      ? payload.name.trim().slice(0, 500)
      : `Location ${numericId}`;
  await upsertChannelLocation(orgId, actorId, channel, numericId, name);
  return { action: topic === "locations/create" ? "created" : "updated", externalLocationId: numericId };
}
