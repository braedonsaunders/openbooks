import { sql } from "drizzle-orm";
import type { EmailActor } from "@openbooks/schema";
import {
  resolveEmailTransport,
  sealSecret,
  validateStoredEmailConfig,
  type AttemptRecord,
  type EmailTransport,
  type RawEmailConfig,
} from "@openbooks/emails";
import { db } from "./db.ts";

/**
 * Per-org email provider configuration lives in `orgs.settings.email` (jsonb),
 * with the single provider secret AES-sealed (never stored or returned in
 * plaintext). This module is the one place web (settings/test) and the worker
 * (delivery) read/write it, so both agree on shape + sealing.
 */

/** Read the raw stored config for an org (secret still sealed), or null. */
export async function readOrgEmailConfig(orgId: string): Promise<RawEmailConfig | null> {
  const r = (await db.execute<{ email: RawEmailConfig | null }>(sql`
    select settings -> 'email' as email from orgs where id = ${orgId}
  `));
  return r.rows[0]?.email ?? null;
}

/** What the settings UI may see — never the sealed secret, only whether one is set. */
export type OrgEmailConfigView = Omit<RawEmailConfig, "keyCiphertext" | "keyNonce"> & {
  hasSecret: boolean;
};

export async function readOrgEmailConfigView(orgId: string): Promise<OrgEmailConfigView> {
  const raw = (await readOrgEmailConfig(orgId)) ?? {};
  const { keyCiphertext, keyNonce, ...rest } = raw;
  return { ...rest, hasSecret: Boolean(keyCiphertext && keyNonce) };
}

export type SaveOrgEmailInput = Omit<RawEmailConfig, "keyCiphertext" | "keyNonce"> & {
  /** New plaintext secret to seal, or undefined to keep the existing one. */
  secret?: string | null;
};

/**
 * Merge + persist an org's email config. A provided `secret` is sealed; a null
 * secret clears it; undefined keeps the stored one. Validates before saving so
 * a bad config fails loudly at the API boundary.
 */
export async function saveOrgEmailConfig(orgId: string, input: SaveOrgEmailInput): Promise<void> {
  const existing = (await readOrgEmailConfig(orgId)) ?? {};
  const { secret, ...fields } = input;

  const next: RawEmailConfig = { ...existing, ...fields };
  if (secret === null) {
    delete next.keyCiphertext;
    delete next.keyNonce;
  } else if (typeof secret === "string" && secret.trim()) {
    const sealed = sealSecret(secret.trim());
    next.keyCiphertext = sealed.ciphertext;
    next.keyNonce = sealed.nonce;
  }

  validateStoredEmailConfig(next, { requireComplete: next.enabled === true });

  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{email}', ${JSON.stringify(next)}::jsonb)
     where id = ${orgId}
  `);
}

/** Resolve an org's sendable transport (secret unsealed), or null if unconfigured. */
export async function resolveOrgEmailTransport(orgId: string): Promise<EmailTransport | null> {
  return resolveEmailTransport(await readOrgEmailConfig(orgId));
}

// --- email_log ---------------------------------------------------------------

export async function insertEmailLog(row: {
  orgId: string;
  jobId?: string | null;
  provider?: string | null;
  recipients: string[];
  fromAddr?: string | null;
  replyToAddr?: string | null;
  subject: string;
  status: "queued" | "sent" | "failed" | "suppressed";
  categoryKey?: string | null;
  meta?: Record<string, unknown>;
  errorMessage?: string | null;
  /**
   * Who caused this send. A user actor is written to the canonical
   * created_by audit column; a system actor leaves created_by null and stamps
   * explicit provenance (meta.actorKind + meta.actorReason). The markers are
   * applied after the caller's meta so attribution evidence can be neither
   * forged nor stripped by it.
   */
  actor?: EmailActor;
}): Promise<string> {
  if (row.actor?.kind === "user" && !row.actor.userId.trim()) {
    throw new Error("email_log user attribution requires a non-empty user id");
  }
  const meta: Record<string, unknown> = { ...row.meta };
  if (row.actor) {
    meta.actorKind = row.actor.kind;
    if (row.actor.kind === "system") meta.actorReason = row.actor.reason;
    else delete meta.actorReason;
  }
  const createdBy = row.actor?.kind === "user" ? row.actor.userId : null;
  const r = (await db.execute<{ id: string }>(sql`
    insert into email_log (org_id, job_id, provider, recipients, recipient_primary, from_addr, reply_to_addr, subject, status, category_key, meta, error_message, sent_at, created_by)
    values (
      ${row.orgId}, ${row.jobId ?? null}, ${row.provider ?? null},
      ${JSON.stringify(row.recipients)}::jsonb, ${row.recipients[0] ?? null},
      ${row.fromAddr ?? null}, ${row.replyToAddr ?? null}, ${row.subject},
      ${row.status}, ${row.categoryKey ?? null}, ${JSON.stringify(meta)}::jsonb,
      ${row.errorMessage ?? null}, ${row.status === "sent" ? sql`now()` : null},
      ${createdBy}
    )
    returning id
  `));
  return r.rows[0]!.id;
}

export async function markEmailSent(orgId: string, id: string, providerMessageId: string): Promise<void> {
  await db.execute(sql`
    update email_log set status = 'sent', provider_message_id = ${providerMessageId}, sent_at = now(), updated_at = now()
     where id = ${id} and org_id = ${orgId}
  `);
}

export async function markEmailFailed(orgId: string, id: string, error: string): Promise<void> {
  // Guarded transition: confirmed acceptance (`sent`) and unresolved
  // uncertainty must never be overwritten by a later failure mark — a retried
  // attempt that fails after its predecessor was accepted has no authority to
  // rewrite the outcome (audit finding #52).
  await db.execute(sql`
    update email_log set status = 'failed', error_message = ${error.slice(0, 500)}, updated_at = now()
     where id = ${id} and org_id = ${orgId} and status in ('queued', 'failed')
  `);
}

/**
 * Park an attempt whose acceptance state could not be proven. An uncertain row
 * is the reconciliation trigger: nothing re-sends while it stands open.
 */
export async function markEmailUncertain(orgId: string, id: string, reason: string): Promise<void> {
  await db.execute(sql`
    update email_log set status = 'uncertain', error_message = ${reason.slice(0, 500)}, updated_at = now()
     where id = ${id} and org_id = ${orgId} and status in ('queued', 'failed')
  `);
}

/** Acknowledge provider acceptance; legal from any non-suppressed state, so a late reconciliation can still complete a delivery idempotently. */
export async function confirmEmailSentGuarded(orgId: string, id: string, providerMessageId: string): Promise<boolean> {
  const r = await db.execute<{ id: string }>(sql`
    update email_log set status = 'sent', provider_message_id = ${providerMessageId}, sent_at = coalesce(sent_at, now()), updated_at = now(), error_message = null
     where id = ${id} and org_id = ${orgId} and status in ('queued', 'failed', 'uncertain')
    returning id
  `);
  if (r.rows.length > 0) return true;
  // Already-sent with the identical message id is also success — completion
  // must be idempotent for replayed reconciliations.
  const existing = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from email_log
     where id = ${id} and org_id = ${orgId} and status = 'sent' and provider_message_id = ${providerMessageId}
  `);
  return (existing.rows[0]?.count ?? 0) > 0;
}

/** Record the terminal suppression reason on an open row without touching final states. */
export async function markEmailSuppressed(orgId: string, id: string, reason: string): Promise<void> {
  await db.execute(sql`
    update email_log set status = 'suppressed', error_message = ${reason.slice(0, 500)}, updated_at = now()
     where id = ${id} and org_id = ${orgId} and status in ('queued', 'failed', 'uncertain')
  `);
}

// --- canonical delivery lineage ----------------------------------------------

/** One attempt's evidence inside meta.attempts — append-only, never rewritten. */
export async function appendEmailAttemptEvent(orgId: string, id: string, event: {
  attempt?: number;
  outcome?: AttemptRecord["outcome"] | "blocked" | "suppressed" | "started";
  detail?: string | null;
}): Promise<AttemptRecord[]> {
  const payload = { at: new Date().toISOString(), ...event };
  await db.execute(sql`
    update email_log
       set meta = jsonb_set(meta, '{attempts}', coalesce(meta -> 'attempts', '[]'::jsonb) || ${JSON.stringify(payload)}::jsonb),
           updated_at = now()
     where id = ${id} and org_id = ${orgId}
  `);
  return readAttemptLineage(orgId, id);
}

async function readAttemptLineage(orgId: string, id: string): Promise<AttemptRecord[]> {
  const r = await db.execute<{ attempts: AttemptRecord[] | null }>(sql`
    select meta -> 'attempts' as attempts from email_log where id = ${id} and org_id = ${orgId}
  `);
  return r.rows[0]?.attempts ?? [];
}

function normalizeAttempts(attempts: unknown): AttemptRecord[] {
  if (!Array.isArray(attempts)) return [];
  return attempts.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const outcome = record.outcome === "sent" || record.outcome === "notSent" || record.outcome === "uncertain" ? record.outcome : null;
    if (!outcome) return [];
    return [{
      attempt: typeof record.attempt === "number" ? record.attempt : 1,
      outcome,
      detail: typeof record.detail === "string" ? record.detail : null,
    }];
  });
}

/**
 * Claim the CANONICAL email_log row for one logical delivery. Every attempt of
 * the same delivery key lands on this single row (unique partial index
 * email_log_delivery_key backs the race), so attempt lineage, reconciliation,
 * and duplicate prevention all read one source of truth.
 */
export async function claimEmailDeliveryLog(row: {
  orgId: string;
  deliveryKey: string;
  jobId?: string | null;
  provider?: string | null;
  recipients: string[];
  fromAddr?: string | null;
  replyToAddr?: string | null;
  subject: string;
  categoryKey?: string | null;
  meta?: Record<string, unknown>;
  /** Terminal insertion status for branches that never reach the network (suppressed). */
  status?: "queued" | "suppressed";
  errorMessage?: string | null;
  actor?: EmailActor;
}): Promise<{ id: string; status: string; attempts: AttemptRecord[] }> {
  if (row.actor?.kind === "user" && !row.actor.userId.trim()) {
    throw new Error("email_log user attribution requires a non-empty user id");
  }
  const meta: Record<string, unknown> = { ...row.meta };
  if (row.actor) {
    meta.actorKind = row.actor.kind;
    if (row.actor.kind === "system") meta.actorReason = row.actor.reason;
    else delete meta.actorReason;
  }
  const createdBy = row.actor?.kind === "user" ? row.actor.userId : null;
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into email_log (org_id, job_id, delivery_key, provider, recipients, recipient_primary, from_addr, reply_to_addr, subject, status, category_key, meta, error_message, created_by)
    values (
      ${row.orgId}, ${row.jobId ?? null}, ${row.deliveryKey}, ${row.provider ?? null},
      ${JSON.stringify(row.recipients)}::jsonb, ${row.recipients[0] ?? null},
      ${row.fromAddr ?? null}, ${row.replyToAddr ?? null}, ${row.subject},
      ${row.status ?? "queued"}, ${row.categoryKey ?? null}, ${JSON.stringify(meta)}::jsonb,
      ${row.errorMessage ?? null}, ${createdBy}
    )
    on conflict (delivery_key) where delivery_key is not null do nothing
    returning id
  `));
  if (inserted.rows[0]) {
    return { id: inserted.rows[0].id, status: row.status ?? "queued", attempts: [] };
  }
  const existing = (await db.execute<{ id: string; status: string; attempts: unknown }>(sql`
    select id, status, meta -> 'attempts' as attempts
      from email_log
     where org_id = ${row.orgId} and delivery_key = ${row.deliveryKey}
  `));
  const found = existing.rows[0];
  if (!found) throw new Error("delivery log claim lost between insert conflict and lookup");
  return { id: found.id, status: found.status, attempts: normalizeAttempts(found.attempts) };
}
