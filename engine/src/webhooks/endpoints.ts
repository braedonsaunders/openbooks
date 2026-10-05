import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { sealSecret } from "../platform/secrets.ts";
import { connectorUrlRefusal } from "../connectors/ssrf-guard.ts";
import { FANOUT_EVENT_TYPES } from "./catalog.ts";
import { attemptDeliveryNow, deliveryUrlRefusal, isLoopbackHostname } from "./deliver.ts";
import { enqueueTargetedDelivery } from "./emit.ts";

/**
 * Subscriber-endpoint administration — create, update, disable/enable,
 * secret rotation, manual redelivery and test pings. Every mutation runs
 * in the org's transaction behind the `outboundWebhooks` gate and the
 * `webhooks.manage` permission, checks its affected row count, and writes
 * audit evidence naming actor, timestamp, and before/after state. The
 * plaintext signing secret is returned once at creation or rotation and
 * never stored.
 */

export const WEBHOOK_SECRET_PURPOSE = "webhook.endpoint.secret";

export class WebhookEndpointError extends Error {
  readonly status: 403 | 404 | 409 | 422;
  constructor(message: string, status: 403 | 404 | 409 | 422 = 422) {
    super(message);
    this.status = status;
  }
}

const ENDPOINT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type WebhookAuditInput = {
  orgId: string;
  table: "webhook_endpoints" | "webhook_deliveries";
  rowId: string;
  action: "insert" | "update";
  changes: Record<string, unknown>;
  actorId: string | null;
};

export async function recordWebhookAudit(
  executor: SqlExecutor,
  input: WebhookAuditInput,
): Promise<void> {
  await executor.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, ${input.table}, ${input.rowId}, ${input.action},
            ${JSON.stringify({ source: "webhooks", ...input.changes })}::jsonb,
            ${input.actorId}::uuid)
  `);
}

async function requireWebhooksManage(orgId: string, actorId: string): Promise<void> {
  const ok = await actorHasPermission(db, orgId, actorId, "webhooks.manage");
  if (!ok) {
    throw new WebhookEndpointError(
      "managing webhook endpoints requires the webhooks.manage permission — ask an administrator to grant it in /admin/roles",
      403,
    );
  }
}

async function requireWebhooksGate(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner, orgId, "outboundWebhooks"))) {
    throw new WebhookEndpointError(
      "outbound webhooks are switched off for this organization — enable them in Company Settings → Features before managing endpoints",
      403,
    );
  }
}

function checkEndpointKey(key: string): string {
  const trimmed = key.trim();
  if (!ENDPOINT_KEY_RE.test(trimmed)) {
    throw new WebhookEndpointError(
      `endpoint key '${key}' is invalid — use 1–64 lowercase letters, digits, dashes or underscores starting with a letter or digit`,
    );
  }
  return trimmed;
}

function checkSubscribedEvents(events: unknown): string[] {
  if (!Array.isArray(events) || !events.every((e) => typeof e === "string")) {
    throw new WebhookEndpointError("subscribed events must be a list of event type names");
  }
  const unknown = events.filter((e) => !FANOUT_EVENT_TYPES.has(e));
  if (unknown.length > 0) {
    throw new WebhookEndpointError(
      `unknown or non-subscribable event type(s) ${unknown.map((e) => `'${e}'`).join(", ")} — ` +
      `subscribable types are: ${[...FANOUT_EVENT_TYPES].join(", ")}`,
    );
  }
  return [...new Set(events)] as string[];
}

async function checkEndpointUrl(url: string): Promise<string> {
  const trimmed = url.trim();
  const refusal = deliveryUrlRefusal(trimmed);
  if (refusal) throw new WebhookEndpointError(refusal);
  const parsed = new URL(trimmed);
  // Save-time DNS refusal is an early, operable error; the request-time
  // guarded fetch stays the real guard against rebinding.
  if (!(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
    const ssrfRefusal = await connectorUrlRefusal(trimmed);
    if (ssrfRefusal) {
      throw new WebhookEndpointError(
        `webhook URL '${trimmed}' is refused: ${ssrfRefusal} — subscribe a publicly reachable https:// URL`,
      );
    }
  }
  return trimmed;
}

function newEndpointSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** A text[] bind the pg driver cannot mistranslate: one parameter per element. */
function textArray(values: readonly string[]): ReturnType<typeof sql> {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`array[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]`;
}

export type CreateEndpointInput = {
  key: string;
  url: string;
  description?: string;
  events: string[];
};

export async function createWebhookEndpoint(
  orgId: string,
  actorId: string,
  input: CreateEndpointInput,
): Promise<{ id: string; secret: string }> {
  await requireWebhooksManage(orgId, actorId);
  const key = checkEndpointKey(input.key);
  const url = await checkEndpointUrl(input.url);
  const events = checkSubscribedEvents(input.events);
  const secret = newEndpointSecret();
  return withOrgTransaction(orgId, async () => {
    await requireWebhooksGate(db, orgId);
    const sealed = sealSecret(secret, { orgId, purpose: WEBHOOK_SECRET_PURPOSE });
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into webhook_endpoints (org_id, key, url, description, events, status, secret_sealed,
                                     created_by, updated_by)
      values (${orgId}, ${key}, ${url}, ${(input.description ?? "").slice(0, 500)},
              ${textArray(events)}, 'active', ${sealed}, ${actorId}::uuid, ${actorId}::uuid)
      returning id
    `)).rows[0]?.id;
    if (!inserted) {
      throw new WebhookEndpointError("the webhook endpoint was not stored — no row was written; retry the action");
    }
    await recordWebhookAudit(db, {
      orgId,
      table: "webhook_endpoints",
      rowId: inserted,
      action: "insert",
      changes: { after: { key, url, events, status: "active" }, reason: "Operator created the subscriber endpoint." },
      actorId,
    });
    return { id: inserted, secret };
  }).catch((error: unknown) => {
    if (error instanceof Error && /duplicate key|webhook_endpoints_key_unique/.test(error.message)) {
      throw new WebhookEndpointError(
        `endpoint key '${key}' is already taken in this organization — use a different key`,
        409,
      );
    }
    throw error;
  });
}

export type UpdateEndpointInput = {
  url?: string;
  description?: string;
  events?: string[];
};

export async function updateWebhookEndpoint(
  orgId: string,
  actorId: string,
  endpointId: string,
  input: UpdateEndpointInput,
): Promise<void> {
  await requireWebhooksManage(orgId, actorId);
  const url = input.url !== undefined ? await checkEndpointUrl(input.url) : undefined;
  const events = input.events !== undefined ? checkSubscribedEvents(input.events) : undefined;
  const description = input.description !== undefined ? input.description.slice(0, 500) : undefined;
  await withOrgTransaction(orgId, async () => {
    await requireWebhooksGate(db, orgId);
    const before = (await db.execute<{
      url: string; description: string; events: string[]; status: string;
    }>(sql`
      select url, description, events, status from webhook_endpoints
       where org_id = ${orgId} and id = ${endpointId}::uuid limit 1
    `)).rows[0];
    if (!before) {
      throw new WebhookEndpointError("the webhook endpoint is gone — it may have been deleted; reload the list and try again", 404);
    }
    const updated = await db.execute(sql`
      update webhook_endpoints
         set url = coalesce(${url ?? null}, url),
             description = coalesce(${description ?? null}, description),
             events = coalesce(${events ? textArray(events) : null}, events),
             updated_at = now(), updated_by = ${actorId}::uuid
       where org_id = ${orgId} and id = ${endpointId}::uuid
    `);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new WebhookEndpointError("the webhook endpoint was not updated — no row was written; retry the action");
    }
    await recordWebhookAudit(db, {
      orgId,
      table: "webhook_endpoints",
      rowId: endpointId,
      action: "update",
      changes: {
        before: { url: before.url, description: before.description, events: before.events },
        after: { url: url ?? before.url, description: description ?? before.description, events: events ?? before.events },
        reason: "Operator updated the subscriber endpoint.",
      },
      actorId,
    });
  });
}

export async function setWebhookEndpointStatus(
  orgId: string,
  actorId: string,
  endpointId: string,
  status: "active" | "disabled",
  reason?: string,
): Promise<void> {
  await requireWebhooksManage(orgId, actorId);
  await withOrgTransaction(orgId, async () => {
    await requireWebhooksGate(db, orgId);
    const before = (await db.execute<{ status: string }>(sql`
      select status from webhook_endpoints where org_id = ${orgId} and id = ${endpointId}::uuid limit 1
    `)).rows[0];
    if (!before) {
      throw new WebhookEndpointError("the webhook endpoint is gone — it may have been deleted; reload the list and try again", 404);
    }
    const updated = status === "active"
      ? await db.execute(sql`
          update webhook_endpoints
             set status = 'active', consecutive_failures = 0, disabled_at = null, disabled_reason = null,
                 last_error = null, updated_at = now(), updated_by = ${actorId}::uuid
           where org_id = ${orgId} and id = ${endpointId}::uuid
        `)
      : await db.execute(sql`
          update webhook_endpoints
             set status = 'disabled', disabled_at = now(),
                 disabled_reason = ${reason ?? "Disabled by the operator."},
                 updated_at = now(), updated_by = ${actorId}::uuid
           where org_id = ${orgId} and id = ${endpointId}::uuid
        `);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new WebhookEndpointError("the webhook endpoint status was not stored — no row was written; retry the action");
    }
    await recordWebhookAudit(db, {
      orgId,
      table: "webhook_endpoints",
      rowId: endpointId,
      action: "update",
      changes: {
        before: { status: before.status },
        after: { status },
        reason: reason ?? "Operator changed the endpoint status.",
      },
      actorId,
    });
  });
}

/**
 * Rotate the signing secret: the current sealed secret becomes the
 * previous one (deliveries carry both signatures during the overlap)
 * and the fresh secret seals in its place. Returns the plaintext once.
 */
export async function rotateWebhookEndpointSecret(
  orgId: string,
  actorId: string,
  endpointId: string,
): Promise<{ secret: string }> {
  await requireWebhooksManage(orgId, actorId);
  const secret = newEndpointSecret();
  return withOrgTransaction(orgId, async () => {
    await requireWebhooksGate(db, orgId);
    const before = (await db.execute<{ secretRotatedAt: Date | null }>(sql`
      select secret_rotated_at as "secretRotatedAt" from webhook_endpoints
       where org_id = ${orgId} and id = ${endpointId}::uuid limit 1
    `)).rows[0];
    if (!before) {
      throw new WebhookEndpointError("the webhook endpoint is gone — it may have been deleted; reload the list and try again", 404);
    }
    const updated = (await db.execute<{ rotatedAt: Date }>(sql`
      update webhook_endpoints
         set secret_previous_sealed = secret_sealed,
             secret_sealed = ${sealSecret(secret, { orgId, purpose: WEBHOOK_SECRET_PURPOSE })},
             secret_rotated_at = now(), updated_at = now(), updated_by = ${actorId}::uuid
       where org_id = ${orgId} and id = ${endpointId}::uuid
      returning secret_rotated_at as "rotatedAt"
    `));
    if ((updated.rowCount ?? 0) !== 1 || !updated.rows[0]) {
      throw new WebhookEndpointError("the rotated secret was not stored — no row was written; retry the action");
    }
    await recordWebhookAudit(db, {
      orgId,
      table: "webhook_endpoints",
      rowId: endpointId,
      action: "update",
      changes: {
        event: "secret_rotated",
        before: { secretRotatedAt: before.secretRotatedAt },
        after: { secretRotatedAt: updated.rows[0].rotatedAt },
        reason: "Operator rotated the signing secret. Deliveries carry both signatures until the next rotation.",
      },
      actorId,
    });
    return { secret };
  });
}

export type RedeliverResult = {
  deliveryId: string;
  eventId: string;
  status: string;
  responseCode: number | null;
  error: string | null;
};

/**
 * Manually redeliver a terminal delivery (failed or dead). The attempt
 * budget restarts — a fresh first attempt with the current secret — and
 * the attempt runs synchronously so the operator sees the outcome.
 */
export async function redeliverWebhookDelivery(
  orgId: string,
  actorId: string,
  deliveryId: string,
): Promise<RedeliverResult> {
  await requireWebhooksManage(orgId, actorId);
  const eventId = await withOrgTransaction(orgId, async () => {
    await requireWebhooksGate(db, orgId);
    const row = (await db.execute<{ eventId: string; status: string }>(sql`
      select event_id as "eventId", status from webhook_deliveries
       where org_id = ${orgId} and id = ${deliveryId}::uuid limit 1
    `)).rows[0];
    if (!row) {
      throw new WebhookEndpointError("the delivery is gone — it may have been cleaned up; reload the list and try again", 404);
    }
    if (row.status === "delivered") {
      throw new WebhookEndpointError("the delivery already succeeded — redelivery is for failed or dead deliveries");
    }
    if (row.status === "pending") {
      throw new WebhookEndpointError("the delivery is already queued — wait for the worker or watch its next attempt");
    }
    const reset = await db.execute(sql`
      update webhook_deliveries
         set status = 'pending', attempt_count = 0, first_attempt_at = null,
             next_attempt_at = now(), last_error = null, updated_at = now()
       where org_id = ${orgId} and id = ${deliveryId}::uuid
    `);
    if ((reset.rowCount ?? 0) !== 1) {
      throw new WebhookEndpointError("the delivery was not re-queued — no row was written; retry the action");
    }
    await recordWebhookAudit(db, {
      orgId,
      table: "webhook_deliveries",
      rowId: deliveryId,
      action: "update",
      changes: {
        before: { status: row.status },
        after: { status: "pending" },
        reason: "Operator manually redelivered.",
      },
      actorId,
    });
    return row.eventId;
  });
  await attemptDeliveryNow(orgId, deliveryId);
  const outcome = (await db.execute<{ status: string; code: number | null; error: string | null }>(sql`
    select status, last_response_code as code, last_error as error from webhook_deliveries
     where id = ${deliveryId}::uuid limit 1
  `)).rows[0];
  if (!outcome) throw new WebhookEndpointError("the redelivered delivery vanished — reload the list and try again");
  return { deliveryId, eventId, status: outcome.status, responseCode: outcome.code, error: outcome.error };
}

export type TestPingResult = {
  deliveryId: string;
  eventId: string;
  status: string;
  responseCode: number | null;
  error: string | null;
};

/**
 * Send a synthetic `endpoint.tested` event to one active endpoint and
 * wait for the outcome (at most the delivery timeout). Recorded as a
 * real delivery so the attempt and response stay observable; it never
 * fans out to other subscribers.
 */
export async function sendWebhookTestPing(
  orgId: string,
  actorId: string,
  endpointId: string,
): Promise<TestPingResult> {
  await requireWebhooksManage(orgId, actorId);
  const endpoint = await withOrgTransaction(orgId, async () => {
    await requireWebhooksGate(db, orgId);
    const row = (await db.execute<{ id: string; key: string; status: string }>(sql`
      select id, key, status from webhook_endpoints
       where org_id = ${orgId} and id = ${endpointId}::uuid limit 1
    `)).rows[0];
    if (!row) {
      throw new WebhookEndpointError("the webhook endpoint is gone — it may have been deleted; reload the list and try again", 404);
    }
    if (row.status !== "active") {
      throw new WebhookEndpointError(
        "the endpoint is disabled — re-enable it in Settings → Developers → Webhooks before sending a test event",
      );
    }
    return row;
  });
  const emitted = await withOrgTransaction(orgId, async () => {
    const result = await enqueueTargetedDelivery(db, {
      orgId,
      endpointId,
      type: "endpoint.tested",
      entityKind: "webhook_endpoint",
      entityId: endpointId,
      dedupeKey: `endpoint.tested:${endpointId}:${Date.now()}:${randomUUID()}`,
      payload: {
        v: 1,
        occurredAt: new Date().toISOString(),
        endpointId,
        endpointKey: endpoint.key,
      },
    });
    if (!result) {
      throw new WebhookEndpointError(
        "outbound webhooks are switched off for this organization — enable them in Company Settings → Features before sending a test event",
      );
    }
    return result;
  });
  const pingDeliveryId = await deliveryIdForEvent(orgId, emitted.eventId, endpointId);
  await attemptDeliveryNow(orgId, pingDeliveryId);
  const outcome = (await db.execute<{ status: string; code: number | null; error: string | null }>(sql`
    select status, last_response_code as code, last_error as error from webhook_deliveries
     where org_id = ${orgId} and event_id = ${emitted.eventId}::uuid and endpoint_id = ${endpointId}::uuid limit 1
  `)).rows[0];
  if (!outcome) throw new WebhookEndpointError("the test delivery vanished — reload the list and try again");
  await withOrgTransaction(orgId, async () => {
    await recordWebhookAudit(db, {
      orgId,
      table: "webhook_deliveries",
      rowId: pingDeliveryId,
      action: "insert",
      changes: {
        event: "test_ping",
        after: { status: outcome.status, responseCode: outcome.code },
        reason: "Operator sent a test event.",
      },
      actorId,
    });
  });
  return {
    deliveryId: pingDeliveryId,
    eventId: emitted.eventId,
    status: outcome.status,
    responseCode: outcome.code,
    error: outcome.error,
  };
}

async function deliveryIdForEvent(orgId: string, eventId: string, endpointId: string): Promise<string> {
  const row = (await db.execute<{ id: string }>(sql`
    select id from webhook_deliveries
     where org_id = ${orgId} and event_id = ${eventId}::uuid and endpoint_id = ${endpointId}::uuid limit 1
  `)).rows[0];
  if (!row) throw new WebhookEndpointError("the test delivery was not queued — no row was written; retry the action");
  return row.id;
}

/** Endpoint a stored `endpointKey` names: active and gate-guarded, or a named refusal. */
export async function resolveAutomationEndpoint(
  orgId: string,
  endpointKey: string,
): Promise<{ id: string; key: string }> {
  const row = (await db.execute<{ id: string; key: string; status: string }>(sql`
    select id, key, status from webhook_endpoints
     where org_id = ${orgId} and key = ${endpointKey} limit 1
  `)).rows[0];
  if (!row) {
    throw new WebhookEndpointError(
      `webhook endpoint '${endpointKey}' does not exist in this organization — create it in Settings → Developers → Webhooks, then run again`,
      404,
    );
  }
  if (row.status !== "active") {
    throw new WebhookEndpointError(
      `webhook endpoint '${endpointKey}' is disabled — re-enable it in Settings → Developers → Webhooks, then run again`,
    );
  }
  return { id: row.id, key: row.key };
}

