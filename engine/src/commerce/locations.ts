import { sql } from "drizzle-orm";
import { cmp, normalizeDecimal } from "../money/money.ts";
import { CommerceError } from "./errors.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { db, withOrg } from "../platform/db.ts";

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

export interface ChannelLocationRow {
  id: string;
  channelId: string;
  externalLocationId: string;
  externalName: string;
  stockLocationId: string | null;
  syncInventory: boolean;
  fulfilsOrders: boolean;
  /** Whole or fractional units held back from the storefront, exact decimal text. */
  bufferQuantity: string;
  stopSellingAtZero: boolean;
}

export interface UpsertChannelLocationInput {
  channelId: string;
  externalLocationId: string;
  externalName: string;
  stockLocationId?: string | null;
  syncInventory?: boolean;
  fulfilsOrders?: boolean;
  bufferQuantity?: string | null;
  stopSellingAtZero?: boolean;
}

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new CommerceError(code, message, remedy, { field, status });
}

async function requireFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
    refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
  }
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The keep-back buffer as exact decimal text. Null inherits the safe
 * default of holding nothing back; a value nobody typed refuses by name
 * instead of pushing a guessed quantity.
 */
function cleanBuffer(value: string | null): string {
  if (value === null) return "0.0000";
  const trimmed = typeof value === "string" ? value.trim() : "";
  let buffer: string;
  try {
    buffer = normalizeDecimal(trimmed, 4);
  } catch {
    refuse(
      "channel_inventory_buffer_invalid",
      `The keep-back buffer "${trimmed.slice(0, 40)}" is not a quantity OpenBooks can hold.`,
      "Enter the buffer as whole units (for example 2) under Channels → Locations & stock.",
      "bufferQuantity",
    );
  }
  if (cmp(buffer, "0.0000") < 0) {
    refuse(
      "channel_inventory_buffer_invalid",
      "The keep-back buffer cannot hold back less than nothing.",
      "Enter zero or more units under Channels → Locations & stock.",
      "bufferQuantity",
    );
  }
  return buffer;
}

async function requireChannel(orgId: string, channelId: string): Promise<void> {
  const row = (await db.execute<{ id: string }>(sql`
    select id from sales_channels where org_id = ${orgId} and id = ${channelId}`)).rows[0];
  if (!row) {
    refuse(
      "channel_not_found",
      "The sales channel does not belong to this organization.",
      "Choose a channel in this organization, or connect it first under Channels.",
      "channelId",
    );
  }
}

interface LocationDbRow extends Record<string, unknown> {
  id: string;
  channel_id: string;
  external_location_id: string;
  external_name: string;
  stock_location_id: string | null;
  sync_inventory: boolean;
  fulfils_orders: boolean;
  buffer_quantity: string;
  stop_selling_at_zero: boolean;
}

function toRow(row: LocationDbRow): ChannelLocationRow {
  return {
    id: row.id,
    channelId: row.channel_id,
    externalLocationId: row.external_location_id,
    externalName: row.external_name,
    stockLocationId: row.stock_location_id,
    syncInventory: row.sync_inventory,
    fulfilsOrders: row.fulfils_orders,
    bufferQuantity: row.buffer_quantity,
    stopSellingAtZero: row.stop_selling_at_zero,
  };
}

const LOCATION_COLUMNS = sql`id, channel_id, external_location_id, external_name, stock_location_id, sync_inventory, fulfils_orders, buffer_quantity, stop_selling_at_zero`;

async function writeAudit(
  orgId: string,
  locationId: string,
  action: string,
  actor: string,
  before: unknown,
  after: unknown,
  reason: string | null,
): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'sales_channel_locations', ${locationId}, ${action},
      ${JSON.stringify({ before, after, reason })}::jsonb, ${actor})`);
}

/**
 * Point one storefront location at the stock location that fulfils it. A
 * re-sync of the same storefront location updates the mapping in place.
 */
export async function upsertChannelLocation(
  orgId: string,
  actor: string,
  input: UpsertChannelLocationInput,
): Promise<ChannelLocationRow> {
  const externalLocationId = cleanText(input.externalLocationId);
  if (!externalLocationId) {
    refuse("channel_location_id_missing", "A channel location needs the storefront's location id.", "Enter the location id the storefront reports for this location.", "externalLocationId");
  }
  const externalName = cleanText(input.externalName);
  if (!externalName) {
    refuse("channel_location_name_missing", "A channel location needs a name.", "Name the location as the storefront shows it.", "externalName");
  }
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    await requireChannel(orgId, input.channelId);
    if (input.stockLocationId) {
      const stock = (await db.execute<{ id: string }>(sql`
        select id from stock_locations where org_id = ${orgId} and id = ${input.stockLocationId}`)).rows[0];
      if (!stock) {
        refuse(
          "channel_location_stock_unavailable",
          "The stock location does not belong to this organization.",
          "Choose a stock location in this organization, or create one from the location row.",
          "stockLocationId",
        );
      }
    }
    const syncInventory = input.syncInventory ?? true;
    const fulfilsOrders = input.fulfilsOrders ?? true;
    const bufferQuantity = cleanBuffer(input.bufferQuantity ?? null);
    const stopSellingAtZero = input.stopSellingAtZero ?? true;
    const before = (await db.execute<LocationDbRow>(sql`
      select ${LOCATION_COLUMNS} from sales_channel_locations
       where org_id = ${orgId} and channel_id = ${input.channelId}
         and external_location_id = ${externalLocationId}`)).rows[0] ?? null;
    // Re-syncing a known storefront location is expected and benign: the natural key
    // (channel, storefront location) identifies one mapping, so a repeat delivery
    // refreshes it instead of inserting a duplicate.
    const upserted = (await db.execute<LocationDbRow>(sql`
      insert into sales_channel_locations
        (org_id, channel_id, external_location_id, external_name,
         stock_location_id, sync_inventory, fulfils_orders,
         buffer_quantity, stop_selling_at_zero, created_by, updated_by)
      values (${orgId}, ${input.channelId}, ${externalLocationId}, ${externalName},
        ${input.stockLocationId ?? null}, ${syncInventory}, ${fulfilsOrders},
        ${bufferQuantity}, ${stopSellingAtZero}, ${actor}, ${actor})
      on conflict (org_id, channel_id, external_location_id) do update set
        external_name = excluded.external_name,
        stock_location_id = excluded.stock_location_id,
        sync_inventory = excluded.sync_inventory,
        fulfils_orders = excluded.fulfils_orders,
        buffer_quantity = excluded.buffer_quantity,
        stop_selling_at_zero = excluded.stop_selling_at_zero,
        updated_by = excluded.updated_by,
        updated_at = now()
      returning ${LOCATION_COLUMNS}`)).rows[0];
    if (!upserted) throw new Error("Channel location write returned no row; the mapping was lost");
    const after = toRow(upserted);
    await writeAudit(orgId, after.id, before ? "update" : "insert", actor, before ? toRow(before) : null, after, null);
    return after;
  });
}

export async function listChannelLocations(orgId: string, channelId: string): Promise<ChannelLocationRow[]> {
  return withOrg(orgId, async () => {
    await requireChannel(orgId, channelId);
    const rows = (await db.execute<LocationDbRow>(sql`
      select ${LOCATION_COLUMNS} from sales_channel_locations
       where org_id = ${orgId} and channel_id = ${channelId}
       order by external_name`)).rows;
    return rows.map(toRow);
  });
}

/**
 * Detach a storefront location from its stock location. Detaching never
 * deletes inventory; the stock location keeps its history.
 */
export async function unlinkChannelLocation(
  orgId: string,
  actor: string,
  channelId: string,
  externalLocationId: string,
  reason: unknown,
): Promise<void> {
  const clean = cleanText(reason);
  if (!clean) {
    refuse(
      "channel_location_reason_missing",
      "A reason is required to detach a channel location.",
      "Explain why the storefront location no longer maps to this stock location.",
      "reason",
    );
  }
  await withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    await requireChannel(orgId, channelId);
    const before = (await db.execute<LocationDbRow>(sql`
      select ${LOCATION_COLUMNS} from sales_channel_locations
       where org_id = ${orgId} and channel_id = ${channelId}
         and external_location_id = ${externalLocationId}`)).rows[0];
    if (!before) {
      refuse(
        "channel_location_not_found",
        `Storefront location "${externalLocationId}" is not mapped for this channel.`,
        "Refresh the channel's locations, then detach the location shown.",
        "externalLocationId",
      );
    }
    const deleted = await db.execute(sql`
      delete from sales_channel_locations
       where org_id = ${orgId} and channel_id = ${channelId}
         and external_location_id = ${externalLocationId}`);
    if ((deleted.rowCount ?? 0) !== 1) throw new Error("Channel location detach matched no row; the mapping was lost");
    await writeAudit(orgId, before.id, "delete", actor, toRow(before), null, clean);
  });
}
