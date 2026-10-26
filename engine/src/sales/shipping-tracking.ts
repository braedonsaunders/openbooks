import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { verifyRelaySignature, type CarrierAdapter } from "../connectors/shipping.ts";
import {
  assertShippingFeature,
  adapterFor,
  loadShippingAccount,
  ShippingRefusal,
  type Scope,
  type Tx,
} from "./shipping-accounts.ts";
import { writeLabelAudit } from "./shipping-label-accounting.ts";

export interface RefreshTrackingInput {
  labelId: string;
  allowedSubsidiaryIds: Scope;
  transport?: typeof fetch;
  baseUrl?: string;
}

/** Re-read one label's tracker over the sealed API key and store what moved. */
export async function refreshLabelTracking(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: RefreshTrackingInput,
): Promise<{ labelId: string; trackingStatus: string; changed: boolean }> {
  await assertShippingFeature(tx, orgId);
  const label = (
    await tx.execute<{
      id: string;
      account_id: string;
      provider: string;
      provider_shipment_id: string;
      carrier: string;
      tracking_number: string | null;
      tracking_status: string;
      events: {
        id: string | null;
        status: string;
        detail: string | null;
        occurredAt: string | null;
      }[];
    }>(
      sql`
    select l.id, l.account_id, l.provider, l.provider_shipment_id, l.carrier,
           l.tracking_number, l.tracking_status, l.events
      from shipment_labels l
      join documents d on d.org_id = l.org_id and d.id = l.shipment_document_id and d.kind = 'shipment'
     where l.org_id = ${orgId} and l.id = ${input.labelId}
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, input.allowedSubsidiaryIds)}
     for update of l, d`,
      "objects",
    )
  )[0];
  if (!label) throw new ShippingRefusal("Shipping label not found", "not_found", 404);
  const account = await loadShippingAccount(tx, orgId, label.account_id);
  const adapter = adapterFor(account.provider);
  let state;
  try {
    state = await adapter.getTracker(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      {
        carrier: label.carrier,
        trackingNumber: label.tracking_number ?? undefined,
        providerShipmentId: label.provider_shipment_id,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(
        `${account.name} tracker refresh failed: ${error.message}`,
        "provider_failed",
        422,
        error.message,
      );
    }
    throw error;
  }
  return applyTrackerState(tx, orgId, actorId, label, state.status, state.events);
}

async function applyTrackerState(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  label: {
    id: string;
    tracking_status: string;
    events: {
      id: string | null;
      status: string;
      detail: string | null;
      occurredAt: string | null;
    }[];
  },
  status: string,
  incoming: {
    id: string | null;
    status: string;
    detail: string | null;
    occurredAt: string | null;
  }[],
): Promise<{ labelId: string; trackingStatus: string; changed: boolean }> {
  const seen = new Set(
    label.events.map(
      (event) => `${event.id ?? ""}|${event.occurredAt ?? ""}|${event.detail ?? ""}`,
    ),
  );
  const merged = [...label.events];
  for (const event of incoming) {
    const key = `${event.id ?? ""}|${event.occurredAt ?? ""}|${event.detail ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(event);
    }
  }
  const changed = status !== label.tracking_status || merged.length !== label.events.length;
  if (!changed) return { labelId: label.id, trackingStatus: label.tracking_status, changed: false };
  // A zero-row update is a failure: the label row is locked above.
  const updated = await tx.execute<{ id: string }>(
    sql`
    update shipment_labels
       set tracking_status = ${status}, events = ${JSON.stringify(merged)}::jsonb,
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${label.id} returning id`,
    "objects",
  );
  if (updated.length === 0) throw new Error("shipping label tracking was not recorded");
  await writeLabelAudit(tx, orgId, actorId, label.id, "update", {
    mode: "shipping_tracking",
    trackingStatus: status,
    newEvents: merged.length - label.events.length,
  });
  return { labelId: label.id, trackingStatus: status, changed: true };
}

export interface TrackerDeliveryInput {
  provider: string;
  headers: Record<string, string>;
  rawBody: string;
  transport?: typeof fetch;
  baseUrl?: string;
}

/** Provider deliveries are system provenance: a null actor, never a user. */
export const TRACKER_SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Sessionless entry for inbound tracker deliveries. The delivery names only
 * provider refs and there is no session, so the candidate orgs holding a
 * label with those refs are found bypassed (org ids only, in a fixed order)
 * — the same model as provider payment webhooks. Refs are not unique across
 * tenants (a sandbox copies its source's labels), so no candidate is trusted
 * on the refs alone: each is tried in its own org scope, where the delivery
 * must carry a valid signature from that org's carrier account relay secret
 * before anything changes. The first org whose secret verifies the delivery
 * owns it; a delivery no candidate verifies is refused.
 */
export async function receiveTrackerDelivery(
  provider: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<TrackerDeliveryResult> {
  const adapter = adapterFor(provider);
  const parsed = adapter.parseInboundEvent(safeJsonParse(rawBody));
  if (!parsed) return { status: "ignored" };
  // bypass: connector-token — a sessionless tracker delivery names only provider refs; see the docblock above.
  const orgIds = await withBypassContext(() => trackerCandidateOrgIds(provider, parsed.tracker));
  let refusal: ShippingRefusal | null = null;
  for (const orgId of orgIds) {
    try {
      const delivered = await withOrgContext(orgId, () =>
        db.transaction((tx) =>
          handleTrackerDelivery(tx, orgId, TRACKER_SYSTEM_ACTOR_ID, { provider, headers, rawBody }),
        ),
      );
      if (delivered.status === "ok") return delivered;
    } catch (error) {
      // Not this org's delivery (its secret does not verify it, it has none,
      // or the org has shipping turned off): nothing was written; try the next.
      if (
        error instanceof ShippingRefusal &&
        (error.code === "signature_invalid" ||
          error.code === "signature_required" ||
          error.code === "feature_disabled")
      ) {
        if (error.code !== "feature_disabled") refusal ??= error;
        continue;
      }
      throw error;
    }
  }
  if (refusal) throw refusal;
  return { status: "ignored" };
}

/** Orgs holding a label with the delivery's provider shipment id or tracking number, in a fixed order. */
async function trackerCandidateOrgIds(
  provider: string,
  tracker: { providerShipmentId?: string; trackingNumber?: string },
): Promise<string[]> {
  if (!tracker.providerShipmentId && !tracker.trackingNumber) return [];
  const rows = await db.execute<{ org_id: string }>(
    sql`
    select distinct org_id from shipment_labels
     where provider = ${provider}
       and (${tracker.providerShipmentId ? sql`provider_shipment_id = ${tracker.providerShipmentId}` : sql`false`}
            or ${tracker.trackingNumber ? sql`tracking_number = ${tracker.trackingNumber}` : sql`false`})
     order by org_id`,
    "objects",
  );
  return rows.map((row) => row.org_id);
}

export type TrackerDeliveryResult =
  | { status: "ignored" }
  | { status: "ok"; labelId: string; trackingStatus: string; changed: boolean };

/**
 * Handle an inbound tracker delivery. The delivery is NEVER trusted on
 * arrival: the label is resolved locally, the delivery must be signed with
 * the carrier account's relay secret (an account without one refuses every
 * delivery), and the tracker is always re-read over the sealed API key using
 * the label's own stored identifiers — never the tracker id or carrier the
 * delivery names — before any state changes. A missing or bad signature is a
 * 401 with no side effects.
 */
export async function handleTrackerDelivery(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: TrackerDeliveryInput,
  adapterOverride?: CarrierAdapter,
): Promise<TrackerDeliveryResult> {
  await assertShippingFeature(tx, orgId);
  const adapter = adapterOverride ?? adapterFor(input.provider);
  const parsed = adapter.parseInboundEvent(safeJsonParse(input.rawBody));
  if (!parsed) return { status: "ignored" };
  // Provider shipment id first, tracking number second: two plain lookups
  // instead of one nullable-parameter OR, which PostgreSQL cannot plan
  // (untyped null parameters) and which would hide precedence.
  const label = await findLabelForTracker(
    tx,
    orgId,
    parsed.tracker.providerShipmentId,
    parsed.tracker.trackingNumber,
  );
  if (!label || label.provider !== adapter.key) return { status: "ignored" };
  const account = await loadShippingAccount(tx, orgId, label.account_id);
  if (!account.webhookSecret) {
    throw new ShippingRefusal(
      `Tracker deliveries for ${account.name} are refused: the account has no relay secret`,
      "signature_required",
      401,
      `Generate a relay secret for ${account.name} in Setup → Shipping and configure the delivery sender with it`,
    );
  }
  const signature =
    input.headers["openbooks-signature"] ?? input.headers["OpenBooks-Signature"] ?? null;
  if (!verifyRelaySignature(input.rawBody, signature, account.webhookSecret)) {
    throw new ShippingRefusal(
      "Tracker delivery signature verification failed",
      "signature_invalid",
      401,
      `Configure the relay secret from ${account.name} on the delivery sender in Setup → Shipping`,
    );
  }
  let state;
  try {
    state = await adapter.getTracker(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      {
        carrier: label.carrier,
        trackingNumber: label.tracking_number ?? undefined,
        providerShipmentId: label.provider_shipment_id,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(
        `${account.name} tracker confirmation failed: ${error.message}`,
        "provider_failed",
        422,
        error.message,
      );
    }
    throw error;
  }
  const applied = await applyTrackerState(tx, orgId, actorId, label, state.status, state.events);
  return {
    status: "ok",
    labelId: applied.labelId,
    trackingStatus: applied.trackingStatus,
    changed: applied.changed,
  };
}

type TrackedLabel = {
  id: string;
  account_id: string;
  provider: string;
  provider_shipment_id: string;
  carrier: string;
  tracking_number: string | null;
  tracking_status: string;
  events: { id: string | null; status: string; detail: string | null; occurredAt: string | null }[];
};

/** Resolve the label a tracker delivery belongs to, locking it for the update. */
async function findLabelForTracker(
  tx: SqlExecutor,
  orgId: string,
  providerShipmentId: string | undefined,
  trackingNumber: string | undefined,
): Promise<TrackedLabel | undefined> {
  const columns = sql`id, account_id, provider, provider_shipment_id, carrier, tracking_number, tracking_status, events`;
  if (providerShipmentId) {
    const byShipment = (
      await tx.execute<TrackedLabel>(
        sql`
      select ${columns} from shipment_labels
       where org_id = ${orgId} and provider_shipment_id = ${providerShipmentId}
       limit 1 for update`,
        "objects",
      )
    )[0];
    if (byShipment) return byShipment;
  }
  if (trackingNumber) {
    const byTracking = (
      await tx.execute<TrackedLabel>(
        sql`
      select ${columns} from shipment_labels
       where org_id = ${orgId} and tracking_number = ${trackingNumber}
       limit 1 for update`,
        "objects",
      )
    )[0];
    if (byTracking) return byTracking;
  }
  return undefined;
}

/** Parse without throwing: a malformed delivery is ignored, never a 500. */
function safeJsonParse(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
}

// --- Carrier billing adjustments -----------------------------------------------
