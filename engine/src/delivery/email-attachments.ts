import { createHash, randomUUID } from "node:crypto";
import {
  assertValidEmailAttachmentPayloads,
  isEmailAttachmentRef,
  type EmailAttachment,
  type EmailAttachmentPayload,
  type EmailAttachmentRef,
} from "@openbooks/emails";
import {
  deleteEmailAttachmentBlobs,
  emailAttachmentObjectKey,
  getEmailAttachmentBlob,
  putEmailAttachmentBlob,
  s3Enabled,
} from "../platform/file-storage.ts";
import { enqueueStorageCleanupStandalone } from "../platform/storage-cleanup.ts";
import { sealSecret, unsealSecret } from "../platform/secrets.ts";

/**
 * Email attachments by reference.
 *
 * Rendered record PDFs (invoices, pay stubs) used to ride inside the BullMQ
 * job as base64, where they sat — unencrypted, `appendonly yes` — for the
 * 7-day completed / 30-day failed retention. Queue payloads must not carry
 * file bytes: producers store each attachment through
 * `storeEmailAttachments` and enqueue the returned references; the worker
 * materializes them with `loadEmailAttachments` immediately before
 * transmission and drops the staged bytes with
 * `deleteStoredEmailAttachments` once the delivery reaches a terminal state.
 *
 * Two stores, one shape: object storage when configured (preferred), the
 * sealed-secret primitive otherwise. Legacy inline payloads still drain
 * through `loadEmailAttachments` so jobs enqueued before this change send
 * exactly once — but no new enqueue may produce them.
 *
 * Staged-blob ownership follows the durable enqueue intent: every producer
 * stages under its deterministic queue job id (flow-email row, close-package
 * binder intent, report dispatch generation), and the storage key derives
 * from that intent plus the attachment position and filename. A retry of the
 * same intent therefore overwrites the same keys instead of stranding a fresh
 * random generation per attempt — the uncertain-enqueue orphan class. Keys
 * stay unique per intent, so distinct deliveries never share bytes; the
 * worker's terminal delete and the settlement's provable-non-acceptance
 * delete remove exactly the intent's key set.
 */

/**
 * Derive one intent-bound storage key per attachment. Without a seed the key
 * stays random (callers with no stable enqueue identity); with a seed the
 * same (seed, position, filename) always maps to the same key, so retries of
 * one enqueue intent overwrite rather than accumulate. Safe only because
 * every seeded producer's bytes are a pure function of its intent identity.
 */
export function emailStagingKey(seed: string | undefined, index: number, filename: string): string {
  if (!seed) return randomUUID();
  return `d-${createHash("sha256").update(`${seed}:${index}:${filename}`).digest("hex").slice(0, 31)}`;
}

export async function storeEmailAttachments(
  attachments: EmailAttachmentPayload[] | undefined,
  opts: { storageKeySeed?: string; orgId?: string } = {},
): Promise<EmailAttachmentRef[]> {
  if (!attachments || attachments.length === 0) return [];
  assertValidEmailAttachmentPayloads(attachments);
  const stored: EmailAttachmentRef[] = [];
  const writtenStorageKeys: string[] = [];
  try {
    for (const [index, attachment] of attachments.entries()) {
      const bytes = Buffer.from(attachment.content, "base64");
      const contentType = attachment.contentType ?? "application/octet-stream";
      if (s3Enabled) {
        const id = emailStagingKey(opts.storageKeySeed, index, attachment.filename);
        await putEmailAttachmentBlob(id, bytes, contentType);
        writtenStorageKeys.push(id);
        stored.push({ filename: attachment.filename, contentType: attachment.contentType, storageKey: id });
      } else {
        stored.push({ filename: attachment.filename, contentType: attachment.contentType, sealed: sealSecret(attachment.content) });
      }
    }
  } catch (error) {
    // The caller never receives partial refs, so a mid-loop failure must
    // delete every key this call already wrote before rethrowing —
    // otherwise the orphaned blobs sit in object storage unreferenced
    // forever (no TTL covers them). I5-platform-57: the inline delete stays,
    // and when the caller names its org a durable cleanup intent is recorded
    // first so the worker retries what inline cannot confirm.
    if (opts?.orgId) {
      for (const key of writtenStorageKeys) {
        await enqueueStorageCleanupStandalone({
          orgId: opts.orgId,
          objectKey: emailAttachmentObjectKey(key),
          ownerKind: "email_attachment",
          ownerId: key,
        });
      }
    }
    await deleteEmailAttachmentBlobs(writtenStorageKeys);
    throw error;
  }
  return stored;
}

/** Materialize queue attachments to transmittable bytes (fetched, unsealed, or passed through while draining). */
export async function loadEmailAttachments(
  attachments: EmailAttachment[] | undefined,
): Promise<EmailAttachmentPayload[]> {
  if (!attachments || attachments.length === 0) return [];
  const loaded: EmailAttachmentPayload[] = [];
  for (const attachment of attachments) {
    if (!isEmailAttachmentRef(attachment)) {
      loaded.push(attachment);
      continue;
    }
    if ("storageKey" in attachment) {
      const bytes = await getEmailAttachmentBlob(attachment.storageKey);
      if (!bytes) {
        throw new Error(
          `email attachment ${attachment.filename} is missing from object storage; refusing to send a truncated message`,
        );
      }
      loaded.push({ filename: attachment.filename, contentType: attachment.contentType, content: bytes.toString("base64") });
      continue;
    }
    const content = unsealSecret(attachment.sealed);
    if (!content) {
      throw new Error(
        `email attachment ${attachment.filename} cannot be unsealed; refusing to send a truncated message`,
      );
    }
    loaded.push({ filename: attachment.filename, contentType: attachment.contentType, content });
  }
  return loaded;
}

/** Drop staged bytes for references (object-storage ids only); never throws. */
export async function deleteStoredEmailAttachments(
  attachments: EmailAttachment[] | undefined,
): Promise<void> {
  const ids = (attachments ?? []).flatMap((attachment) =>
    isEmailAttachmentRef(attachment) && "storageKey" in attachment ? [attachment.storageKey] : [],
  );
  if (ids.length > 0) await deleteEmailAttachmentBlobs(ids);
}
