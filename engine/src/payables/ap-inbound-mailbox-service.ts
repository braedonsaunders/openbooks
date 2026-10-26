import { sql } from "drizzle-orm";
import {
  db,
  withBypassContext,
  withOrgContext,
  withOrgTransaction,
  type SqlExecutor,
} from "../platform/db.ts";
import { sealSecret, unsealSecret } from "../platform/secrets.ts";
import { actorHasPermission, actorIdentity } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import {
  INBOUND_EMAIL_PROVIDERS,
  InboundEmailError,
  isMailboxToken,
  newMailboxToken,
  normalizeSenderRule,
  type InboundEmail,
  type InboundEmailProvider,
  type InboundSignatureEvidence,
} from "./ap-inbound-email.ts";

/**
 * Inbound AP addresses and their message log.
 *
 * An address belongs to one legal entity. Its token is the webhook
 * credential, so it is generated here, never chosen, and the optional
 * provider signing secret is sealed under the organization's data key in a
 * separate row that configuration reads never select. Captures from an
 * address are attributed to its owner, whose standing is re-checked on every
 * delivery. Every configuration change is audited with before and after
 * state (the secret only as present/absent).
 */

const SECRET_PURPOSE = "ap-capture.mailbox-signing-secret";

/** Deliveries one address accepts per minute before refusing with 429. */
export const MAILBOX_DELIVERIES_PER_MINUTE = 60;

export class MailboxConfigurationError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
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
  /** The address owner; captures from this address are attributed to them. */
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
  const owner = await withBypassContext(() =>
    db.execute<{ orgId: string }>(
      sql`
    select org_id as "orgId" from ap_capture_mailboxes where token = ${token}
  `,
      "objects",
    ),
  );
  const orgId = owner[0]?.orgId;
  if (!orgId) return null;
  return withOrgContext(orgId, async () => {
    const row = (
      await db.execute<{
        id: string;
        subsidiaryId: string;
        provider: InboundEmailProvider;
        allowedSenders: unknown;
        isActive: boolean;
        ownerId: string;
        sealedSecret: string | null;
      }>(
        sql`
      select m.id, m.subsidiary_id as "subsidiaryId", m.provider, m.allowed_senders as "allowedSenders",
             m.is_active as "isActive", m.owner_user_id as "ownerId", c.sealed_secret as "sealedSecret"
        from ap_capture_mailboxes m
        left join ap_capture_mailbox_credentials c on c.org_id = m.org_id and c.mailbox_id = m.id
       where m.org_id = ${orgId} and m.token = ${token}
    `,
        "objects",
      )
    )[0];
    if (!row) return null;
    return {
      id: row.id,
      orgId,
      subsidiaryId: row.subsidiaryId,
      provider: row.provider,
      allowedSenders: Array.isArray(row.allowedSenders)
        ? row.allowedSenders.filter((value): value is string => typeof value === "string")
        : [],
      isActive: row.isActive,
      ownerId: row.ownerId,
      signingSecret: row.sealedSecret
        ? unsealSecret(row.sealedSecret, { orgId, purpose: SECRET_PURPOSE })
        : null,
    };
  });
}

/**
 * Fixed-window per-minute limit on one address. One atomic update rolls the
 * window and counts the delivery; a zero-row update is a vanished address,
 * which refuses rather than passing uncounted.
 */
export async function consumeMailboxDelivery(
  orgId: string,
  mailboxId: string,
  perMinute = MAILBOX_DELIVERIES_PER_MINUTE,
): Promise<boolean> {
  const counted = (
    await db.execute<{ count: number }>(
      sql`
    update ap_capture_mailboxes
       set rate_window_count = case when rate_window_start = date_trunc('minute', now()) then rate_window_count + 1 else 1 end,
           rate_window_start = date_trunc('minute', now())
     where org_id = ${orgId} and id = ${mailboxId}
     returning rate_window_count as count
  `,
      "objects",
    )
  )[0];
  if (!counted) throw new MailboxConfigurationError("The inbound address no longer exists", 404);
  return Number(counted.count) <= perMinute;
}

export type InboundOutcome =
  "captured" | "rejected_sender" | "no_attachments" | "duplicate" | "error";

/**
 * How long one delivery attempt holds a logged message. A message still
 * unfinished after this (its process stopped mid-delivery) may be claimed
 * again by the provider's retry instead of being answered as a duplicate.
 */
export const INBOUND_MESSAGE_LEASE_MINUTES = 10;

export type BegunInboundMessage =
  /** This attempt owns the message; `attempt` fences its outcome write. */
  | { status: "new"; id: string; attempt: number; reclaimed: boolean }
  /** Already finished, or another attempt still holds its lease. */
  | { status: "repeat"; id: string; outcome: string; captureItemIds: string[] };

type PgErrorFields = { code?: unknown; constraint?: unknown; cause?: unknown };

function isNonceConflict(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const fields = current as PgErrorFields;
    if (fields.code === "23505" && fields.constraint === "ap_capture_inbound_messages_nonce_unique")
      return true;
    current = fields.cause;
  }
  return false;
}

function replayRefusal(): InboundEmailError {
  return new InboundEmailError(
    "signature_replayed",
    "This signed delivery token was already used for another message.",
  );
}

/**
 * Log a delivery, idempotent on (address, message id), with what its
 * signature established. A provider retry or a second copy of the same
 * message finds the existing row and is answered with its recorded outcome
 * instead of creating captures twice; a message whose earlier attempt
 * stopped before finishing is claimed again once its lease expires. A signed
 * one-time token already recorded for a different message is a replay and
 * is refused before anything is logged.
 */
export async function beginInboundMessage(input: {
  orgId: string;
  mailboxId: string;
  email: Pick<InboundEmail, "provider" | "from" | "subject" | "messageId">;
  attachmentCount: number;
  signature: InboundSignatureEvidence;
  contentDigest: string;
}): Promise<BegunInboundMessage> {
  const messageId = input.email.messageId.slice(0, 998);
  const nonce = input.signature.verified ? input.signature.nonce : null;
  if (nonce) {
    const reused = (
      await db.execute(
        sql`
      select 1 from ap_capture_inbound_messages
       where org_id = ${input.orgId} and mailbox_id = ${input.mailboxId}
         and provider_nonce = ${nonce}
         and (message_id <> ${messageId} or content_digest <> ${input.contentDigest})
    `,
        "objects",
      )
    )[0];
    if (reused) throw replayRefusal();
  }
  let inserted: { id: string; attempt: number } | undefined;
  try {
    inserted = (
      await db.execute<{ id: string; attempt: number }>(
        sql`
      insert into ap_capture_inbound_messages (org_id, mailbox_id, message_id, provider, from_address, subject,
                                               attachment_count, signature_verified, provider_nonce, content_digest)
      values (${input.orgId}, ${input.mailboxId}, ${messageId}, ${input.email.provider},
              ${input.email.from}, ${input.email.subject}, ${input.attachmentCount},
              ${input.signature.verified}, ${nonce}, ${input.contentDigest})
      -- A conflict is the same message delivered again: the existing row answers it below.
      on conflict (org_id, mailbox_id, message_id) do nothing
      returning id, claim_attempt as attempt
    `,
        "objects",
      )
    )[0];
  } catch (error) {
    // A concurrent delivery recorded the same token for another message.
    if (isNonceConflict(error)) throw replayRefusal();
    throw error;
  }
  if (inserted)
    return { status: "new", id: inserted.id, attempt: Number(inserted.attempt), reclaimed: false };
  // An unfinished message whose lease expired is claimed again, but only by
  // a delivery carrying the same recorded facts; the conditional update is
  // the claim, so two concurrent retries cannot both win it.
  const reclaimed = (
    await db.execute<{ id: string; attempt: number }>(
      sql`
    update ap_capture_inbound_messages
       set claimed_at = now(), claim_attempt = claim_attempt + 1
     where org_id = ${input.orgId} and mailbox_id = ${input.mailboxId} and message_id = ${messageId}
       and outcome = 'received'
       and claimed_at < now() - make_interval(mins => ${INBOUND_MESSAGE_LEASE_MINUTES})
       and from_address is not distinct from ${input.email.from}
       and subject is not distinct from ${input.email.subject}
       and attachment_count = ${input.attachmentCount}
       and content_digest = ${input.contentDigest}
       and signature_verified = ${input.signature.verified}
     returning id, claim_attempt as attempt
  `,
      "objects",
    )
  )[0];
  if (reclaimed)
    return { status: "new", id: reclaimed.id, attempt: Number(reclaimed.attempt), reclaimed: true };
  const existing = (
    await db.execute<{ id: string; outcome: string; captureItemIds: string[] }>(
      sql`
    select id, outcome, capture_item_ids as "captureItemIds" from ap_capture_inbound_messages
     where org_id = ${input.orgId} and mailbox_id = ${input.mailboxId} and message_id = ${messageId}
  `,
      "objects",
    )
  )[0];
  if (!existing)
    throw new Error("The inbound message could not be logged or found; retry the delivery.");
  return {
    status: "repeat",
    id: existing.id,
    outcome: existing.outcome,
    captureItemIds: existing.captureItemIds ?? [],
  };
}

/**
 * Record a message's outcome exactly once, by the attempt that holds its
 * claim. An attempt whose lease was taken over by a retry cannot overwrite
 * the retry's outcome.
 */
export async function finishInboundMessage(input: {
  orgId: string;
  id: string;
  attempt: number;
  outcome: InboundOutcome;
  reason?: string | null;
  captureItemIds?: string[];
}): Promise<void> {
  const ids = input.captureItemIds ?? [];
  const updated = (
    await db.execute<{ id: string }>(
      sql`
    update ap_capture_inbound_messages
       set outcome = ${input.outcome}, outcome_reason = ${input.reason?.slice(0, 1000) ?? null},
           capture_item_ids = ${`{${ids.join(",")}}`}::uuid[], processed_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and outcome = 'received'
       and claim_attempt = ${input.attempt}
     returning id
  `,
      "objects",
    )
  )[0];
  if (!updated)
    throw new Error(
      "The inbound message outcome was already recorded, its claim moved to a retry, or the message is missing.",
    );
}

export type MailboxOwnerProblem = "owner_inactive" | "owner_not_permitted" | "owner_out_of_scope";

export type MailboxOwnerAuthority =
  /** The scope extraction and any draft are confined to: the address's entity. */
  | { ok: true; allowedSubsidiaryIds: ReadonlySet<string> }
  | { ok: false; problem: MailboxOwnerProblem; message: string };

const OWNER_REMEDY =
  "An administrator can take ownership of the address on the Bill capture page, or re-create the address.";

/**
 * Whether an address's owner may still receive bills through it: an active
 * user who holds AP create and whose current legal-entity access covers the
 * address's entity. The capture scope is the intersection of the address's
 * entity with the owner's access, so a narrowed owner never widens it.
 */
export async function mailboxOwnerAuthority(
  exec: SqlExecutor,
  orgId: string,
  ownerId: string,
  subsidiaryId: string,
): Promise<MailboxOwnerAuthority> {
  const identity = await actorIdentity(exec, orgId, ownerId);
  if (!identity?.isActive) {
    return {
      ok: false,
      problem: "owner_inactive",
      message: `The owner of this inbound address is no longer an active user. ${OWNER_REMEDY}`,
    };
  }
  if (!(await actorHasPermission(exec, orgId, ownerId, "ap.create"))) {
    return {
      ok: false,
      problem: "owner_not_permitted",
      message: `The owner of this inbound address no longer holds permission to create bills. ${OWNER_REMEDY}`,
    };
  }
  const scope = await actorAllowedSubsidiaryIds(exec, orgId, ownerId);
  if (scope !== null && !scope.has(subsidiaryId)) {
    return {
      ok: false,
      problem: "owner_out_of_scope",
      message: `The owner of this inbound address can no longer access its legal entity. ${OWNER_REMEDY}`,
    };
  }
  return { ok: true, allowedSubsidiaryIds: new Set([subsidiaryId]) };
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
  if (normalized.length > 200)
    throw new MailboxConfigurationError("An address accepts at most 200 allowed senders");
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
  ownerId: string;
  label: string;
  emailAddress: string | null;
  provider: string;
  allowedSenders: string[];
  isActive: boolean;
  hasSigningSecret: boolean;
};

async function snapshot(orgId: string, id: string): Promise<MailboxSnapshot | null> {
  return (
    (
      await db.execute<MailboxSnapshot>(
        sql`
    select m.id, m.subsidiary_id as "subsidiaryId", m.owner_user_id as "ownerId", m.label, m.email_address as "emailAddress", m.provider,
           m.allowed_senders as "allowedSenders", m.is_active as "isActive",
           exists (select 1 from ap_capture_mailbox_credentials c where c.org_id = m.org_id and c.mailbox_id = m.id) as "hasSigningSecret"
      from ap_capture_mailboxes m
     where m.org_id = ${orgId} and m.id = ${id}
     for update of m
  `,
        "objects",
      )
    )[0] ?? null
  );
}

async function audit(
  orgId: string,
  id: string,
  action: string,
  actorId: string,
  before: unknown,
  after: unknown,
  extra: Record<string, unknown> = {},
) {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'ap_capture_mailboxes', ${id}, ${action},
            ${JSON.stringify({ before, after, ...extra })}::jsonb, ${actorId})
  `);
}

async function assertEntity(
  orgId: string,
  subsidiaryId: string,
  allowed: ReadonlySet<string> | null,
): Promise<void> {
  if (allowed !== null && !allowed.has(subsidiaryId))
    throw new MailboxConfigurationError("Choose a legal entity you can manage", 404);
  const entity = (
    await db.execute(
      sql`
    select 1 from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId} and is_active and not is_elimination
  `,
      "objects",
    )
  )[0];
  if (!entity)
    throw new MailboxConfigurationError("Choose an active legal entity for this address");
}

async function storeSecret(
  orgId: string,
  mailboxId: string,
  actorId: string,
  secret: string,
): Promise<void> {
  const sealed = sealSecret(secret, { orgId, purpose: SECRET_PURPOSE });
  const stored = (
    await db.execute<{ id: string }>(
      sql`
    insert into ap_capture_mailbox_credentials (org_id, mailbox_id, sealed_secret, created_by, updated_by)
    values (${orgId}, ${mailboxId}, ${sealed}, ${actorId}, ${actorId})
    on conflict (org_id, mailbox_id) do update
      set sealed_secret = excluded.sealed_secret, updated_at = now(), updated_by = excluded.updated_by
    returning id
  `,
      "objects",
    )
  )[0];
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

/** Create an address with a fresh token, owned by its creator; the secret is sealed when supplied. */
export async function createMailbox(
  input: MailboxInput & {
    orgId: string;
    actorId: string;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<{ id: string; token: string }> {
  assertProvider(input.provider);
  const allowedSenders = normalizeAllowedSenders(input.allowedSenders);
  if (input.signingSecret) assertSecret(input.signingSecret);
  return withOrgTransaction(input.orgId, async () => {
    await assertEntity(input.orgId, input.subsidiaryId, input.allowedSubsidiaryIds);
    const token = newMailboxToken();
    const created = (
      await db.execute<{ id: string }>(
        sql`
      insert into ap_capture_mailboxes (org_id, subsidiary_id, label, email_address, token, provider,
                                        allowed_senders, is_active, owner_user_id, created_by, updated_by)
      values (${input.orgId}, ${input.subsidiaryId}, ${input.label.trim()}, ${input.emailAddress?.trim() || null}, ${token},
              ${input.provider}, ${JSON.stringify(allowedSenders)}::jsonb, ${input.isActive}, ${input.actorId},
              ${input.actorId}, ${input.actorId})
      returning id
    `,
        "objects",
      )
    )[0];
    if (!created) throw new Error("The inbound address was not created; retry the save.");
    if (input.signingSecret)
      await storeSecret(input.orgId, created.id, input.actorId, input.signingSecret);
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
export async function updateMailbox(
  input: Omit<MailboxInput, "subsidiaryId"> & {
    orgId: string;
    actorId: string;
    id: string;
    clearSigningSecret: boolean;
    rotateToken: boolean;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<{ id: string; tokenRotated: boolean }> {
  assertProvider(input.provider);
  const allowedSenders = normalizeAllowedSenders(input.allowedSenders);
  if (input.signingSecret) assertSecret(input.signingSecret);
  if (input.signingSecret && input.clearSigningSecret) {
    throw new MailboxConfigurationError("Enter a new signing secret or clear it, not both");
  }
  return withOrgTransaction(input.orgId, async () => {
    const before = await snapshot(input.orgId, input.id);
    if (
      !before ||
      (input.allowedSubsidiaryIds !== null && !input.allowedSubsidiaryIds.has(before.subsidiaryId))
    ) {
      throw new MailboxConfigurationError("Inbound address not found", 404);
    }
    const updated = (
      await db.execute<{ id: string }>(
        sql`
      update ap_capture_mailboxes
         set label = ${input.label.trim()}, email_address = ${input.emailAddress?.trim() || null},
             provider = ${input.provider}, allowed_senders = ${JSON.stringify(allowedSenders)}::jsonb,
             is_active = ${input.isActive},
             token = case when ${input.rotateToken} then ${newMailboxToken()} else token end,
             updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${input.id}
       returning id
    `,
        "objects",
      )
    )[0];
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

/**
 * Make the caller the owner of an address, for example when its owner left
 * or lost access. The new owner must be an active user of this organization
 * who holds AP create and can access the address's entity, so the transfer
 * itself always yields an address that can receive. Audited with before and
 * after state and the stated reason.
 */
export async function takeMailboxOwnership(input: {
  orgId: string;
  actorId: string;
  id: string;
  reason: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ id: string; ownerId: string }> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 2000) {
    throw new MailboxConfigurationError("Enter a reason between 5 and 2000 characters");
  }
  return withOrgTransaction(input.orgId, async () => {
    const before = await snapshot(input.orgId, input.id);
    if (
      !before ||
      (input.allowedSubsidiaryIds !== null && !input.allowedSubsidiaryIds.has(before.subsidiaryId))
    ) {
      throw new MailboxConfigurationError("Inbound address not found", 404);
    }
    if (before.ownerId === input.actorId)
      throw new MailboxConfigurationError("You already own this address", 409);
    const member = (
      await db.execute(
        sql`
      select 1 from users where org_id = ${input.orgId} and id = ${input.actorId} and is_active
    `,
        "objects",
      )
    )[0];
    if (!member)
      throw new MailboxConfigurationError(
        "Only an active user of this organization can own an inbound address",
      );
    const authority = await mailboxOwnerAuthority(
      db,
      input.orgId,
      input.actorId,
      before.subsidiaryId,
    );
    if (!authority.ok) {
      throw new MailboxConfigurationError(
        "To own this address you need permission to create bills in its legal entity",
      );
    }
    const updated = (
      await db.execute<{ id: string }>(
        sql`
      update ap_capture_mailboxes
         set owner_user_id = ${input.actorId}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${input.id}
       returning id
    `,
        "objects",
      )
    )[0];
    if (!updated) throw new MailboxConfigurationError("Inbound address not found", 404);
    const after = await snapshot(input.orgId, input.id);
    if (after?.ownerId !== input.actorId)
      throw new Error("The ownership change was not recorded; retry.");
    await audit(input.orgId, input.id, "take_ownership", input.actorId, before, after, { reason });
    return { id: input.id, ownerId: input.actorId };
  });
}

export type MailboxListRow = {
  id: string;
  label: string;
  subsidiaryId: string;
  subsidiaryName: string;
  emailAddress: string | null;
  /** The webhook credential; present only when the caller asked for tokens. */
  token: string | null;
  provider: InboundEmailProvider;
  isActive: boolean;
  ownerId: string;
  ownerName: string | null;
};

function entityScope(column: ReturnType<typeof sql.raw>, allowed: ReadonlySet<string> | null) {
  if (allowed === null) return sql``;
  if (allowed.size === 0) return sql`and false`;
  return sql`and ${column} = any(${`{${[...allowed].join(",")}}`}::uuid[])`;
}

/**
 * Addresses the viewer's legal-entity scope covers, with their owners. The
 * webhook token is a credential: it is selected only when the caller states
 * that the viewer manages addresses.
 */
export async function listMailboxes(
  orgId: string,
  allowed: ReadonlySet<string> | null,
  options: { includeTokens?: boolean } = {},
): Promise<MailboxListRow[]> {
  return await db.execute<MailboxListRow>(
    sql`
    select m.id, m.label, m.subsidiary_id as "subsidiaryId", coalesce(s.legal_name, s.name) as "subsidiaryName",
           m.email_address as "emailAddress", ${options.includeTokens === true ? sql`m.token` : sql`null::text`} as token,
           m.provider, m.is_active as "isActive", m.owner_user_id as "ownerId", u.name as "ownerName"
      from ap_capture_mailboxes m
      join subsidiaries s on s.org_id = m.org_id and s.id = m.subsidiary_id
      left join users u on u.org_id = m.org_id and u.id = m.owner_user_id
     where m.org_id = ${orgId} ${entityScope(sql.raw("m.subsidiary_id"), allowed)}
     order by m.is_active desc, m.label, m.id
  `,
    "objects",
  );
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
    db.execute<InboundMessageListRow>(
      sql`
      select im.id, m.label as "mailboxLabel", im.from_address as "fromAddress", im.subject,
             im.received_at as "receivedAt", im.attachment_count as "attachmentCount",
             im.outcome, im.outcome_reason as "outcomeReason", im.capture_item_ids as "captureItemIds"
        from ap_capture_inbound_messages im
        join ap_capture_mailboxes m on m.org_id = im.org_id and m.id = im.mailbox_id
       where im.org_id = ${orgId} ${scope}
       order by im.received_at desc, im.id desc
       limit ${page.limit} offset ${page.offset}
    `,
      "objects",
    ),
    db.execute<{ n: number }>(
      sql`
      select count(*)::int as n
        from ap_capture_inbound_messages im
        join ap_capture_mailboxes m on m.org_id = im.org_id and m.id = im.mailbox_id
       where im.org_id = ${orgId} ${scope}
    `,
      "objects",
    ),
  ]);
  return { rows: rows, total: Number(total[0]?.n ?? 0) };
}
