import { sql } from "drizzle-orm";
import { CHANNEL_ACCOUNT_ROLES, type ChannelAccountRole } from "./contracts.ts";
import { CommerceError } from "./errors.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { db, withOrg } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

export interface AccountMapRow {
  id: string;
  channelId: string;
  role: ChannelAccountRole;
  key: string;
  accountId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface UpsertAccountMapInput {
  channelId: string;
  role: string;
  /** Gateway name or tax jurisdiction; '' when the role is not keyed. */
  key?: string;
  accountId: string;
  effectiveFrom: string;
}

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new CommerceError(code, message, remedy, { field, status });
}

function checkRole(role: string): ChannelAccountRole {
  if ((CHANNEL_ACCOUNT_ROLES as readonly string[]).includes(role)) return role as ChannelAccountRole;
  refuse(
    "channel_map_role_unknown",
    `Posting role "${role}" is not a channel posting role.`,
    `Choose one of ${CHANNEL_ACCOUNT_ROLES.join(", ")}.`,
    "role",
  );
}

function checkDate(value: string): void {
  if (!isIsoCalendarDate(value)) {
    refuse(
      "channel_map_date_invalid",
      `Effective date "${value}" is not a calendar date.`,
      "Enter the effective date as YYYY-MM-DD.",
      "effectiveFrom",
    );
  }
}

interface MapDbRow extends Record<string, unknown> {
  id: string;
  channel_id: string;
  role: ChannelAccountRole;
  key: string;
  account_id: string;
  effective_from: string;
  effective_to: string | null;
}

function toRow(row: MapDbRow): AccountMapRow {
  return {
    id: row.id,
    channelId: row.channel_id,
    role: row.role,
    key: row.key,
    accountId: row.account_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

const MAP_COLUMNS = sql`id, channel_id, role, key, account_id, effective_from, effective_to`;

/**
 * Resolve the posting account in force for (channel, role, key) on a date.
 * An unmapped role refuses by name — posting code never invents a fallback
 * account, so an unconfigured channel parks instead of mis-posting.
 */
export async function resolveAccountMap(
  orgId: string,
  channelId: string,
  role: string,
  key: string,
  date: string,
): Promise<string> {
  const roleValue = checkRole(role);
  checkDate(date);
  const rows = (await db.execute<MapDbRow>(sql`
    select ${MAP_COLUMNS} from sales_channel_account_maps
     where org_id = ${orgId} and channel_id = ${channelId}
       and role = ${roleValue} and key = ${key}
       and effective_from <= ${date}
       and (effective_to is null or effective_to >= ${date})`)).rows;
  if (rows.length > 1) {
    throw new Error(
      `Overlapping account maps for channel ${channelId} role ${roleValue} key "${key}" on ${date}; storage must hold exactly one open row`,
    );
  }
  const row = rows[0];
  if (!row) {
    const channel = (await db.execute<{ name: string }>(sql`
      select name from sales_channels where org_id = ${orgId} and id = ${channelId}`)).rows[0];
    refuse(
      "channel_map_unmapped",
      channel
        ? `Channel "${channel.name}" has no ${roleValue} account${key ? ` for "${key}"` : ""} in force on ${date}.`
        : `Channel ${channelId} has no ${roleValue} account${key ? ` for "${key}"` : ""} in force on ${date}.`,
      "Map this role under Channels → Settings → Posting accounts, effective on or before the posting date.",
      "role",
    );
  }
  return row.account_id;
}

/**
 * Map a posting account from a date, closing the prior open row the day
 * before. The prior row is locked before it is closed, so two concurrent
 * remaps serialize instead of overlapping — and the EXCLUDE constraint
 * arbitrates the race storage cannot see.
 */
export async function upsertAccountMap(
  orgId: string,
  actor: string,
  input: UpsertAccountMapInput,
): Promise<AccountMapRow> {
  const role = checkRole(input.role);
  const key = input.key ?? "";
  checkDate(input.effectiveFrom);
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
      refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
    }
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
    const account = (await db.execute<{ id: string }>(sql`
      select id from accounts where org_id = ${orgId} and id = ${input.accountId}`)).rows[0];
    if (!account) {
      refuse(
        "channel_map_account_unavailable",
        "The posting account does not belong to this organization.",
        "Choose a general-ledger account in this organization.",
        "accountId",
      );
    }
    // Lock the role's rows before closing: a concurrent remap waits here,
    // then sees the closed window instead of writing over it.
    const open = (await db.execute<MapDbRow>(sql`
      select ${MAP_COLUMNS} from sales_channel_account_maps
       where org_id = ${orgId} and channel_id = ${input.channelId}
         and role = ${role} and key = ${key}
         and effective_to is null
       for update`)).rows;
    if (open.length > 1) {
      throw new Error(
        `Overlapping open account maps for channel ${input.channelId} role ${role} key "${key}"; storage must hold exactly one open row`,
      );
    }
    const prior = open[0];
    if (prior && prior.effective_from === input.effectiveFrom && prior.account_id === input.accountId) {
      return toRow(prior);
    }
    if (prior) {
      if (input.effectiveFrom <= prior.effective_from) {
        refuse(
          "channel_map_effective_before_open",
          `The new map takes effect ${input.effectiveFrom}, at or before the open row's ${prior.effective_from}.`,
          "Choose an effective date after the open row starts, or close the open row first.",
          "effectiveFrom",
        );
      }
      const closed = await db.execute(sql`
        update sales_channel_account_maps
           set effective_to = (${input.effectiveFrom}::date - interval '1 day')::date,
               updated_by = ${actor}, updated_at = now()
         where org_id = ${orgId} and id = ${prior.id}`);
      if (closed.rowCount !== 1) {
        throw new Error("Account map close matched no row; the map left while it was locked");
      }
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'sales_channel_account_maps', ${prior.id}, 'update',
          ${JSON.stringify({ before: toRow(prior), after: { ...toRow(prior), effectiveTo: input.effectiveFrom }, reason: "Superseded by a new effective-dated map" })}::jsonb, ${actor})`);
    }
    let id: string;
    try {
      const inserted = await db.execute<{ id: string }>(sql`
        insert into sales_channel_account_maps
          (org_id, channel_id, role, key, account_id, effective_from, created_by, updated_by)
        values (${orgId}, ${input.channelId}, ${role}, ${key}, ${input.accountId},
          ${input.effectiveFrom}, ${actor}, ${actor})
        returning id`);
      if (inserted.rows.length !== 1) throw new Error("Account map insert returned an unexpected row count");
      id = inserted.rows[0]!.id;
    } catch (error) {
      if (error instanceof CommerceError) throw error;
      const candidate = error as { code?: unknown; constraint?: unknown };
      if (candidate.code === "23P01" || candidate.constraint === "sales_channel_account_maps_no_overlap") {
        refuse(
          "channel_map_overlaps",
          `The new ${role} map overlaps an existing window for this channel and key.`,
          "Close the overlapping window first, or choose an effective date outside it.",
          "effectiveFrom",
          409,
        );
      }
      throw error;
    }
    const row = (await db.execute<MapDbRow>(sql`
      select ${MAP_COLUMNS} from sales_channel_account_maps
       where org_id = ${orgId} and id = ${id}`)).rows[0]!;
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'sales_channel_account_maps', ${id}, 'insert',
        ${JSON.stringify({ before: null, after: toRow(row), reason: null })}::jsonb, ${actor})`);
    return toRow(row);
  });
}

export async function listAccountMaps(orgId: string, channelId: string): Promise<AccountMapRow[]> {
  const rows = (await db.execute<MapDbRow>(sql`
    select ${MAP_COLUMNS} from sales_channel_account_maps
     where org_id = ${orgId} and channel_id = ${channelId}
     order by role, key, effective_from`)).rows;
  return rows.map(toRow);
}
