import { sql } from "drizzle-orm";
import { documentRevisionSql, isDocumentRevisionToken } from "../records/revision.ts";
import type { EmailActor } from "@openbooks/schema";
import {
  resolveEmailTransport,
  sealSecret,
  validateStoredEmailConfig,
  type AttemptRecord,
  type EmailTransport,
  type RawEmailConfig,
} from "@openbooks/emails";
import { db, withOrgTransaction } from "../platform/db.ts";

/**
 * Per-org email provider configuration lives in `orgs.settings.email` (jsonb),
 * with the single provider secret AES-sealed (never stored or returned in
 * plaintext). This module is the one place web (settings/test) and the worker
 * (delivery) read/write it, so both agree on shape + sealing.
 *
 * A save is a material delivery/security change, so every write carries its
 * acting `EmailActor`, stamps the org's updated metadata, and commits redacted
 * before/after evidence into audit_log in the SAME transaction — the evidence
 * records that a credential was added/rotated/cleared without ever holding
 * secret material. The read/merge/write runs under the org row lock with an
 * optional expected-revision fence, so concurrent admin edits either merge
 * over the committed result or are rejected — never silently overwritten.
 */

/** Read the raw stored config for an org (secret still sealed), or null. */
export async function readOrgEmailConfig(orgId: string): Promise<RawEmailConfig | null> {
  const r = (await db.execute<{ email: RawEmailConfig | null }>(sql`
    select settings -> 'email' as email from orgs where id = ${orgId}
  `));
  return r.rows[0]?.email ?? null;
}

/** What the settings UI and audit evidence may see — never the sealed secret, only whether one is set. */
export type RedactedEmailConfig = Omit<RawEmailConfig, "keyCiphertext" | "keyNonce"> & {
  hasSecret: boolean;
};

/** Strip the sealed secret material, keeping only whether a credential exists. */
export function redactEmailConfig(raw: RawEmailConfig | null | undefined): RedactedEmailConfig {
  const { keyCiphertext, keyNonce, ...rest } = raw ?? {};
  return { ...rest, hasSecret: Boolean(keyCiphertext && keyNonce) };
}

/** What the settings UI may see, plus the exact org revision token for the CAS fence. */
export type OrgEmailConfigView = RedactedEmailConfig & {
  /** Exact persisted `orgs.updated_at` revision; echo it into expectedUpdatedAt to save safely. */
  updatedAt: string | null;
};

export async function readOrgEmailConfigView(orgId: string): Promise<OrgEmailConfigView> {
  const r = (await db.execute<{ email: RawEmailConfig | null; updatedAt: string | null }>(sql`
    select settings -> 'email' as email, ${documentRevisionSql(sql`updated_at`)} as "updatedAt" from orgs where id = ${orgId}
  `));
  const row = r.rows[0];
  return {
    ...redactEmailConfig(row?.email),
    updatedAt: row?.updatedAt ?? null,
  };
}

export type SaveOrgEmailInput = Omit<RawEmailConfig, "keyCiphertext" | "keyNonce"> & {
  /** New plaintext secret to seal, or undefined to keep the existing one. */
  secret?: string | null;
};

/**
 * What happened to the sealed credential, derivable without touching secret
 * material: a save that supplies a secret over one that existed rotated it,
 * over none added it, and an explicit null cleared it.
 */
export type EmailSecretChange = "added" | "rotated" | "cleared" | "unchanged";

export function emailSecretChange(
  input: { secret?: string | null },
  before: RedactedEmailConfig,
  after: RedactedEmailConfig,
): EmailSecretChange {
  if (after.hasSecret && !before.hasSecret) return "added";
  if (!after.hasSecret && before.hasSecret) return "cleared";
  if (after.hasSecret && before.hasSecret && typeof input.secret === "string" && Boolean(input.secret.trim())) {
    return "rotated";
  }
  return "unchanged";
}

/**
 * Rejected because another actor saved since the caller read: the caller's
 * expectedUpdatedAt no longer matches the persisted org revision. Nothing was
 * written; reload the view and retry with the fresh revision.
 */
export class OrgEmailConfigConflictError extends Error {
  readonly expectedUpdatedAt: string;
  readonly persistedUpdatedAt: string;
  constructor(expectedUpdatedAt: string, persistedUpdatedAt: string) {
    super("email configuration changed after this edit started; reload the settings view and retry");
    this.name = "OrgEmailConfigConflictError";
    this.expectedUpdatedAt = expectedUpdatedAt;
    this.persistedUpdatedAt = persistedUpdatedAt;
  }
}

export type SaveOrgEmailOptions = {
  /**
   * Exact `updatedAt` revision token from the caller's preceding read. When
   * provided, a persisted revision that differs rejects the save (409-shaped
   * conflict, zero writes). Callers that skipped the read omit it and rely on
   * the row-locked transaction alone.
   */
  expectedUpdatedAt?: string;
  /** Free-text justification recorded with the audit evidence when supplied. */
  reason?: string;
};

/**
 * Merge + persist an org's email config. A provided `secret` is sealed; a null
 * secret clears it; undefined keeps the stored one. Validates before saving so
 * a bad config fails loudly at the API boundary.
 *
 * Attribution is mandatory: `actor` names the authenticated user (or, for
 * trusted automation, the system reason). The locked read/merge/write plus the
 * org metadata stamp and the redacted audit_log evidence commit as one unit —
 * a failure of any part rolls all of it back, so an unattributed or
 * unauditable configuration change cannot persist.
 */
export async function saveOrgEmailConfig(
  orgId: string,
  input: SaveOrgEmailInput,
  actor: EmailActor,
  options: SaveOrgEmailOptions = {},
): Promise<OrgEmailConfigView> {
  if (actor.kind === "user" && !actor.userId.trim()) {
    throw new Error("email configuration writes require a non-empty acting user id");
  }
  return withOrgTransaction(orgId, async () => {
    // One locked read owns the whole read/merge/write: a concurrent save waits
    // here and then merges over the committed result, or — when it read an
    // earlier revision — is rejected by the fence below. The silent
    // last-writer-wins overwrite of another admin's credential or settings is
    // impossible in either path.
    const locked = await db.execute<{ email: RawEmailConfig | null; updatedAt: string | null }>(sql`
      select settings -> 'email' as email, ${documentRevisionSql(sql`updated_at`)} as "updatedAt"
        from orgs where id = ${orgId} for update
    `);
    const current = locked.rows[0];
    if (!current) throw new Error(`organization ${orgId} does not exist`);
    const persistedRevision = current.updatedAt;
    if (
      options.expectedUpdatedAt !== undefined &&
      (persistedRevision === null ||
        !isDocumentRevisionToken(options.expectedUpdatedAt) || options.expectedUpdatedAt !== persistedRevision)
    ) {
      throw new OrgEmailConfigConflictError(options.expectedUpdatedAt, persistedRevision ?? "");
    }

    const before = redactEmailConfig(current.email);
    const existing = current.email ?? {};
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

    // A selected provider is staged to send even while disabled, so its
    // identifying fields must be present on every save (F-t12-002). Only a
    // fully cleared provider (unconfigured) may be incomplete; the
    // credential itself is required at enable time, not before.
    validateStoredEmailConfig(next, { requireComplete: next.enabled === true || next.provider !== undefined });
    const after = redactEmailConfig(next);

    // A user actor stamps the org's canonical audit column; a system actor
    // leaves updated_by null and carries its reason in the evidence envelope,
    // so null never means "nobody recorded who changed this".
    const updatedBy = actor.kind === "user" ? actor.userId : null;
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{email}', ${JSON.stringify(next)}::jsonb),
             updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
             updated_by = ${updatedBy}
       where id = ${orgId}
    `);

    // Evidence is part of the same atomic unit: an audit failure rolls the
    // configuration write back with it.
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({
        area: "email",
        actor: actor.kind === "user" ? { kind: "user", userId: actor.userId } : { kind: "system", reason: actor.reason },
        ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
        secret: emailSecretChange(input, before, after),
        before,
        after,
      })}::jsonb, ${updatedBy})
    `);

    const saved = await db.execute<{ updatedAt: string | null }>(sql`
      select ${documentRevisionSql(sql`updated_at`)} as "updatedAt" from orgs where id = ${orgId}
    `);
    return {
      ...after,
      updatedAt: saved.rows[0]?.updatedAt ?? null,
    };
  });
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

function refuseZeroRowWrite(label: string): never {
  throw new Error(
    `${label} — the update matched no row, so nothing was written. ` +
      "Confirm the row exists and is visible in this organization before treating the write as recorded.",
  );
}

function refuseUnwrittenEmailLog(updatedRows: number, id: string, intended: string): void {
  if (updatedRows > 0) return;
  refuseZeroRowWrite(`email_log ${id} was not marked ${intended}`);
}

/**
 * A guarded transition updates zero rows for three distinguishable reasons and
 * only two of them are lost writes.
 *
 * ABSENT: no such row in this organization. The caller believes it recorded an
 * outcome and nothing was written. Refuse.
 *
 * PRESENT AND STILL ELIGIBLE: the row's status is inside the transition's
 * allowed set, so the update SHOULD have matched it and did not -- an RLS miss
 * or a scope mismatch. That is the lost write the refusal exists for. Refuse.
 *
 * PRESENT AND PROTECTED: the status is outside the allowed set, so the
 * `status in (...)` fence did exactly the job it exists to do. A retried
 * attempt that fails after its predecessor was accepted has no authority to
 * rewrite the outcome, and declining to rewrite it is the SUCCESS case.
 * Raising there reports a working guard as a failure and, in the worker, turns
 * a concurrent reconciliation into a job that records neither the remittance
 * nor the report-delivery failure that follow it.
 */
/** The statuses a failed/uncertain transition is allowed to move. */
const GUARDED_EMAIL_LOG_STATES = ["queued", "failed"] as const;

function refuseUnwrittenGuardedEmailLog(
  row: { status: string | null; written: number } | undefined,
  eligible: readonly string[],
  id: string,
  intended: string,
): void {
  if ((row?.written ?? 0) > 0) return;
  const status = row?.status ?? null;
  if (status !== null && !eligible.includes(status)) return;
  refuseZeroRowWrite(`email_log ${id} was not marked ${intended}`);
}

function refuseUnwrittenRemittance(updatedRows: number, id: string, intended: string): void {
  if (updatedRows > 0) return;
  refuseZeroRowWrite(`payment remittance ${id} was not marked ${intended}`);
}

export async function markEmailSent(orgId: string, id: string, providerMessageId: string): Promise<void> {
  const updated = await db.execute<{ id: string }>(sql`
    update email_log set status = 'sent', provider_message_id = ${providerMessageId}, sent_at = now(), updated_at = now()
     where id = ${id} and org_id = ${orgId}
    returning id
  `);
  refuseUnwrittenEmailLog(updated.rows?.length ?? 0, id, "sent");
}

export async function markEmailFailed(orgId: string, id: string, error: string): Promise<void> {
  // Guarded transition: confirmed acceptance (`sent`) and unresolved
  // uncertainty must never be overwritten by a later failure mark — a retried
  // attempt that fails after its predecessor was accepted has no authority to
  // rewrite the outcome (audit finding #52). One statement reports both facts
  // so there is no follow-up read to race against: `present` is the row's
  // existence in this org, `written` is the guarded update.
  const outcome = await db.execute<{ status: string | null; written: number }>(sql`
    with updated as (
      update email_log set status = 'failed', error_message = ${error.slice(0, 500)}, updated_at = now()
       where id = ${id} and org_id = ${orgId} and status in ('queued', 'failed')
      returning id
    ), target as (
      select status from email_log where id = ${id} and org_id = ${orgId}
    )
    select (select status from target) as status,
           (select count(*) from updated)::int as written
  `);
  refuseUnwrittenGuardedEmailLog(outcome.rows?.[0], GUARDED_EMAIL_LOG_STATES, id, "failed");
}

/**
 * Park an attempt whose acceptance state could not be proven. An uncertain row
 * is the reconciliation trigger: nothing re-sends while it stands open.
 */
export async function markEmailUncertain(orgId: string, id: string, reason: string): Promise<void> {
  const outcome = await db.execute<{ status: string | null; written: number }>(sql`
    with updated as (
      update email_log set status = 'uncertain', error_message = ${reason.slice(0, 500)}, updated_at = now()
       where id = ${id} and org_id = ${orgId} and status in ('queued', 'failed')
      returning id
    ), target as (
      select status from email_log where id = ${id} and org_id = ${orgId}
    )
    select (select status from target) as status,
           (select count(*) from updated)::int as written
  `);
  refuseUnwrittenGuardedEmailLog(outcome.rows?.[0], GUARDED_EMAIL_LOG_STATES, id, "uncertain");
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
  const updated = await db.execute<{ id: string }>(sql`
    update email_log set status = 'suppressed', error_message = ${reason.slice(0, 500)}, updated_at = now()
     where id = ${id} and org_id = ${orgId} and status in ('queued', 'failed', 'uncertain')
    returning id
  `);
  refuseUnwrittenEmailLog(updated.rows?.length ?? 0, id, "suppressed");
}

/** Record one queued payment-remittance attempt without claiming delivery. */
export async function markPaymentRemittanceAttempt(
  orgId: string,
  id: string,
  attempt: number,
): Promise<void> {
  const updated = await db.execute<{ id: string }>(sql`
    update payment_remittances
       set attempt_count = greatest(attempt_count, ${attempt}),
           last_attempt_at = now(), error = null, updated_at = now()
     where id = ${id} and org_id = ${orgId} and status = 'pending'
    returning id
  `);
  refuseUnwrittenRemittance(updated.rows?.length ?? 0, id, "attempted");
}

/**
 * Mark a payment remittance failed only after a provider/queue attempt has
 * actually failed. Before the final queue attempt it remains pending so the
 * existing BullMQ retry can continue; a sent row is never overwritten.
 */
export async function markPaymentRemittanceFailed(
  orgId: string,
  id: string,
  error: string,
  attempt: number,
  terminal: boolean,
): Promise<void> {
  // Same guarded-transition shape as markEmailFailed and the same three
  // outcomes: `status = 'pending'` protects a remittance that already reached
  // a terminal state, and refusing to rewrite it is the success case. A row
  // still pending that matched nothing is the lost write. This runs directly
  // after markEmailFailed on the worker's failure path, so raising on a
  // protected row would poison the same job.
  const outcome = await db.execute<{ status: string | null; written: number }>(sql`
    with updated as (
      update payment_remittances
         set status = case when ${terminal} then 'failed' else status end,
             attempt_count = greatest(attempt_count, ${attempt}),
             last_attempt_at = now(), error = ${error.slice(0, 500)}, updated_at = now()
       where id = ${id} and org_id = ${orgId} and status = 'pending'
      returning id
    ), target as (
      select status from payment_remittances where id = ${id} and org_id = ${orgId}
    )
    select (select status from target) as status,
           (select count(*) from updated)::int as written
  `);
  const remittance = outcome.rows?.[0];
  if ((remittance?.written ?? 0) === 0 && (remittance?.status ?? null) === "pending") {
    refuseUnwrittenRemittance(0, id, "failed");
  }
  if ((remittance?.written ?? 0) === 0 && (remittance?.status ?? null) === null) {
    refuseUnwrittenRemittance(0, id, "failed");
  }
}

/**
 * Confirm a queued payment remittance only after the provider accepted the
 * email. The instruction stamp is best-effort here: a payment run may still
 * be in its posting claim, in which case its finisher reconciles the stamp
 * from this sent remittance once that claim commits.
 */
export async function markPaymentRemittanceSent(orgId: string, id: string): Promise<void> {
  const remittance = (await db.execute<{ paymentInstructionId: string }>(sql`
    update payment_remittances
       set status = 'sent', sent_at = coalesce(sent_at, now()),
           last_attempt_at = coalesce(last_attempt_at, now()),
           error = null, updated_at = now()
     where id = ${id} and org_id = ${orgId} and status in ('pending', 'failed')
     returning payment_instruction_id as "paymentInstructionId"
  `)).rows[0];
  if (!remittance) {
    const existing = (await db.execute<{ paymentInstructionId: string }>(sql`
      select payment_instruction_id as "paymentInstructionId"
        from payment_remittances
       where id = ${id} and org_id = ${orgId} and status = 'sent'
    `)).rows[0];
    if (!existing) return;
    try {
      await db.execute(sql`
        update payment_instructions
           set remittance_email_sent_at = coalesce(remittance_email_sent_at, now()), updated_at = now()
         where id = ${existing.paymentInstructionId} and org_id = ${orgId}
           and remittance_email_sent_at is null
      `);
    } catch (error) {
      console.error(`[email] payment remittance ${id} sent but instruction stamp deferred:`, error);
    }
    return;
  }
  try {
    await db.execute(sql`
      update payment_instructions
         set remittance_email_sent_at = coalesce(remittance_email_sent_at, now()), updated_at = now()
       where id = ${remittance.paymentInstructionId} and org_id = ${orgId}
         and remittance_email_sent_at is null
    `);
  } catch (error) {
    console.error(`[email] payment remittance ${id} sent but instruction stamp deferred:`, error);
  }
}

/**
 * Settle a dunning claim from the email worker's provider verdict. The
 * dunning runner leaves each deferred letter 'staged'; only the worker may
 * move it to its outcome, and only from 'staged' — the fence below is what
 * refuses to rewrite terminal evidence or a claim a later tick already
 * re-armed, even when the storage guard is bypassed (as it is in tests).
 *
 * Returns true when the claim holds the requested outcome afterwards: either
 * this call moved it, or a replay found it already there (crash-gap worker
 * retries reconcile onto the same acceptance and must not report failure).
 * Returns false when the row is missing or held in any other state — the
 * caller logs that as a failure, never a silent success.
 */
export async function markDunningClaimSent(orgId: string, claimId: string): Promise<boolean> {
  const moved = await db.execute<{ id: string }>(sql`
    update dunning_log set status = 'sent', sent_at = now(), updated_at = now()
     where id = ${claimId} and org_id = ${orgId} and status = 'staged'
    returning id
  `);
  if (moved.rows[0]) return true;
  const current = (await db.execute<{ status: string }>(sql`
    select status from dunning_log where id = ${claimId} and org_id = ${orgId}
  `)).rows[0];
  return current?.status === "sent";
}

/**
 * Record the provider's rejection on a staged dunning claim. The failed row
 * stays out of the runner's fired set (only 'sent' fires), so a later tick
 * re-arms it onto a fresh outbox occurrence key. Same idempotent contract as
 * {@link markDunningClaimSent}: an already-failed row is success, anything
 * else unmoved is false.
 */
export async function markDunningClaimFailed(
  orgId: string,
  claimId: string,
  detail = "email delivery failed",
): Promise<boolean> {
  const moved = await db.execute<{ id: string }>(sql`
    update dunning_log set status = 'failed', detail = ${detail.slice(0, 500)}, updated_at = now()
     where id = ${claimId} and org_id = ${orgId} and status = 'staged'
    returning id
  `);
  if (moved.rows[0]) return true;
  const current = (await db.execute<{ status: string }>(sql`
    select status from dunning_log where id = ${claimId} and org_id = ${orgId}
  `)).rows[0];
  return current?.status === "failed";
}

// --- canonical delivery lineage ----------------------------------------------

/** One attempt's evidence inside meta.attempts — append-only, never rewritten. */
export async function appendEmailAttemptEvent(orgId: string, id: string, event: {
  attempt?: number;
  outcome?: AttemptRecord["outcome"] | "blocked" | "suppressed" | "started";
  detail?: string | null;
}): Promise<AttemptRecord[]> {
  const payload = { at: new Date().toISOString(), ...event };
  const updated = await db.execute<{ id: string }>(sql`
    update email_log
       set meta = jsonb_set(meta, '{attempts}', coalesce(meta -> 'attempts', '[]'::jsonb) || ${JSON.stringify(payload)}::jsonb),
           updated_at = now()
     where id = ${id} and org_id = ${orgId}
    returning id
  `);
  if ((updated.rows?.length ?? 0) === 0) {
    refuseZeroRowWrite(`email_log ${id} attempt lineage was not appended`);
  }
  return readAttemptLineage(orgId, id);
}

async function readAttemptLineage(orgId: string, id: string): Promise<AttemptRecord[]> {
  const r = await db.execute<{ attempts: AttemptRecord[] | null }>(sql`
    select meta -> 'attempts' as attempts from email_log where id = ${id} and org_id = ${orgId}
  `);
  return r.rows[0]?.attempts ?? [];
}

/**
 * Normalize the append-only attempt lineage stored on an email_log row into
 * the reconciliation vocabulary. Annotation events ("started", "blocked",
 * "suppressed") carry no verdict and are dropped — EXCEPT a dangling
 * "started": the worker appends it immediately BEFORE transmitting, so a
 * start event with no matching outcome for the same attempt number means the
 * worker was lost mid-flight (crash, SIGKILL, deploy restart) and the
 * transmission may already have been accepted. That synthesizes to
 * "uncertain", never to a clean slate: without this, the crash-gap retry
 * would see empty lineage and re-send a possibly-delivered message.
 */
export function normalizeAttempts(attempts: unknown): AttemptRecord[] {
  if (!Array.isArray(attempts)) return [];
  const records: AttemptRecord[] = [];
  const decided = new Set<number>();
  for (const entry of attempts) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const outcome = record.outcome === "sent" || record.outcome === "notSent" || record.outcome === "uncertain" ? record.outcome : null;
    if (!outcome) continue;
    const attempt = typeof record.attempt === "number" ? record.attempt : 1;
    decided.add(attempt);
    records.push({
      attempt,
      outcome,
      detail: typeof record.detail === "string" ? record.detail : null,
    });
  }
  for (const entry of attempts) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.outcome !== "started" || typeof record.attempt !== "number") continue;
    if (decided.has(record.attempt)) continue;
    decided.add(record.attempt);
    records.push({
      attempt: record.attempt,
      outcome: "uncertain",
      detail:
        `attempt ${record.attempt} started but never recorded an outcome (worker lost mid-flight); ` +
        `whether the message was accepted cannot be proven — acceptance state unresolved`,
    });
  }
  return records;
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
