import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { guardedFetch } from "../connectors/ssrf-guard.ts";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { unsealSecret } from "../platform/secrets.ts";
import { recordWebhookAudit } from "./endpoints.ts";

/**
 * Signed delivery worker — POSTs queued domain events to subscriber
 * endpoints and retries with backoff.
 *
 * Envelope and signature (also documented in the in-app webhook help
 * article — the two must stay in sync):
 *   POST {url}
 *   OpenBooks-Event: document.posted
 *   OpenBooks-Delivery: <delivery id>
 *   OpenBooks-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body">
 *   { "id": "<delivery id>", "event": "document.posted",
 *     "occurredAt": "<iso>", "data": { ...snapshot... } }
 *
 * During a secret rotation the header carries a second `v1=` computed
 * with the previous secret, so in-flight deliveries verify on either
 * side of the roll.
 *
 * Outcomes: 2xx = delivered; 410 Gone = the subscriber is gone, so the
 * endpoint disables immediately; other 4xx = the receiver refuses this
 * payload and retrying cannot help, so the delivery fails terminally;
 * 5xx, 429, timeouts and network errors retry with exponential backoff
 * and jitter inside a 3-day budget, then go dead. Every non-delivered
 * attempt counts against the endpoint's consecutive-failure streak, and
 * reaching its threshold auto-disables the endpoint with audit evidence
 * and an admin notification — a dead subscriber must not hold the queue
 * open forever.
 *
 * Claiming is lease-based without extra columns: the claim moves
 * `next_attempt_at` five minutes out, so a rival worker's atomic claim
 * (`WHERE status = 'pending' AND next_attempt_at <= now`) finds nothing
 * to take, and a worker that dies between claim and outcome leaves the
 * delivery due again after the lease — the same crash-recovery shape as
 * the scheduler outbox's stale recovery.
 */

export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
export const WEBHOOK_RETRY_BUDGET_MS = 3 * 24 * 60 * 60 * 1000;
export const WEBHOOK_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const WEBHOOK_SIGNATURE_SKEW_MS = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
const RESPONSE_EXCERPT_CHARS = 2000;

export class WebhookDeliveryError extends Error {}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * URL policy for subscriber endpoints. HTTPS only; plain HTTP reaches
 * only a loopback host and only in the test environment (the integration
 * suite delivers to a local server). An unset environment reads as
 * unknown and refuses — fail closed.
 */
export function deliveryUrlRefusal(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return `webhook URL '${url}' is not a valid URL — use an https:// URL`;
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && process.env.NODE_ENV === "test" && isLoopbackHostname(parsed.hostname)) {
    return null;
  }
  return (
    `webhook URL '${url}' is refused: subscriber endpoints require https — ` +
    `terminate TLS in front of the receiver and subscribe the https:// URL`
  );
}

export function buildSignatureHeader(secret: string, timestampUnix: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampUnix}.${body}`, "utf8").digest("hex");
  return `t=${timestampUnix},v1=${mac}`;
}

/** Parse and verify an `OpenBooks-Signature` header with an independent recomputation. */
export function verifyWebhookSignature(secret: string, header: string, body: string, nowMs = Date.now()): boolean {
  const parts = header.split(",").map((p) => p.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2) ?? "";
  const candidates = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!/^\d+$/.test(t) || candidates.length === 0) return false;
  if (Math.abs(nowMs - Number(t) * 1000) > WEBHOOK_SIGNATURE_SKEW_MS) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return candidates.some((candidate) => {
    const a = Buffer.from(candidate, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** Exponential backoff with full jitter, capped: attempt 1 lands within a minute, later attempts back off geometrically. */
export function deliveryBackoffMs(attemptCount: number, rand = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1));
  return Math.floor(rand() * ceiling);
}

type DeliveryOutcome =
  | { kind: "delivered"; code: number; latencyMs: number; excerpt: string }
  | { kind: "gone" }
  | { kind: "refused"; code: number; excerpt: string }
  | { kind: "retryable"; code: number | null; error: string };

export function classifyDeliveryResponse(code: number, excerpt: string): DeliveryOutcome {
  if (code >= 200 && code < 300) return { kind: "delivered", code, latencyMs: 0, excerpt };
  if (code === 410) return { kind: "gone" };
  if (code === 429 || code >= 500) {
    return { kind: "retryable", code, error: `endpoint answered ${code}` };
  }
  return { kind: "refused", code, excerpt };
}

export type PostDelivery = (url: string, body: string, headers: Record<string, string>) => Promise<{
  status: number;
  bodyExcerpt: string;
}>;

/**
 * The production POST: scheme policy first, then the SSRF-guarded fetch
 * (which pins DNS at request time and refuses redirects) — except the
 * test-loopback case the URL policy admits, which plain fetch serves with
 * redirects off. A 3xx can only surface as a retryable outcome, never as
 * a followed request carrying the payload elsewhere.
 */
export async function postWebhookDelivery(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; bodyExcerpt: string }> {
  const refusal = deliveryUrlRefusal(url);
  if (refusal) throw new WebhookDeliveryError(refusal);
  const parsed = new URL(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_DELIVERY_TIMEOUT_MS);
  try {
    const response = parsed.protocol === "http:"
      ? await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
        signal: controller.signal,
        redirect: "manual",
      })
      : await guardedFetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
    const text = await response.text().catch(() => "");
    return { status: response.status, bodyExcerpt: text.slice(0, RESPONSE_EXCERPT_CHARS) };
  } finally {
    clearTimeout(timer);
  }
}

type ClaimedDelivery = {
  id: string;
  orgId: string;
  eventId: string;
  endpointId: string;
  attemptCount: number;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  endpointUrl: string;
  secretSealed: string;
  secretPreviousSealed: string | null;
  consecutiveFailures: number;
  autoDisableAfter: number;
  endpointStatus: string;
};

async function claimDueDeliveries(limit: number, now: Date): Promise<ClaimedDelivery[]> {
  return withBypassContext(async () => {
    const candidates = (await db.execute<{ id: string }>(sql`
      select id from webhook_deliveries
       where status = 'pending' and next_attempt_at <= ${now}
       order by next_attempt_at asc limit ${limit}
    `)).rows;
    const claimed: ClaimedDelivery[] = [];
    for (const candidate of candidates) {
      // Atomic per-row claim: a rival that already moved the row matches
      // zero rows and moves on, so one delivery is never attempted twice.
      const row = (await db.execute<ClaimedDelivery>(sql`
        update webhook_deliveries d
           set attempt_count = d.attempt_count + 1,
               last_attempt_at = ${now},
               first_attempt_at = coalesce(d.first_attempt_at, ${now}),
               next_attempt_at = ${new Date(now.getTime() + WEBHOOK_CLAIM_LEASE_MS)},
               updated_at = now()
          from webhook_events e, webhook_endpoints ep
         where d.id = ${candidate.id}::uuid
           and d.status = 'pending' and d.next_attempt_at <= ${now}
           and e.org_id = d.org_id and e.id = d.event_id
           and ep.org_id = d.org_id and ep.id = d.endpoint_id
        returning d.id::text as id, d.org_id as "orgId", d.event_id as "eventId",
                  d.endpoint_id as "endpointId", d.attempt_count as "attemptCount",
                  e.event_type as "eventType", e.payload as payload, e.occurred_at as "occurredAt",
                  ep.url as "endpointUrl", ep.secret_sealed as "secretSealed",
                  ep.secret_previous_sealed as "secretPreviousSealed",
                  ep.consecutive_failures as "consecutiveFailures",
                  ep.auto_disable_after as "autoDisableAfter",
                  ep.status as "endpointStatus"
      `)).rows[0];
      if (row) claimed.push(row);
    }
    return claimed;
  });
}

/**
 * Notify every admin who can manage webhooks. Runs in the caller's tenant
 * scope (the row-count checks below fail closed without one).
 */
async function notifyWebhookAdmins(
  orgId: string,
  input: { title: string; body: string; href: string },
): Promise<void> {
  const recipients = (await db.execute<{ id: string }>(sql`
    select distinct u.id::text as id
      from users u
      left join role_assignments a on a.user_id = u.id and a.org_id = u.org_id
      left join app_roles r on r.id = a.role_id and r.org_id = a.org_id
     where u.org_id = ${orgId} and u.is_active
       and (u.is_super_admin or (r.permissions ? 'webhooks.manage'))
  `)).rows;
  for (const recipient of recipients) {
    const existing = (await db.execute<{ one: number }>(sql`
      select 1 as one from notifications
       where org_id = ${orgId} and user_id = ${recipient.id}::uuid
         and kind = 'webhook_endpoint_disabled' and href = ${input.href} and read_at is null
       limit 1
    `)).rows[0];
    if (existing) continue;
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into notifications (org_id, user_id, kind, title, body, href)
      values (${orgId}, ${recipient.id}::uuid, 'webhook_endpoint_disabled',
              ${input.title}, ${input.body}, ${input.href})
      returning id
    `)).rows[0]?.id;
    if (!inserted) {
      throw new WebhookDeliveryError("the endpoint-disabled notice was not stored — no row was written; retry the action");
    }
  }
}

async function disableEndpoint(
  orgId: string,
  endpointId: string,
  reason: string,
  actorId: string | null,
  now: Date,
): Promise<void> {
  const updated = await db.execute(sql`
    update webhook_endpoints
       set status = 'disabled', disabled_at = ${now}, disabled_reason = ${reason}, updated_at = now(),
           updated_by = ${actorId}::uuid
     where org_id = ${orgId} and id = ${endpointId}::uuid and status = 'active'
  `);
  if ((updated.rowCount ?? 0) !== 1) {
    throw new WebhookDeliveryError("the failing endpoint was not disabled — no row was written; retry the action");
  }
  await recordWebhookAudit(db, {
    orgId,
    table: "webhook_endpoints",
    rowId: endpointId,
    action: "update",
    changes: {
      source: "webhook_delivery",
      event: "endpoint_auto_disabled",
      after: { status: "disabled", reason },
      reason,
    },
    actorId,
  });
  await notifyWebhookAdmins(orgId, {
    title: "A webhook endpoint was auto-disabled",
    body: `${reason} Re-enable it in Settings → Developers → Webhooks after fixing the receiver.`,
    href: "/admin/webhooks",
  });
}

async function recordAttemptOutcome(
  delivery: ClaimedDelivery,
  outcome: DeliveryOutcome,
  latencyMs: number,
  now: Date,
): Promise<void> {
  await withOrgContext(delivery.orgId, async () => {
    if (outcome.kind === "delivered") {
      const updated = await db.execute(sql`
        update webhook_deliveries
           set status = 'delivered', last_response_code = ${outcome.code},
               last_response_excerpt = ${outcome.excerpt}, last_latency_ms = ${latencyMs},
               last_error = null, delivered_at = ${now}, updated_at = now()
         where org_id = ${delivery.orgId} and id = ${delivery.id}::uuid
      `);
      if ((updated.rowCount ?? 0) !== 1) {
        throw new WebhookDeliveryError(`delivery ${delivery.id} outcome was not stored — no row was written; retry the action`);
      }
      await db.execute(sql`
        update webhook_endpoints
           set consecutive_failures = 0, last_delivery_at = ${now},
               last_delivery_status = 'delivered', last_error = null, updated_at = now()
         where org_id = ${delivery.orgId} and id = ${delivery.endpointId}::uuid
      `);
      return;
    }
    if (outcome.kind === "gone") {
      await db.execute(sql`
        update webhook_deliveries
           set status = 'failed', last_response_code = 410, last_latency_ms = ${latencyMs},
               last_error = 'endpoint answered 410 Gone — the subscriber is gone; the endpoint is disabled',
               updated_at = now()
         where org_id = ${delivery.orgId} and id = ${delivery.id}::uuid
      `);
      await db.execute(sql`
        update webhook_endpoints
           set last_delivery_at = ${now}, last_delivery_status = 'failed',
               last_error = 'endpoint answered 410 Gone', updated_at = now()
         where org_id = ${delivery.orgId} and id = ${delivery.endpointId}::uuid
      `);
      await disableEndpoint(
        delivery.orgId,
        delivery.endpointId,
        `endpoint answered 410 Gone on delivery ${delivery.id} — the subscriber is gone`,
        null,
        now,
      );
      return;
    }
    if (outcome.kind === "refused") {
      await db.execute(sql`
        update webhook_deliveries
           set status = 'failed', last_response_code = ${outcome.code},
               last_response_excerpt = ${outcome.excerpt}, last_latency_ms = ${latencyMs},
               last_error = ${`endpoint refused the payload with ${outcome.code} — fix the receiver or the subscription`},
               updated_at = now()
         where org_id = ${delivery.orgId} and id = ${delivery.id}::uuid
      `);
      await noteEndpointFailure(delivery, `endpoint refused the payload with ${outcome.code}`, now);
      return;
    }
    const budgetStart = delivery.occurredAt;
    const exhausted = now.getTime() - new Date(budgetStart).getTime() > WEBHOOK_RETRY_BUDGET_MS;
    if (exhausted) {
      await db.execute(sql`
        update webhook_deliveries
           set status = 'dead',
               last_response_code = ${outcome.code},
               last_latency_ms = ${latencyMs},
               last_error = ${`no successful attempt within 3 days: ${outcome.error}`},
               updated_at = now()
         where org_id = ${delivery.orgId} and id = ${delivery.id}::uuid
      `);
      await noteEndpointFailure(delivery, `delivery ${delivery.id} exhausted its 3-day retry budget`, now);
      return;
    }
    await db.execute(sql`
      update webhook_deliveries
         set status = 'pending',
             next_attempt_at = ${new Date(now.getTime() + deliveryBackoffMs(delivery.attemptCount))},
             last_response_code = ${outcome.code},
             last_latency_ms = ${latencyMs},
             last_error = ${outcome.error},
             updated_at = now()
       where org_id = ${delivery.orgId} and id = ${delivery.id}::uuid
    `);
    await noteEndpointFailure(delivery, outcome.error, now);
  });
}

async function noteEndpointFailure(delivery: ClaimedDelivery, error: string, now: Date): Promise<void> {
  const row = (await db.execute<{ failures: number; threshold: number }>(sql`
    update webhook_endpoints
       set consecutive_failures = consecutive_failures + 1,
           last_delivery_at = ${now}, last_delivery_status = 'failed', last_error = ${error},
           updated_at = now()
     where org_id = ${delivery.orgId} and id = ${delivery.endpointId}::uuid
    returning consecutive_failures as failures, auto_disable_after as threshold
  `)).rows[0];
  if (!row) {
    throw new WebhookDeliveryError("the endpoint failure streak was not stored — no row was written; retry the action");
  }
  if (row.failures >= row.threshold) {
    await disableEndpoint(
      delivery.orgId,
      delivery.endpointId,
      `endpoint failed ${row.failures} times in a row (threshold ${row.threshold}); last error: ${error}`,
      null,
      now,
    );
  }
}

function deliveryBody(delivery: ClaimedDelivery): string {
  return JSON.stringify({
    id: delivery.id,
    event: delivery.eventType,
    occurredAt: new Date(delivery.occurredAt).toISOString(),
    data: delivery.payload,
  });
}

function signatureHeaders(delivery: ClaimedDelivery, body: string, timestampUnix: number): Record<string, string> {
  const scope = { orgId: delivery.orgId, purpose: "webhook.endpoint.secret" };
  const current = unsealSecret(delivery.secretSealed, scope);
  let header = buildSignatureHeader(current, timestampUnix, body);
  if (delivery.secretPreviousSealed) {
    try {
      const previous = unsealSecret(delivery.secretPreviousSealed, scope);
      header += `,${buildSignatureHeader(previous, timestampUnix, body).split(",")[1]}`;
    } catch {
      // A previous secret that no longer unseals (re-sealed data key the
      // worker does not hold) must not fail the delivery the current
      // secret already signs — the rotation audit names the re-entry.
    }
  }
  return {
    "OpenBooks-Event": delivery.eventType,
    "OpenBooks-Delivery": delivery.id,
    "OpenBooks-Signature": header,
  };
}

async function attemptClaimedDelivery(
  delivery: ClaimedDelivery,
  now: Date,
  post: PostDelivery = postWebhookDelivery,
): Promise<void> {
  if (delivery.endpointStatus !== "active") {
    await withOrgContext(delivery.orgId, async () => {
      await db.execute(sql`
        update webhook_deliveries
           set status = 'failed', last_error = 'endpoint is disabled — re-enable it in Settings → Developers → Webhooks, then redeliver',
               updated_at = now()
         where org_id = ${delivery.orgId} and id = ${delivery.id}::uuid
      `);
    });
    return;
  }
  const body = deliveryBody(delivery);
  const timestampUnix = Math.floor(now.getTime() / 1000);
  const started = Date.now();
  let outcome: DeliveryOutcome;
  try {
    const headers = signatureHeaders(delivery, body, timestampUnix);
    const response = await post(delivery.endpointUrl, body, headers);
    outcome = classifyDeliveryResponse(response.status, response.bodyExcerpt);
    if (outcome.kind === "delivered") outcome.latencyMs = Date.now() - started;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome = { kind: "retryable", code: null, error: message.slice(0, 1000) };
  }
  await recordAttemptOutcome(delivery, outcome, Date.now() - started, now);
}

/**
 * Attempt one queued delivery now, synchronously (manual redelivery and
 * test pings). Claims the pending row atomically — anything already run,
 * delivered, or claimed past its lease refuses by name.
 */
export async function attemptDeliveryNow(
  orgId: string,
  deliveryId: string,
  now = new Date(),
  post: PostDelivery = postWebhookDelivery,
): Promise<void> {
  const claimed = await withOrgContext(orgId, async () => {
    const row = (await db.execute<ClaimedDelivery>(sql`
      update webhook_deliveries d
         set attempt_count = d.attempt_count + 1,
             last_attempt_at = ${now},
             first_attempt_at = coalesce(d.first_attempt_at, ${now}),
             next_attempt_at = ${new Date(now.getTime() + WEBHOOK_CLAIM_LEASE_MS)},
             updated_at = now()
        from webhook_events e, webhook_endpoints ep
       where d.id = ${deliveryId}::uuid and d.org_id = ${orgId}
         and d.status = 'pending'
         and e.org_id = d.org_id and e.id = d.event_id
         and ep.org_id = d.org_id and ep.id = d.endpoint_id
      returning d.id::text as id, d.org_id as "orgId", d.event_id as "eventId",
                d.endpoint_id as "endpointId", d.attempt_count as "attemptCount",
                e.event_type as "eventType", e.payload as payload, e.occurred_at as "occurredAt",
                ep.url as "endpointUrl", ep.secret_sealed as "secretSealed",
                ep.secret_previous_sealed as "secretPreviousSealed",
                ep.consecutive_failures as "consecutiveFailures",
                ep.auto_disable_after as "autoDisableAfter",
                ep.status as "endpointStatus"
    `)).rows[0];
    return row ?? null;
  });
  if (!claimed) {
    throw new WebhookDeliveryError(
      "the delivery is not queued for attempt — it already ran, succeeded, or is claimed by the worker; reload and try again",
    );
  }
  await attemptClaimedDelivery(claimed, now, post);
}

/**
 * Deliver every due webhook delivery once: claim under bypass, attempt
 * over HTTP, record the outcome in the tenant's scope. Invoked by the
 * `webhook_delivery` scheduler scan and by the integration suite.
 */
export async function runWebhookDeliveryScan(
  now = new Date(),
  limit = 100,
  post: PostDelivery = postWebhookDelivery,
): Promise<{ attempted: number; delivered: number }> {
  const claimed = await claimDueDeliveries(limit, now);
  let delivered = 0;
  for (const delivery of claimed) {
    await attemptClaimedDelivery(delivery, now, post);
    delivered += 1;
  }
  return { attempted: claimed.length, delivered };
}

