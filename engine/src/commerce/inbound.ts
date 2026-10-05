import { sql } from "drizzle-orm";
import { channelAdapter } from "./adapters.ts";
import { postDueDailySummaries } from "./daily-summary.ts";
import { CommerceError } from "./errors.ts";
import { recomputePendingOrderEconomics } from "./economics.ts";
import { postPendingChannelOrders } from "./order-posting.ts";
import { ensureShopifyAdapterRegistered } from "./shopify/adapter.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { db, withBypassContext, withOrg, withOrgContext } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";

/**
 * The verified inbound webhook inbox. Deliveries are verified over their raw
 * bytes BEFORE anything is stored — a bad signature stores nothing and the
 * provider gets a 401 — then deduplicated by provider event id, processed by
 * the scheduler scan with retries, and replayable by the operator. Processing
 * the same event twice produces one effect: the dedupe key plus
 * claim-once processing collapse redeliveries onto the stored row.
 */

export const INBOUND_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60_000;

/** Headers worth keeping: signature, topic, id, and shop only. Everything else is dropped at the door. */
const STORED_HEADER_PATTERN = /signature|topic|event.?id|webhook.?id|shop/i;

export interface InboundEventRow {
  id: string;
  orgId: string;
  channelId: string;
  provider: string;
  topic: string;
  providerEventId: string;
  verified: boolean;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  resultRef: Record<string, unknown> | null;
  receivedAt: string;
}

interface EventDbRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  channel_id: string;
  provider: string;
  topic: string;
  provider_event_id: string;
  verified: boolean;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  error: string | null;
  result_ref: Record<string, unknown> | null;
  received_at: string;
}

function toRow(row: EventDbRow): InboundEventRow {
  return {
    id: row.id,
    orgId: row.org_id,
    channelId: row.channel_id,
    provider: row.provider,
    topic: row.topic,
    providerEventId: row.provider_event_id,
    verified: row.verified,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    error: row.error,
    resultRef: row.result_ref,
    receivedAt: row.received_at,
  };
}

const EVENT_COLUMNS = sql`id, org_id, channel_id, provider, topic, provider_event_id, verified, status, attempts, next_attempt_at, error, result_ref, received_at`;

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new CommerceError(code, message, remedy, { field, status });
}

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function storedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (STORED_HEADER_PATTERN.test(name)) out[name.toLowerCase()] = value;
  }
  return out;
}

interface WebhookChannel {
  orgId: string;
  kind: string;
  status: string;
  webhookSecret: string;
}

/** Resolve the channel for a sessionless delivery: the org is known only once this row is read. */
async function loadWebhookChannel(channelId: string): Promise<WebhookChannel | null> {
  // bypass: connector-token — a provider-signed delivery carries no org header; the channel row resolves its organization.
  return withBypassContext(async () => {
    const row = (await db.execute<{ org_id: string; kind: string; status: string; webhook_secret: string | null }>(sql`
      select org_id, kind, status, webhook_secret from sales_channels where id = ${channelId}`)).rows[0];
    if (!row || !row.webhook_secret) return null;
    let secret: string;
    try {
      secret = unsealJson<{ secret?: unknown }>(row.webhook_secret, {
        orgId: row.org_id,
        purpose: "sales_channel.webhook_secret",
      }).secret as string;
    } catch {
      return null;
    }
    if (typeof secret !== "string" || secret === "") return null;
    return { orgId: row.org_id, kind: row.kind, status: row.status, webhookSecret: secret };
  });
}

export interface ReceiveInboundInput {
  channelId: string;
  rawBody: Buffer;
  headers: Record<string, string>;
}

/**
 * Verify a provider delivery and store it durably. Returns the stored event;
 * a redelivered event id returns the original row instead of storing twice.
 * Unknown channels refuse (the route answers 404); a failed verification
 * stores nothing and refuses (the route answers 401).
 */
export async function receiveInboundEvent(input: ReceiveInboundInput): Promise<InboundEventRow> {
  // Production workers arrive with no adapter installed; tests that
  // register their own kind double keep it (first registration wins).
  ensureShopifyAdapterRegistered();
  const channel = await loadWebhookChannel(input.channelId);
  if (!channel) {
    refuse(
      "channel_not_found",
      "The webhook channel is unknown or has no verification secret.",
      "Check the webhook URL's channel id, then configure the channel's webhook secret under Channels → Settings.",
      "channelId",
    );
  }
  const adapter = channelAdapter(channel.kind);
  const verified = adapter.verifyWebhook(input.rawBody, input.headers, channel.webhookSecret);
  return withOrg(channel.orgId, async () => {
    const existing = (await db.execute<EventDbRow>(sql`
      select ${EVENT_COLUMNS} from integration_inbound_events
       where org_id = ${channel.orgId} and channel_id = ${input.channelId}
         and provider_event_id = ${verified.eventId}`)).rows[0];
    if (existing) return toRow(existing);
    // A retry racing the first store is an expected unique-key collision; re-read below to return the winner.
    const inserted = await db.execute<{ id: string }>(sql`
      insert into integration_inbound_events
        (org_id, channel_id, provider, topic, provider_event_id, raw_body,
         headers, verified, status, created_by)
      values (${channel.orgId}, ${input.channelId}, ${channel.kind}, ${verified.topic},
        ${verified.eventId}, ${input.rawBody},
        ${JSON.stringify(storedHeaders(input.headers))}::jsonb, true, 'pending', null)
      on conflict (channel_id, provider_event_id) do nothing
      returning id`);
    const id = inserted.rows[0]?.id ?? (await db.execute<{ id: string }>(sql`
      select id from integration_inbound_events
       where channel_id = ${input.channelId} and provider_event_id = ${verified.eventId}`)).rows[0]?.id;
    if (!id) throw new Error("Inbound event store returned no row; the delivery was lost");
    const row = (await db.execute<EventDbRow>(sql`
      select ${EVENT_COLUMNS} from integration_inbound_events
       where org_id = ${channel.orgId} and id = ${id}`)).rows[0];
    if (!row) throw new Error("Inbound event store returned no row; the delivery was lost");
    return toRow(row);
  });
}

/**
 * Claim due events, run them through their adapter, and record the outcome on
 * the row. The claim is one atomic UPDATE whose subselect locks with FOR
 * UPDATE SKIP LOCKED: two workers never run one event, and a worker that dies
 * between claim and finish leaves `processing` for stale recovery to retry.
 */
export async function processPendingEvents(limit = 50): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  // bypass: scheduler-tick — the commerce scan claims due inbox rows across organizations before each row's organization is known.
  const claimed = await withBypassContext(() => db.execute<EventDbRow>(sql`
    update integration_inbound_events
       set status = 'processing', updated_at = now()
     where id in (
       select id from integration_inbound_events
        where status in ('pending', 'failed')
          and next_attempt_at <= now()
        order by next_attempt_at
        limit ${limit}
        for update skip locked)
     returning ${EVENT_COLUMNS}`)).then((result) => result.rows);
  for (const event of claimed) {
    await runOneEvent(event);
    const done = await withOrgContext(event.org_id, () => db.execute<{ status: string }>(sql`
      select status from integration_inbound_events where id = ${event.id}`)).then(
      (result) => result.rows[0],
    );
    if (done?.status === "processed" || done?.status === "ignored") processed += 1;
    else failed += 1;
  }
  return { processed, failed };
}

async function runOneEvent(event: EventDbRow): Promise<void> {
  const channel = await loadWebhookChannel(event.channel_id);
  if (!channel) {
    await withOrg(event.org_id, async () => {
      const retryInSeconds = Math.round(backoffMs(event.attempts + 1) / 1000);
      const failed = await db.execute(sql`
        update integration_inbound_events
           set status = 'failed', attempts = attempts + 1, error = 'The channel is gone; the event cannot be routed.',
               next_attempt_at = now() + (${retryInSeconds} || ' seconds')::interval,
               updated_at = now()
         where id = ${event.id} and status = 'processing'`);
      if (failed.rowCount !== 1) {
        throw new Error(`Inbound event ${event.id} left processing while it ran`);
      }
    });
    return;
  }
  await withOrg(channel.orgId, async () => {
    // Events for a paused or disconnected channel wait: effects must never
    // start while the operator has the channel held.
    if (channel.status !== "active") {
      const held = await db.execute(sql`
        update integration_inbound_events
           set status = 'pending', updated_at = now()
         where id = ${event.id} and status = 'processing'`);
      if (held.rowCount !== 1) {
        throw new Error(`Inbound event ${event.id} left processing while it ran`);
      }
      return;
    }
    ensureShopifyAdapterRegistered();
    const adapter = channelAdapter(channel.kind);
    const body = (await db.execute<{ raw_body: Buffer; headers: Record<string, string> }>(sql`
      select raw_body, headers from integration_inbound_events where id = ${event.id}`)).rows[0];
    if (!body) return;
    try {
      const outcome = await adapter.handleEvent({
        eventId: event.provider_event_id,
        topic: event.topic,
        channelId: event.channel_id,
        orgId: channel.orgId,
        rawBody: body.raw_body,
        headers: body.headers ?? {},
      });
      const done = await db.execute(sql`
        update integration_inbound_events
           set status = ${outcome.action === "ignored" ? "ignored" : "processed"},
               attempts = attempts + 1, error = null,
               result_ref = ${JSON.stringify(outcome.resultRef)}::jsonb, updated_at = now()
         where id = ${event.id} and status = 'processing'`);
      if (done.rowCount !== 1) {
        throw new Error(`Inbound event ${event.id} left processing while it ran`);
      }
    } catch (error) {
      const attempts = event.attempts + 1;
      const message = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
      const dead = attempts >= INBOUND_MAX_ATTEMPTS;
      const marked = await db.execute(sql`
        update integration_inbound_events
           set status = ${dead ? "dead" : "failed"}, attempts = ${attempts}, error = ${message},
               next_attempt_at = ${dead ? new Date(Date.now() + BACKOFF_CAP_MS) : new Date(Date.now() + backoffMs(attempts))},
               updated_at = now()
         where id = ${event.id} and status = 'processing'`);
      if (marked.rowCount !== 1) {
        throw new Error(`Inbound event ${event.id} left processing while it ran`);
      }
    }
  });
}

/** Requeue one event for processing. An audited operator action: replaying re-runs the adapter. */
export async function replayEvent(
  orgId: string,
  actor: string,
  eventId: string,
  reason: unknown,
  channelId: string | null = null,
): Promise<InboundEventRow> {
  const why = typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null;
  if (!why) {
    refuse(
      "inbound_replay_reason_missing",
      "A reason is required to replay an inbound event.",
      "Explain why the delivery must run again so the audit record says what happened.",
      "reason",
    );
  }
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
      refuse("feature_off", "Sales Channels is turned off for this organization.", "Enable Sales Channels in Company Settings → Features.");
    }
    // A channel-scoped caller names the channel up front, so one channel's
    // activity screen cannot requeue another channel's delivery.
    const before = (await db.execute<EventDbRow>(sql`
      select ${EVENT_COLUMNS} from integration_inbound_events
       where org_id = ${orgId} and id = ${eventId}
         and (${channelId}::uuid is null or channel_id = ${channelId})`)).rows[0];
    if (!before) {
      refuse(
        "inbound_event_not_found",
        channelId
          ? "The inbound event does not belong to this channel."
          : "The inbound event does not belong to this organization.",
        "Choose an event from this organization's channel activity.",
        "eventId",
      );
    }
    const updated = await db.execute<EventDbRow>(sql`
      update integration_inbound_events
         set status = 'pending', attempts = 0, error = null,
             next_attempt_at = now(), updated_at = now()
       where org_id = ${orgId} and id = ${eventId}
       returning ${EVENT_COLUMNS}`);
    if (updated.rows.length !== 1) {
      throw new Error("Inbound event replay matched no row; the event left while it was requeued");
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'integration_inbound_events', ${eventId}, 'update',
        ${JSON.stringify({ before: toRow(before), after: toRow(updated.rows[0]!), reason: why })}::jsonb, ${actor})`);
    return toRow(updated.rows[0]!);
  });
}

/** List one channel's activity for the operator, newest first. */
export async function listInboundEvents(orgId: string, channelId: string, limit = 100): Promise<InboundEventRow[]> {
  const rows = (await withOrgContext(orgId, () => db.execute<EventDbRow>(sql`
    select ${EVENT_COLUMNS} from integration_inbound_events
     where org_id = ${orgId} and channel_id = ${channelId}
     order by received_at desc limit ${limit}`))).rows;
  return rows.map(toRow);
}

/**
 * The scheduler scan body for kind `commerce_inbound`: the verified inbox
 * first, then the order queue (pending per-order posts, then due daily
 * summaries). No new scan kind: the order drain rides the existing inbox
 * tick, so no scheduler exception is needed.
 */
export async function runCommerceInboundScan(): Promise<void> {
  await processPendingEvents(100);
  await runChannelOrderScan();
}

/**
 * Drain one tick of the channel order queue across organizations: pending
 * per-order posts first, then due daily summaries. An org that throws keeps
 * its orders pending for the next tick; summaries that throw wait as well.
 */
export async function runChannelOrderScan(): Promise<{ posted: number; parked: number }> {
  let posted = 0;
  let parked = 0;
  // bypass: scheduler-tick — the commerce scan drains pending orders across
  // organizations before each row's organization is known.
  const orgs = await withBypassContext(() => db.execute<{ org_id: string }>(sql`
    select distinct org_id from channel_orders where posting_status = 'pending' limit 50`))
    .then((result) => result.rows);
  for (const org of orgs) {
    try {
      const outcome = await postPendingChannelOrders(org.org_id, null, 100);
      posted += outcome.posted;
      parked += outcome.parked;
      // Late label and payout costs restate beside the posting drain, so no
      // new scheduler kind is needed for margin restatement.
      await recomputePendingOrderEconomics(org.org_id, null, 100);
    } catch {
      continue;
    }
  }
  try {
    const summaries = await postDueDailySummaries();
    posted += summaries.posted;
    parked += summaries.parked;
  } catch {
    // Summaries wait for the next tick; pending orders keep their state.
  }
  return { posted, parked };
}

export interface ChannelAttention {
  failed: number;
  dead: number;
  lastReceivedAt: string | null;
}

/**
 * One row per channel that has deliveries: failed and dead counts plus the
 * newest delivery time. The Channels home merges this into its tiles and
 * cards; channels with no deliveries yet simply have no entry.
 */
export async function channelAttention(orgId: string): Promise<Record<string, ChannelAttention>> {
  const rows = (await withOrgContext(orgId, () => db.execute<{
    channel_id: string;
    failed: string;
    dead: string;
    last_received_at: string | null;
  }>(sql`
    select channel_id,
           count(*) filter (where status = 'failed') as failed,
           count(*) filter (where status = 'dead') as dead,
           max(received_at) as last_received_at
      from integration_inbound_events
     where org_id = ${orgId}
     group by channel_id`))).rows;
  const out: Record<string, ChannelAttention> = {};
  for (const row of rows) {
    out[row.channel_id] = { failed: Number(row.failed), dead: Number(row.dead), lastReceivedAt: row.last_received_at };
  }
  return out;
}
