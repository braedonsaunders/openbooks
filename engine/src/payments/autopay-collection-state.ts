import { lockActorIdentity } from "../organization/actor-permissions.ts";
import { sql } from "drizzle-orm";
import { db, orgContext, pool, withOrg } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import {
  ACCEPTANCE_ADAPTERS,
  configSecrets,
  type AcceptanceProvider,
  type OffSessionChargeOutcome,
  type OffSessionChargeRequest,
  type ProviderConfigRow,
} from "./acceptance.ts";
import { loadPaymentProviderConfig } from "./payment-link-session-expiry.ts";
import { AutopayError, type ChargeFn } from "./autopay-policy.ts";

/** Shared collection vocabulary: run results, candidates, attempt rows, idempotency and claim keys, and the off-session charge primitive. */

/** Default charge path: the provider adapter behind the org's PSP config. */
export async function adapterCharge(
  orgId: string,
  provider: AcceptanceProvider,
  req: OffSessionChargeRequest,
): Promise<OffSessionChargeOutcome> {
  const config = await requireCollectingProvider(orgId, provider);
  const adapter = ACCEPTANCE_ADAPTERS[provider];
  return adapter.chargeOffSession(configSecrets(config, orgId), {
    providerCustomerId: req.providerCustomerId,
    providerMethodId: req.providerMethodId,
    amount: req.amount,
    currency: req.currency,
    description: req.description,
    idempotencyKey: req.idempotencyKey,
  });
}

export interface AutopayRunResult {
  scanned: number;
  charged: number;
  succeeded: number;
  failed: number;
  retried: number;
  suspended: number;
  canceled: number;
  reactivated: number;
  skipped: number;
  notices: { invoiceId: string; attemptId: string | null; status: string; detail: string }[];
  orgErrors: { orgId: string; error: string }[];
}

export function emptyRunResult(): AutopayRunResult {
  return {
    scanned: 0,
    charged: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    suspended: 0,
    canceled: 0,
    reactivated: 0,
    skipped: 0,
    notices: [],
    orgErrors: [],
  };
}

// A type alias (not an interface): SQL row types need the implicit index
// signature only object-literal types carry, or db.execute<T> refuses them.
export type CollectionCandidate = {
  invoiceId: string;
  documentNumber: string;
  openBalance: string;
  currency: string;
  partyId: string;
  subsidiaryId: string | null;
  documentDate: string | null;
  dueDate: string | null;
  enrollmentId: string;
  subscriptionId: string | null;
  methodId: string;
  provider: AcceptanceProvider;
  providerCustomerId: string | null;
  providerMethodId: string | null;
  failedPosition?: number | null;
  declineCode?: string | null;
};

function collectionLockKey(orgId: string, invoiceId: string): string {
  return `autopay-collection:${orgId}:${invoiceId}`;
}

/**
 * The provider idempotency key for one (invoice, schedule position). It is
 * derived, never random: the attempt row commits before the provider is
 * called, so a run that dies between the call and recording its outcome
 * leaves a row a later run replays under this same key, and the provider
 * returns the first result instead of taking the money twice. Document ids
 * are unique across organizations, so the invoice id already names the
 * organization, and the key stays inside every provider's reference limit
 * (Adyen caps merchant references at 80 characters).
 */
export function collectionIdempotencyKey(invoiceId: string, retryPosition: number): string {
  return `autopay:${invoiceId}:${retryPosition}`;
}

/**
 * How long an interrupted attempt may be replayed. Providers keep an
 * idempotency key for a limited time — Stripe for 24 hours, the shortest of
 * the supported providers — and replaying after the provider forgot the key
 * could charge a second time. Older interrupted attempts are closed for
 * operator review instead.
 */
export const REPLAY_WINDOW_HOURS = 23;

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // A failed query carries the database's own reason as its cause; the
  // statement text and parameters around it mean nothing to an operator.
  return error.message.startsWith("Failed query") && error.cause instanceof Error
    ? error.cause.message
    : error.message;
}

export function mergeRunResult(into: AutopayRunResult, one: AutopayRunResult): void {
  into.scanned += one.scanned;
  into.charged += one.charged;
  into.succeeded += one.succeeded;
  into.failed += one.failed;
  into.retried += one.retried;
  into.suspended += one.suspended;
  into.canceled += one.canceled;
  into.reactivated += one.reactivated;
  into.skipped += one.skipped;
  into.notices.push(...one.notices);
  into.orgErrors.push(...one.orgErrors);
}

/**
 * Run one step in its own committed transaction. Counters and notices the
 * step records reach `result` only after the commit, so a step that rolls
 * back never reports work that did not happen.
 */
export async function committed<T>(
  orgId: string,
  result: AutopayRunResult,
  fn: (local: AutopayRunResult) => Promise<T>,
): Promise<T> {
  const local = emptyRunResult();
  const value = await withOrg(orgId, () => fn(local));
  mergeRunResult(result, local);
  return value;
}

export function candidateFailed(
  result: AutopayRunResult,
  invoiceId: string,
): (error: unknown) => void {
  return (error) => {
    result.failed += 1;
    result.notices.push({
      invoiceId,
      attemptId: null,
      status: "failed",
      detail: errorMessage(error).slice(0, 500),
    });
  };
}

/**
 * A charge is never sent from inside a database transaction: the attempt that
 * names it must already be committed, or a later rollback would erase the
 * only record that the customer was charged.
 */
export function refuseInsideTransaction(): void {
  if (orgContext.getStore()?.txDb) {
    throw new AutopayError(
      "automatic collection must not run inside a database transaction; call it outside one so each attempt commits before its charge is sent",
    );
  }
}

/**
 * Hold one invoice's collection claim across its whole charge: claiming the
 * attempt, the provider call, and recording the outcome. It is a session
 * advisory lock on a dedicated connection, so it spans those separate
 * transactions, and it is released when its holder ends — including when the
 * process dies, because the lock dies with the connection. An 'initiated'
 * attempt seen while holding the claim therefore belongs to a run that is
 * gone, never to one still waiting on the provider. Null when another run
 * holds the claim.
 */
export async function withCollectionClaim<T>(
  orgId: string,
  invoiceId: string,
  body: () => Promise<T>,
): Promise<{ value: T } | null> {
  const key = collectionLockKey(orgId, invoiceId);
  const client = await pool.connect();
  let held = false;
  let discard: Error | undefined;
  try {
    const claimed = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [key],
    );
    if (claimed.rows[0]?.locked !== true) return null;
    held = true;
    return { value: await body() };
  } finally {
    if (held) {
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } catch (error) {
        // Destroy a broken session rather than return it to the pool still
        // holding the claim.
        discard = error as Error;
      }
    }
    client.release(discard);
  }
}

/** Refuse by name when the attempt's provider cannot collect. */
export async function requireCollectingProvider(
  orgId: string,
  provider: AcceptanceProvider,
): Promise<ProviderConfigRow> {
  const config = await loadPaymentProviderConfig<ProviderConfigRow>(orgId, provider);
  if (!config || !config.is_enabled || !config.acceptance_enabled) {
    throw new AutopayError(
      `${provider} is not enabled for automatic collection; enable it in provider settings first`,
    );
  }
  return config;
}

export type ChainLink = {
  methodId: string;
  provider: AcceptanceProvider;
  providerCustomerId: string | null;
  providerMethodId: string | null;
  fallbackOf: string | null;
};

/** A committed attempt whose charge is about to be, or was, sent. */
export interface OpenAttempt {
  id: string;
  invoiceId: string;
  position: number;
  amount: string;
  currency: string;
  provider: AcceptanceProvider;
  documentNumber: string;
  fallbackOf: string | null;
}

/**
 * Send the charge for a committed attempt, outside any transaction, under
 * the position's deterministic idempotency key. A provider call that throws
 * leaves the outcome unknown, so the attempt stays open for the next run to
 * resolve under the same key.
 */
export async function sendCharge(
  charge: ChargeFn,
  attempt: OpenAttempt,
  method: { providerCustomerId: string | null; providerMethodId: string },
): Promise<OffSessionChargeOutcome> {
  try {
    return await charge(attempt.provider, {
      providerCustomerId: method.providerCustomerId,
      providerMethodId: method.providerMethodId,
      amount: attempt.amount,
      currency: attempt.currency,
      description: `Autopay — invoice ${attempt.documentNumber}`,
      idempotencyKey: collectionIdempotencyKey(attempt.invoiceId, attempt.position),
    });
  } catch (error) {
    throw new AutopayError(
      `${attempt.provider} did not confirm the charge for invoice ${attempt.documentNumber} (${errorMessage(error)}); the attempt stays open and the next run resolves it under the same idempotency key, so the customer cannot be charged twice`,
    );
  }
}

/**
 * Insert one collection attempt row, returning its id — or null when another
 * run already owns this (invoice, position).
 */
export async function insertCollectionAttempt(
  orgId: string,
  candidate: CollectionCandidate,
  methodId: string,
  provider: AcceptanceProvider,
  fallbackOf: string | null,
  amount: string,
  currency: string,
  retryPosition: number,
  actorId: string | null,
): Promise<string | null> {
  // The unique (org, invoice, position) row is the claim on that position.
  // A conflict means a run that selected the same invoice committed this
  // position first — it owns the charge and resolves it, so standing down
  // is correct and exactly one attempt charges. Fallback rows consume later
  // positions, so the retry ladder keeps bounding total attempts.
  const attempt = await db.execute<{ id: string }>(
    sql`
    insert into collection_attempts
      (org_id, invoice_id, enrollment_id, payment_method_id, fallback_method_id, amount, currency,
       provider, status, retry_position, created_by, updated_by)
    values (${orgId}, ${candidate.invoiceId}, ${candidate.enrollmentId}, ${methodId}, ${fallbackOf},
            ${amount}, ${currency}, ${provider}, 'initiated', ${retryPosition}, ${actorId}, ${actorId})
    -- The existing invoice retry position already owns its charge; null makes this attempt stand down.
    on conflict (org_id, invoice_id, retry_position) do nothing
    returning id
  `,
    "objects",
  );
  return attempt[0]?.id ?? null;
}

/** Operator retries authorize the locked invoice, independently of shared customer visibility. */
export async function lockCollectionRetryAuthority(
  orgId: string,
  actorId: string,
  subsidiaryId: string | null,
  requestedScope: ReadonlySet<string> | null | undefined,
): Promise<void> {
  if (
    !actorId ||
    !subsidiaryId ||
    requestedScope === undefined ||
    !subsidiaryScopeAllows(requestedScope, subsidiaryId)
  ) {
    throw new ScopeNotFoundError();
  }
  const actor = await lockActorIdentity(db, orgId, actorId);
  if (!actor) throw new ScopeNotFoundError();
  const derived = await lockActorCommandAuthority(
    db,
    orgId,
    actorId,
    subsidiaryId,
    "autopay.manage",
  );
  if (!subsidiaryScopeAllows(derived, subsidiaryId)) throw new ScopeNotFoundError();
}

/** Why an invoice must not be charged right now, or null when collectible. */
export async function uncollectibleReason(
  orgId: string,
  invoiceId: string,
  status: string,
  openBalance: string,
): Promise<string | null> {
  if (status !== "posted")
    return `invoice is ${status}; only posted invoices are collected automatically`;
  if (cmp(openBalance, "0") <= 0) return "invoice no longer owes anything; nothing to collect";
  // Disputed: an unresolved provider chargeback against this invoice's money.
  // Voluntary refunds do not block — the open balance already reflects them.
  const disputed = (
    await db.execute<{ n: string }>(
      sql`
    select count(*)::text as n from payment_attempts a
     join payment_links l on l.id = a.link_id and l.org_id = a.org_id
    where l.org_id = ${orgId} and l.document_id = ${invoiceId}
      and a.status = 'refunded' and (a.event_payload->>'dispute') = 'true'
      and not exists (
        select 1 from payment_attempts later
         join payment_links ll on ll.id = later.link_id and ll.org_id = later.org_id
        where ll.org_id = ${orgId} and ll.document_id = ${invoiceId}
          and later.status = 'succeeded' and later.created_at > a.created_at
      )
  `,
      "objects",
    )
  )[0]?.n;
  if (disputed !== "0")
    return "invoice is under a provider dispute; resolve the dispute before collecting";
  // Disputed autopay money: an unconsumed chargeback marker parked by the
  // collection webhook against this invoice's own provider charge.
  const clawback = (
    await db.execute<{ n: string }>(
      sql`
    select count(*)::text as n from collection_attempts ca
     join payment_pending_clawbacks pc
       on pc.org_id = ca.org_id and pc.provider = ca.provider
      and pc.intent_ref = ca.provider_ref and pc.consumed_at is null
    where ca.org_id = ${orgId} and ca.invoice_id = ${invoiceId}
  `,
      "objects",
    )
  )[0]?.n;
  if (clawback !== "0")
    return "a chargeback was reported against this collection; reverse the receipt via payments if funds were clawed back";
  return null;
}

export async function scopeSubscriptionIds(
  orgId: string,
  candidate: Pick<CollectionCandidate, "partyId" | "subscriptionId">,
): Promise<string[]> {
  if (candidate.subscriptionId) return [candidate.subscriptionId];
  return (
    await db.execute<{ id: string }>(
      sql`
    select id from subscriptions
     where org_id = ${orgId} and customer_id = ${candidate.partyId} and status = 'active'
  `,
      "objects",
    )
  ).map((r) => r.id);
}
