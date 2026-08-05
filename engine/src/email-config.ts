import { sql } from "drizzle-orm";
import {
  resolveEmailTransport,
  sealSecret,
  validateStoredEmailConfig,
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
  const r = (await db.execute(sql`
    select settings -> 'email' as email from orgs where id = ${orgId}
  `)) as unknown as { rows: { email: RawEmailConfig | null }[] };
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
}): Promise<string> {
  const r = (await db.execute(sql`
    insert into email_log (org_id, job_id, provider, recipients, recipient_primary, from_addr, reply_to_addr, subject, status, category_key, meta, error_message, sent_at)
    values (
      ${row.orgId}, ${row.jobId ?? null}, ${row.provider ?? null},
      ${JSON.stringify(row.recipients)}::jsonb, ${row.recipients[0] ?? null},
      ${row.fromAddr ?? null}, ${row.replyToAddr ?? null}, ${row.subject},
      ${row.status}, ${row.categoryKey ?? null}, ${JSON.stringify(row.meta ?? {})}::jsonb,
      ${row.errorMessage ?? null}, ${row.status === "sent" ? sql`now()` : null}
    )
    returning id
  `)) as unknown as { rows: { id: string }[] };
  return r.rows[0]!.id;
}

export async function markEmailSent(id: string, providerMessageId: string): Promise<void> {
  await db.execute(sql`
    update email_log set status = 'sent', provider_message_id = ${providerMessageId}, sent_at = now(), updated_at = now()
     where id = ${id}
  `);
}

export async function markEmailFailed(id: string, error: string): Promise<void> {
  await db.execute(sql`
    update email_log set status = 'failed', error_message = ${error.slice(0, 500)}, updated_at = now()
     where id = ${id}
  `);
}
