import { isEmailAttachmentRef, type EmailAttachment } from "@openbooks/emails";
import type { EnqueueEmailData } from "@openbooks/jobs";
import { deleteStoredEmailAttachments } from "./email-attachments.ts";
import { emailAttachmentObjectKey } from "../platform/file-storage.ts";
import { enqueueStorageCleanupStandalone } from "../platform/storage-cleanup.ts";

/**
 * Uncertain email-enqueue settlement — the single handoff all staged
 * attachment producers share (scheduled-report dispatch, close-package
 * delivery, durable flow-email drain).
 *
 * A Redis/BullMQ `add` can accept the job and then lose its reply or
 * connection: the job exists while the enqueue throws. Deleting the staged
 * attachment refs on ANY enqueue exception strands that live job — its
 * worker later refuses the missing blob and a valid message never sends.
 * So an enqueue exception settles, in this order:
 *
 * 1. Derive the exact queue identities the accepted jobs would carry
 *    (the real `buildEmailJobs` plan, including per-recipient fanout ids)
 *    and probe the queue for each. When every expected job exists, the
 *    throw was a lost acknowledgement: keep the staged refs and report
 *    success so the caller proceeds down its normal delivered path.
 * 2. When NO expected job exists, the handoff provably never landed:
 *    delete the refs this attempt staged (they belong to this attempt
 *    alone, each under a fresh random id) and rethrow the original error.
 * 3. When only SOME expected jobs exist (a partially-accepted multi-
 *    recipient add), keep the refs and rethrow: the caller's retry
 *    re-adds the same deterministic ids, collapsing onto the live jobs
 *    and creating only the missing ones. Deleting would strand the live
 *    jobs; reporting success would drop the missing recipients.
 * 4. When the queue cannot be reached for that check, the job may
 *    exist: keep the refs and rethrow the original error for a retry.
 *    (An UNBUILDABLE plan is the opposite case — the real producer
 *    builds the identical plan before touching Redis, so it provably
 *    accepted nothing — and deletes like case 2.) Kept refs are bounded,
 *    not orphans: every producer stages under intent-derived storage keys
 *    (`emailStagingKey`), so a retry overwrites the same blobs instead of
 *    minting a fresh random generation per attempt. The email worker drops
 *    staged bytes at every terminal delivery, unreferenced ids are never
 *    re-read, and only live job payloads reference storage ids. (No
 *    automated staged-blob sweep exists — see the
 *    `deleteEmailAttachmentBlobs` contract in platform/file-storage.ts —
 *    so bytes stranded outside an intent's key set still wait for an
 *    operator.)
 *
 * The probe and the removal are injectable so unit tests can drive the
 * three queue states without Redis; production uses the live queue and
 * the real staged-blob removal.
 */

export type EmailQueuedJobProbe = (jobId: string) => Promise<unknown>;

export type RemoveStagedAttachments = (
  attachments: EmailAttachment[] | undefined,
) => Promise<void>;

export type UncertainEnqueueSettlement = {
  outcome: "already-queued";
  jobIds: string[];
};

export type EmailEnqueueErrorProbeResult =
  | { outcome: "already-queued"; jobIds: string[] }
  | { outcome: "not-queued"; jobIds: string[] }
  | { outcome: "uncertain"; jobIds: string[] };

async function defaultProbeQueuedJob(jobId: string): Promise<unknown> {
  // Lazy like the scheduling outbox's producer import: scan-only workers
  // that never enqueue must not pay for the queue client at module load.
  const { getEmailQueue } = await import("@openbooks/jobs");
  return getEmailQueue().getJob(jobId);
}

async function expectedEmailJobIds(data: EnqueueEmailData, jobId: string): Promise<string[]> {
  // The exact plan the producer enqueues — never a reimplementation, so
  // single-recipient ids and per-recipient fanout ids cannot drift apart.
  const { buildEmailJobs } = await import("@openbooks/jobs");
  return buildEmailJobs(data, { jobId }).map((job) => job.opts.jobId);
}

/**
 * Inspect a failed enqueue with the canonical BullMQ job plan. Only an empty
 * result proves that a producer may safely record a definite enqueue failure;
 * a partial result or an unavailable queue remains uncertain.
 */
export async function probeEmailEnqueueAfterError(input: {
  data: EnqueueEmailData;
  jobId: string;
  probeQueuedJob?: EmailQueuedJobProbe;
}): Promise<EmailEnqueueErrorProbeResult> {
  let jobIds: string[];
  try {
    jobIds = await expectedEmailJobIds(input.data, input.jobId);
  } catch {
    return { outcome: "not-queued", jobIds: [] };
  }
  let found: string[];
  try {
    const probe = input.probeQueuedJob ?? defaultProbeQueuedJob;
    found = [];
    for (const id of jobIds) {
      if (await probe(id)) found.push(id);
    }
  } catch {
    return { outcome: "uncertain", jobIds: [] };
  }
  if (found.length === jobIds.length) return { outcome: "already-queued", jobIds: found };
  if (found.length === 0) return { outcome: "not-queued", jobIds };
  return { outcome: "uncertain", jobIds: found };
}

export async function settleStagedAttachmentsAfterEnqueueError(input: {
  attachments: EmailAttachment[] | undefined;
  data: EnqueueEmailData;
  jobId: string;
  error: unknown;
  probeQueuedJob?: EmailQueuedJobProbe;
  removeStagedAttachments?: RemoveStagedAttachments;
}): Promise<UncertainEnqueueSettlement> {
  const remove =
    input.removeStagedAttachments ??
    (async (attachments: EmailAttachment[] | undefined): Promise<void> => {
      // Durable cleanup intents first so the worker duty
      // retries what the inline delete below cannot confirm; the inline
      // attempt stays.
      for (const attachment of attachments ?? []) {
        if (isEmailAttachmentRef(attachment) && "storageKey" in attachment) {
          await enqueueStorageCleanupStandalone({
            orgId: input.data.orgId,
            objectKey: emailAttachmentObjectKey(attachment.storageKey),
            ownerKind: "email_attachment",
            ownerId: attachment.storageKey,
          });
        }
      }
      await deleteStoredEmailAttachments(attachments);
    });
  const result = await probeEmailEnqueueAfterError(input);
  if (result.outcome === "already-queued") return result;
  if (result.outcome === "not-queued") {
    await remove(input.attachments);
  }
  // Partial acceptance and an unavailable queue remain uncertain: live jobs
  // may need the refs, so retain them and let the caller retry the handoff.
  throw input.error;
}
