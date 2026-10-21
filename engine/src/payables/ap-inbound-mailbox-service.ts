import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { sealSecret, unsealSecret } from "../platform/secrets.ts";
import {
  INBOUND_EMAIL_PROVIDERS,
  isMailboxToken,
  newMailboxToken,
  normalizeSenderRule,
  type InboundEmail,
  type InboundEmailProvider,
} from "./ap-inbound-email.ts";

/**
 * Inbound AP addresses and their message log.
 *
 * An address belongs to one legal entity. Its token is the webhook
 * credential, so it is generated here, never chosen, and the optional
 * provider signing secret is sealed under the organization's data key in a
 * separate row that configuration reads never select. Every configuration
 * change is audited with before and after state (the secret only as
 * present/absent).
 */

const SECRET_PURPOSE = "ap-capture.mailbox-signing-secret";

/** Deliveries one address accepts per minute before refusing with 429. */
export const MAILBOX_DELIVERIES_PER_MINUTE = 60;

export class MailboxConfigurationError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "MailboxConfigurationError";
  }
}

export type ResolvedMailbox = {
  id: string;
  orgId: string;
  subsidiaryId: string;
  provider: InboundEmailProvider;
  allowedSenders: string[];
  isActive: boolean;
  /** The configuring administrator; captures from this address are attributed to them. */
  ownerId: string;
  signingSecret: string | null;
};

/**
 * Resolve an address from its webhook token. The token is the only thing the
 * provider sends, so the owning organization is unknown until this lookup
 * finds it; everything after runs in that organization's scope.
 */
export async function resolveMailboxByToken(token: string): Promise<ResolvedMailbox | null> {
  if (!isMailboxToken(token)) return null;
  // bypass: public-token-lookup — the webhook names only its address token, so the owning org is resolved from that one row before every read and write runs in that org's scope.
  const owner = await withBypassContext(() => db.execute<{ orgId: string }>(sql`
    select org_id as "orgId" from ap_capture_mailboxes where token = ${token}
  `));
  const orgId = owner.rows[0]?.orgId;
  if (!orgId) return null;
  return withOrgContext(orgId, async () => {
    const row = (await db.execute<{
      id: string;
      subsidiaryId: string;
      provider: InboundEmailProvider;
      allowedSenders: unknown;
      isActive: boolean;
      ownerId: string;
      sealedSecret: string | null;
    }>(sql`
      select m.id, m.subsidiary_id as "subsidiaryId", m.provider, m.allowed_senders as "allowedSenders",
             m.is_active as "isActive", m.created_by as "ownerId", c.sealed_secret as "sealedSecret"
        from ap_capture_mailboxes m
        left join ap_capture_mailbox_credentials c on c.org_id = m.org_id and c.mailbox_id = m.id
       where m.org_id = ${orgId} and m.token = ${token}
    `)).rows[0];
    if (!row) return null;
    return {
      id: row.id,
      orgId,
      subsidiaryId: row.subsidiaryId,
      provider: row.provider,
      allowedSenders: Array.isArray(row.allowedSenders) ? row.allowedSenders.filter((value): value is string => typeof value === "string") : [],
      isActive: row.isActive,
      ownerId: row.ownerId,
      signingSecret: row.sealedSecret ? unsealSecret(row.sealedSecret, { orgId, purpose: SECRET_PURPOSE }) : null,
    };
  });
}

/**
 * Fixed-window per-minute limit on one address. One atomic update rolls the
 * window and counts the delivery; a zero-row update is a vanished address,
 * which refuses rather than passing uncounted.
 */
export async function consumeMailboxDelivery(orgId: string, mailboxId: string, perMinute = MAILBOX_DELIVERIES_PER_MINUTE): Promise<boolean> {
  const counted = (await db.execute<{ count: number }>(sql`
    update ap_capture_mailboxes
       set rate_window_count = case when rate_window_start = date_trunc('minute', now()) then rate_window_count + 1 else 1 end,
           rate_window_start = date_trunc('minute', now())
     where org_id = ${orgId} and id = ${mailboxId}
     returning rate_window_count as count
  `)).rows[0];
  if (!counted) throw new MailboxConfigurationError("The inbound address no longer exists", 404);
  return Number(counted.count) <= perMinute;
}

export type InboundOutcome = "captured" | "rejected_sender" | "no_attachments" | "duplicate" | "error";

export type BegunInboundMessage =
  | { status: "new"; id: string }
  | { status: "repeat"; id: string; outcome: string; captureItemIds: string[] };

/**
 * Log a delivery, idempotent on (address, message id). A provider retry or a
 * second copy of the same message finds the existing row and is answered
 * with its recorded outcome instead of creating captures twice.
 */
export async function beginInboundMessage(input: {
  orgId: string;
  mailboxId: string;
  email: Pick<InboundEmail, "provider" | "from" | "subject" | "messageId">;
  attachmentCount: number;
}): Promise<BegunInboundMessage> {
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into ap_capture_inbound_messages (org_id, mailbox_id, message_id, provider, from_address, subject, attachment_count)
    values (${input.orgId}, ${input.mailboxId}, ${input.email.messageId.slice(0, 998)}, ${input.email.provider},
            ${input.email.from}, ${input.email.subject}, ${input.attachmentCount})
    -- A conflict is the same message delivered again: the existing row answers it below.
    on conflict (org_id, mailbox_id, message_id) do nothing
    returning id
  `)).rows[0];
  if (inserted) return { status: "new", id: inserted.id };
  const existing = (await db.execute<{ id: string; outcome: string; captureItemIds: string[] }>(sql`
    select id, outcome, capture_item_ids as "captureItemIds" from ap_capture_inbound_messages
     where org_id = ${input.orgId} and mailbox_id = ${input.mailboxId} and message_id = ${input.email.messageId.slice(0, 998)}
  `)).rows[0];
  if (!existing) throw new Error("The inbound message could not be logged or found; retry the delivery.");
  return { status: "repeat", id: existing.id, outcome: existing.outcome, captureItemIds: existing.captureItemIds ?? [] };
}

/** Record a message's outcome exactly once. */
export async function finishInboundMessage(input: {
  orgId: string;
  id: string;
  outcome: InboundOutcome;
  reason?: string | null;
  captureItemIds?: string[];
}): Promise<void> {
  const ids = input.captureItemIds ?? [];
  const updated = (await db.execute<{ id: string }>(sql`
    update ap_capture_inbound_messages
       set outcome = ${input.outcome}, outcome_reason = ${input.reason?.slice(0, 1000) ?? null},
           capture_item_ids = ${`{${ids.join(",")}}`}::uuid[], processed_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and outcome = 'received'
     returning id
  `)).rows[0];
  if (!updated) throw new Error("The inbound message outcome was already recorded or the message is missing.");
}

/** Normalize and validate an allowed-sender list, refusing unusable entries by name. */
export function normalizeAllowedSenders(values: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    if (!value.trim()) continue;
    const rule = normalizeSenderRule(value);
    if (!rule) {
      throw new MailboxConfigurationError(
        `"${value.trim().slice(0, 120)}" is not an email address or an @domain entry`,
      );
    }
    if (!normalized.includes(rule)) normalized.push(rule);
  }
  if (normalized.length > 200) throw new MailboxConfigurationError("An address accepts at most 200 allowed senders");
  return normalized;
}

function assertProvider(value: string): asserts value is InboundEmailProvider {
  if (!(INBOUND_EMAIL_PROVIDERS as readonly string[]).includes(value)) {
    throw new MailboxConfigurationError(`Choose one of: ${INBOUND_EMAIL_PROVIDERS.join(", ")}`);
  }
}

function assertSecret(value: string): void {
  if (value.length < 16 || value.length > 512) {
    throw new MailboxConfigurationError("A signing secret must be between 16 and 512 characters");
  }
}

type MailboxSnapshot = {
  id: string;
  subsidiaryId: string;
  label: string;
  emailAddress: string | null;
  provider: string;
  allowedSenders: string[];
  isActive: boolean;
  hasSigningSecret: boolean;
};

async function snapshot(orgId: string, id: string): Promise<MailboxSnapshot | null> {
  return (await db.execute<MailboxSnapshot>(sql`
    select m.id, m.subsidiary_id as "subsidiaryId", m.label, m.email_address as "emailAddress", m.provider,
           m.allowed_senders as "allowedSenders", m.is_active as "isActive",
           exists (select 1 from ap_capture_mailbox_credentials c where c.org_id = m.org_id and c.mailbox_id = m.id) as "hasSigningSecret"
      from ap_capture_mailboxes m
     where m.org_id = ${orgId} and m.id = ${id}
     for update of m
  `)).rows[0] ?? null;
}

async function audit(orgId: string, id: string, action: string, actorId: string, before: unknown, after: unknown, extra: Record<string, unknown> = {}) {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'ap_capture_mailboxes', ${id}, ${action},
            ${JSON.stringify({ before, after, ...extra })}::jsonb, ${actorId})
  `);
}

async function assertEntity(orgId: string, subsidiaryId: string, allowed: ReadonlySet<string> | null): Promise<void> {
  if (allowed !== null && !allowed.has(subsidiaryId)) throw new MailboxConfigurationError("Choose a legal entity you can manage", 404);
  const entity = (await db.execute(sql`
    select 1 from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId} and is_active and not is_elimination
  `)).rows[0];
  if (!entity) throw new MailboxConfigurationError("Choose an active legal entity for this address");
}

async function storeSecret(orgId: string, mailboxId: string, actorId: string, secret: string): Promise<void> {
  const sealed = sealSecret(secret, { orgId, purpose: SECRET_PURPOSE });
  const stored = (await db.execute<{ id: string }>(sql`
    insert into ap_capture_mailbox_credentials (org_id, mailbox_id, sealed_secret, created_by, updated_by)
    values (${orgId}, ${mailboxId}, ${sealed}, ${actorId}, ${actorId})
    on conflict (org_id, mailbox_id) do update
      set sealed_secret = excluded.sealed_secret, updated_at = now(), updated_by = excluded.updated_by
    returning id
  `)).rows[0];
  if (!stored) throw new Error("The signing secret was not stored; retry the save.");
}

export type MailboxInput = {
  subsidiaryId: string;
  label: string;
  emailAddress: string | null;
  provider: string;
  allowedSenders: string[];
  isActive: boolean;
  signingSecret: string | null;
};

/** Create an address with a fresh token; the secret is sealed when supplied. */
export async function createMailbox(input: MailboxInput & {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ id: string; token: string }> {
  assertProvider(input.provider);
  const allowedSenders = normalizeAllowedSenders(input.allowedSenders);
  if (input.signingSecret) assertSecret(input.signingSecret);
  return withOrgTransaction(input.orgId, async () => {
    await assertEntity(input.orgId, input.subsidiaryId, input.allowedSubsidiaryIds);
    const token = newMailboxToken();
    const created = (await db.execute<{ id: string }>(sql`
      insert into ap_capture_mailboxes (org_id, subsidiary_id, label, email_address, token, provider,
                                        allowed_senders, is_active, created_by, updated_by)
      values (${input.orgId}, ${input.subsidiaryId}, ${input.label.trim()}, ${input.emailAddress?.trim() || null}, ${token},
              ${input.provider}, ${JSON.stringify(allowedSenders)}::jsonb, ${input.isActive}, ${input.actorId}, ${input.actorId})
      returning id
    `)).rows[0];
    if (!created) throw new Error("The inbound address was not created; retry the save.");
    if (input.signingSecret) await storeSecret(input.orgId, created.id, input.actorId, input.signingSecret);
    const after = await snapshot(input.orgId, created.id);
    if (!after) throw new Error("The inbound address was not created; retry the save.");
    await audit(input.orgId, created.id, "create", input.actorId, null, after);
    return { id: created.id, token };
  });
}

/**
 * Update an address. The legal entity is fixed once captures may name it.
 * An omitted or empty secret keeps the stored one; `clearSigningSecret`
 * removes it; `rotateToken` issues a new webhook token, after which the old
 * URL answers 404.
 */
export async function updateMailbox(input: Omit<MailboxInput, "subsidiaryId"> & {
  orgId: string;
  actorId: string;
  id: string;
  clearSigningSecret: boolean;
  rotateToken: boolean;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ id: string; tokenRotated: boolean }> {
  assertProvider(input.provider);
  const allowedSenders = normalizeAllowedSenders(input.allowedSenders);
  if (input.signingSecret) assertSecret(input.signingSecret);
  if (input.signingSecret && input.clearSigningSecret) {
    throw new MailboxConfigurationError("Enter a new signing secret or clear it, not both");
  }
  return withOrgTransaction(input.orgId, async () => {
    const before = await snapshot(input.orgId, input.id);
    if (!before || (input.allowedSubsidiaryIds !== null && !input.allowedSubsidiaryIds.has(before.subsidiaryId))) {
      throw new MailboxConfigurationError("Inbound address not found", 404);
    }
    const updated = (await db.execute<{ id: string }>(sql`
      update ap_capture_mailboxes
         set label = ${input.label.trim()}, email_address = ${input.emailAddress?.trim() || null},
             provider = ${input.provider}, allowed_senders = ${JSON.stringify(allowedSenders)}::jsonb,
             is_active = ${input.isActive},
             token = case when ${input.rotateToken} then ${newMailboxToken()} else token end,
             updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${input.id}
       returning id
    `)).rows[0];
    if (!updated) throw new MailboxConfigurationError("Inbound address not found", 404);
    if (input.signingSecret) {
      await storeSecret(input.orgId, input.id, input.actorId, input.signingSecret);
    } else if (input.clearSigningSecret) {
      await db.execute(sql`
        delete from ap_capture_mailbox_credentials where org_id = ${input.orgId} and mailbox_id = ${input.id}
      `);
    }
    const after = await snapshot(input.orgId, input.id);
    await audit(input.orgId, input.id, "update", input.actorId, before, after, {
      ...(input.rotateToken ? { tokenRotated: true } : {}),
      ...(input.signingSecret ? { signingSecretReplaced: true } : {}),
    });
    return { id: input.id, tokenRotated: input.rotateToken };
  });
}

export type MailboxListRow = {
  id: string;
  label: string;
  subsidiaryId: string;
  subsidiaryName: string;
  emailAddress: string | null;
  token: string;
  provider: InboundEmailProvider;
  isActive: boolean;
};

function entityScope(column: ReturnType<typeof sql.raw>, allowed: ReadonlySet<string> | null) {
  if (allowed === null) return sql``;
  if (allowed.size === 0) return sql`and false`;
  return sql`and ${column} = any(${`{${[...allowed].join(",")}}`}::uuid[])`;
}

/** Addresses the viewer's legal-entity scope covers. */
export async function listMailboxes(orgId: string, allowed: ReadonlySet<string> | null): Promise<MailboxListRow[]> {
  return (await db.execute<MailboxListRow>(sql`
    select m.id, m.label, m.subsidiary_id as "subsidiaryId", coalesce(s.legal_name, s.name) as "subsidiaryName",
           m.email_address as "emailAddress", m.token, m.provider, m.is_active as "isActive"
      from ap_capture_mailboxes m
      join subsidiaries s on s.org_id = m.org_id and s.id = m.subsidiary_id
     where m.org_id = ${orgId} ${entityScope(sql.raw("m.subsidiary_id"), allowed)}
     order by m.is_active desc, m.label, m.id
  `)).rows;
}

export type InboundMessageListRow = {
  id: string;
  mailboxLabel: string;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string;
  attachmentCount: number;
  outcome: string;
  outcomeReason: string | null;
  captureItemIds: string[];
};

/** Recent inbound messages, newest first, within the viewer's legal-entity scope. */
export async function listInboundMessages(
  orgId: string,
  allowed: ReadonlySet<string> | null,
  page: { limit: number; offset: number },
): Promise<{ rows: InboundMessageListRow[]; total: number }> {
  const scope = entityScope(sql.raw("m.subsidiary_id"), allowed);
  const [rows, total] = await Promise.all([
    db.execute<InboundMessageListRow>(sql`
      select im.id, m.label as "mailboxLabel", im.from_address as "fromAddress", im.subject,
             im.received_at as "receivedAt", im.attachment_count as "attachmentCount",
             im.outcome, im.outcome_reason as "outcomeReason", im.capture_item_ids as "captureItemIds"
        from ap_capture_inbound_messages im
        join ap_capture_mailboxes m on m.org_id = im.org_id and m.id = im.mailbox_id
       where im.org_id = ${orgId} ${scope}
       order by im.received_at desc, im.id desc
       limit ${page.limit} offset ${page.offset}
    `),
    db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from ap_capture_inbound_messages im
        join ap_capture_mailboxes m on m.org_id = im.org_id and m.id = im.mailbox_id
       where im.org_id = ${orgId} ${scope}
    `),
  ]);
  return { rows: rows.rows, total: Number(total.rows[0]?.n ?? 0) };
}
