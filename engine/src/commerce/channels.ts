import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { channelAdapter } from "./adapters.ts";
import { ensureShopifyAdapterRegistered } from "./shopify/adapter.ts";
import type { ChannelStatus } from "./contracts.ts";
import { CommerceError, pgCause } from "./errors.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { db, withOrg, withOrgContext } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

export interface ChannelRow {
  id: string;
  kind: string;
  name: string;
  status: ChannelStatus;
  subsidiaryId: string | null;
  currency: string;
  externalAccount: string;
  settings: Record<string, unknown>;
  health: Record<string, unknown>;
  lastSyncAt: string | null;
}

export interface CreateChannelInput {
  kind: string;
  name: string;
  subsidiaryId?: string | null;
  currency: string;
  externalAccount: string;
  /** Connector credentials; sealed on write, never read back. */
  secrets?: Record<string, unknown> | null;
  /** Provider webhook signing secret; generated when omitted. */
  webhookSecret?: string | null;
  /** Adapter-validated configuration. */
  settings?: Record<string, unknown>;
}

export interface UpdateChannelInput {
  name?: string;
  subsidiaryId?: string | null;
  currency?: string;
  secrets?: Record<string, unknown> | null;
  webhookSecret?: string | null;
  settings?: Record<string, unknown>;
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

function checkCurrency(currency: string): void {
  if (!/^[A-Za-z]{3}$/.test(currency)) {
    refuse(
      "channel_currency_invalid",
      `Channel currency "${currency}" is not a three-letter ISO code.`,
      "Enter the shop's three-letter currency code, for example USD.",
      "currency",
    );
  }
}

function checkSettings(kind: string, settings: Record<string, unknown>): Record<string, unknown> {
  const adapter = channelAdapter(kind);
  const parsed = adapter.describeSettings().safeParse(settings);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    refuse(
      "channel_settings_invalid",
      `Channel settings are invalid: ${first?.path.join(".") || "settings"} — ${first?.message ?? "rejected"}.`,
      "Correct the channel settings to match the connector's required configuration.",
      "settings",
    );
  }
  return (parsed.data ?? {}) as Record<string, unknown>;
}

interface ChannelDbRow extends Record<string, unknown> {
  id: string;
  kind: string;
  name: string;
  status: ChannelStatus;
  subsidiary_id: string | null;
  currency: string;
  external_account: string;
  settings: Record<string, unknown>;
  health: Record<string, unknown>;
  last_sync_at: string | null;
}

function toRow(row: ChannelDbRow): ChannelRow {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    subsidiaryId: row.subsidiary_id,
    currency: row.currency,
    externalAccount: row.external_account,
    settings: row.settings ?? {},
    health: row.health ?? {},
    lastSyncAt: row.last_sync_at,
  };
}

const CHANNEL_COLUMNS = sql`id, kind, name, status, subsidiary_id, currency, external_account, settings, health, last_sync_at`;

async function loadChannel(orgId: string, channelId: string): Promise<ChannelDbRow> {
  const row = (await db.execute<ChannelDbRow>(sql`
    select ${CHANNEL_COLUMNS} from sales_channels
     where org_id = ${orgId} and id = ${channelId}`)).rows[0];
  if (!row) {
    refuse(
      "channel_not_found",
      "The sales channel does not belong to this organization.",
      "Choose a channel in this organization, or connect it first under Channels.",
      "channelId",
    );
  }
  return row;
}

async function writeAudit(
  orgId: string,
  channelId: string,
  action: string,
  actor: string | null,
  before: unknown,
  after: unknown,
  reason: string | null,
): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'sales_channels', ${channelId}, ${action},
      ${JSON.stringify({ before, after, reason })}::jsonb, ${actor})`);
}

function checkReason(reason: unknown, action: string): string {
  const clean = cleanText(reason);
  if (!clean) {
    refuse(
      "channel_reason_missing",
      `A reason is required to ${action} a sales channel.`,
      "Explain why the channel state is changing so the audit record says what happened.",
      "reason",
    );
  }
  return clean;
}

/** Connect a new storefront channel. Returns the channel and, when generated, the webhook secret to register with the provider. */
export async function createChannel(
  orgId: string,
  actor: string,
  input: CreateChannelInput,
): Promise<{ channel: ChannelRow; webhookSecret: string | null }> {
  const kind = cleanText(input.kind)?.toLowerCase();
  if (!kind) refuse("channel_kind_missing", "A sales channel needs its storefront kind.", "Choose a registered storefront kind for the channel.", "kind");
  // Connectors register on demand per process, never at import time: ensure
  // them before the kind check, or a fresh process refuses a known kind with
  // an install remedy for a connector that is already installed.
  ensureShopifyAdapterRegistered();
  // Unknown kinds refuse by name through the adapter registry, naming every installed connector.
  channelAdapter(kind);
  const name = cleanText(input.name);
  if (!name) refuse("channel_name_missing", "A sales channel needs a name.", "Name the channel after the storefront it connects.", "name");
  const currency = cleanText(input.currency)?.toUpperCase() ?? "";
  checkCurrency(currency);
  const externalAccount = cleanText(input.externalAccount);
  if (!externalAccount) {
    refuse("channel_account_missing", "A sales channel needs its storefront account.", "Enter the shop domain or provider account the channel connects.", "externalAccount");
  }
  const settings = checkSettings(kind, input.settings ?? {});
  if (input.subsidiaryId) {
    const subsidiary = (await withOrgContext(orgId, () => db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgId} and id = ${input.subsidiaryId}`))).rows[0];
    if (!subsidiary) {
      refuse("channel_subsidiary_unavailable", "The subsidiary does not belong to this organization.", "Choose a subsidiary in this organization.", "subsidiaryId");
    }
  }
  const webhookSecret = cleanText(input.webhookSecret) ?? randomBytes(32).toString("hex");
  const generated = !cleanText(input.webhookSecret);

  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    let id: string;
    try {
      const inserted = await db.execute<{ id: string }>(sql`
        insert into sales_channels
          (org_id, kind, name, status, subsidiary_id, currency, external_account,
           secrets, webhook_secret, settings, created_by, updated_by)
        values (${orgId}, ${kind}, ${name}, 'draft', ${input.subsidiaryId ?? null},
          ${currency}, ${externalAccount},
          ${input.secrets ? sealJson(input.secrets, { orgId, purpose: "sales_channel.secrets" }) : null},
          ${sealJson({ secret: webhookSecret }, { orgId, purpose: "sales_channel.webhook_secret" })},
          ${JSON.stringify(settings)}::jsonb, ${actor}, ${actor})
        returning id`);
      if (inserted.rows.length !== 1) throw new Error("Channel insert returned an unexpected row count");
      id = inserted.rows[0]!.id;
    } catch (error) {
      if (error instanceof CommerceError) throw error;
      const candidate = pgCause(error);
      if (candidate.code === "23505" && candidate.constraint === "sales_channels_kind_account_unique") {
        refuse(
          "channel_account_in_use",
          `This organization already connects ${kind} account "${externalAccount}".`,
          "Open the existing channel instead of connecting the same storefront twice.",
          "externalAccount",
          409,
        );
      }
      throw error;
    }
    const channel = toRow(await loadChannel(orgId, id));
    await writeAudit(orgId, id, "insert", actor, null, channel, null);
    return { channel, webhookSecret: generated ? webhookSecret : null };
  });
}

/** Edit a channel's identity, configuration, or credentials. Status moves only through the lifecycle actions. */
export async function updateChannel(
  orgId: string,
  actor: string,
  channelId: string,
  input: UpdateChannelInput,
): Promise<ChannelRow> {
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    // Same on-demand registration as create: settings validation resolves
    // the kind's adapter, and a fresh process must not refuse it as unknown.
    ensureShopifyAdapterRegistered();
    const before = toRow(await loadChannel(orgId, channelId));
    const patch: { name?: string; subsidiaryId?: string | null; currency?: string; settings?: Record<string, unknown> } = {};
    if (input.name !== undefined) {
      const name = cleanText(input.name);
      if (!name) refuse("channel_name_missing", "A sales channel needs a name.", "Name the channel after the storefront it connects.", "name");
      patch.name = name;
    }
    if (input.subsidiaryId !== undefined) {
      if (input.subsidiaryId) {
        const subsidiary = (await db.execute<{ id: string }>(sql`
          select id from subsidiaries where org_id = ${orgId} and id = ${input.subsidiaryId}`)).rows[0];
        if (!subsidiary) {
          refuse("channel_subsidiary_unavailable", "The subsidiary does not belong to this organization.", "Choose a subsidiary in this organization.", "subsidiaryId");
        }
      }
      patch.subsidiaryId = input.subsidiaryId;
    }
    if (input.currency !== undefined) {
      const currency = cleanText(input.currency)?.toUpperCase() ?? "";
      checkCurrency(currency);
      if (currency !== before.currency && before.status !== "draft") {
        refuse(
          "channel_currency_locked",
          `Channel currency cannot move from ${before.currency} to ${currency} once the channel has left draft.`,
          "Disconnect this channel and connect a new one for the new shop currency; posted history keeps the old currency.",
          "currency",
        );
      }
      patch.currency = currency;
    }
    if (input.settings !== undefined) patch.settings = checkSettings(before.kind, input.settings);
    // Secrets rotate only when supplied; otherwise the sealed value carries over untouched.
    const secretsValue = input.secrets
      ? sealJson(input.secrets, { orgId, purpose: "sales_channel.secrets" })
      : null;
    const webhookValue = cleanText(input.webhookSecret)
      ? sealJson({ secret: cleanText(input.webhookSecret)! }, { orgId, purpose: "sales_channel.webhook_secret" })
      : null;
    const updated = await db.execute<ChannelDbRow>(sql`
      update sales_channels
         set name = ${patch.name ?? before.name},
             subsidiary_id = ${(patch.subsidiaryId !== undefined ? patch.subsidiaryId : before.subsidiaryId) as string | null},
             currency = ${patch.currency ?? before.currency},
             secrets = coalesce(${secretsValue}, secrets),
             webhook_secret = coalesce(${webhookValue}, webhook_secret),
             settings = ${patch.settings !== undefined ? JSON.stringify(patch.settings) : JSON.stringify(before.settings)}::jsonb,
             updated_by = ${actor}, updated_at = now()
       where org_id = ${orgId} and id = ${channelId}
       returning ${CHANNEL_COLUMNS}`);
    if (updated.rows.length !== 1) {
      throw new Error("Channel update matched no row; the channel is no longer in this organization");
    }
    const after = toRow(updated.rows[0]!);
    await writeAudit(orgId, channelId, "update", actor, before, after, null);
    return after;
  });
}

/** Lifecycle moves, each audited with the operator's reason. Disconnect is terminal: reconnecting is a new channel, so history keeps its origin. */
const LIFECYCLE_TARGETS: Record<string, ChannelStatus[]> = {
  draft: ["connecting", "disconnected"],
  connecting: ["active", "error", "disconnected"],
  active: ["paused", "disconnected", "error"],
  paused: ["active", "disconnected"],
  error: ["connecting", "disconnected"],
  disconnected: [],
};

async function transitionChannel(
  orgId: string,
  actor: string,
  channelId: string,
  target: ChannelStatus,
  reason: unknown,
): Promise<ChannelRow> {
  const why = checkReason(reason, `move to ${target}`);
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    const before = toRow(await loadChannel(orgId, channelId));
    const allowed = LIFECYCLE_TARGETS[before.status] ?? [];
    if (!allowed.includes(target)) {
      refuse(
        "channel_transition_refused",
        `A ${before.status} channel cannot move to ${target}.`,
        allowed.length === 0
          ? "This channel is disconnected for good; connect a new channel to trade again."
          : `Move it to ${allowed.join(" or ")} instead.`,
        "status",
      );
    }
    const updated = await db.execute<ChannelDbRow>(sql`
      update sales_channels
         set status = ${target}, updated_by = ${actor}, updated_at = now()
       where org_id = ${orgId} and id = ${channelId}
       returning ${CHANNEL_COLUMNS}`);
    if (updated.rows.length !== 1) {
      throw new Error("Channel transition matched no row; the channel is no longer in this organization");
    }
    const after = toRow(updated.rows[0]!);
    await writeAudit(orgId, channelId, "update", actor, before, after, why);
    return after;
  });
}

export async function pauseChannel(orgId: string, actor: string, channelId: string, reason: unknown): Promise<ChannelRow> {
  return transitionChannel(orgId, actor, channelId, "paused", reason);
}

export async function resumeChannel(orgId: string, actor: string, channelId: string, reason: unknown): Promise<ChannelRow> {
  return transitionChannel(orgId, actor, channelId, "active", reason);
}

export async function disconnectChannel(orgId: string, actor: string, channelId: string, reason: unknown): Promise<ChannelRow> {
  return transitionChannel(orgId, actor, channelId, "disconnected", reason);
}

export async function retryChannel(orgId: string, actor: string, channelId: string, reason: unknown): Promise<ChannelRow> {
  return transitionChannel(orgId, actor, channelId, "connecting", reason);
}

export async function markChannelActive(orgId: string, actor: string, channelId: string): Promise<ChannelRow> {
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    const before = toRow(await loadChannel(orgId, channelId));
    if (before.status !== "connecting" && before.status !== "error") {
      refuse(
        "channel_transition_refused",
        `Only a connecting channel becomes active; this one is ${before.status}.`,
        "Pause, resume, or retry the channel through its lifecycle actions instead.",
        "status",
      );
    }
    const updated = await db.execute<ChannelDbRow>(sql`
      update sales_channels
         set status = 'active', updated_by = ${actor}, updated_at = now()
       where org_id = ${orgId} and id = ${channelId}
       returning ${CHANNEL_COLUMNS}`);
    if (updated.rows.length !== 1) {
      throw new Error("Channel activation matched no row; the channel is no longer in this organization");
    }
    const after = toRow(updated.rows[0]!);
    await writeAudit(orgId, channelId, "update", actor, before, after, "Connection verified");
    return after;
  });
}

/**
 * Provider-initiated disconnect (the storefront reports the app removed):
 * audited as a system event with a null actor. Already disconnected stays
 * put so redelivered uninstall events are no-ops instead of refusals.
 */
export async function disconnectChannelByProvider(
  orgId: string,
  channelId: string,
  detail: string,
): Promise<ChannelRow> {
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    const before = toRow(await loadChannel(orgId, channelId));
    if (before.status === "disconnected") return before;
    const allowed = LIFECYCLE_TARGETS[before.status] ?? [];
    if (!allowed.includes("disconnected")) {
      refuse(
        "channel_transition_refused",
        `A ${before.status} channel cannot move to disconnected.`,
        "Disconnect the channel by hand under Channels.",
        "status",
      );
    }
    const updated = await db.execute<ChannelDbRow>(sql`
      update sales_channels
         set status = 'disconnected', updated_at = now()
       where org_id = ${orgId} and id = ${channelId}
       returning ${CHANNEL_COLUMNS}`);
    if (updated.rows.length !== 1) {
      throw new Error("Channel provider disconnect matched no row; the channel is no longer in this organization");
    }
    const after = toRow(updated.rows[0]!);
    await writeAudit(orgId, channelId, "update", null, before, after, detail);
    return after;
  });
}

export async function listChannels(orgId: string): Promise<ChannelRow[]> {
  const rows = (await withOrgContext(orgId, () => db.execute<ChannelDbRow>(sql`
    select ${CHANNEL_COLUMNS} from sales_channels
     where org_id = ${orgId} order by name`))).rows;
  return rows.map(toRow);
}

export async function getChannel(orgId: string, channelId: string): Promise<ChannelRow> {
  return toRow(await withOrgContext(orgId, () => loadChannel(orgId, channelId)));
}
