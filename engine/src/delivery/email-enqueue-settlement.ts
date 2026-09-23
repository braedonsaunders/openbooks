import type { EmailAttachment } from "@openbooks/emails";
import type { EnqueueEmailData } from "@openbooks/jobs";
import { deleteStoredEmailAttachments } from "./email-attachments.ts";

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
 *    accepted nothing — and deletes like case 2.) Orphaned bytes are
 *    the lesser harm: the email worker drops staged bytes at every
 *    terminal delivery, unreferenced ids are never re-read, and only
 *    live job payloads reference storage ids. (No automated staged-blob
 *    sweep exists — see the `deleteEmailAttachmentBlobs` contract in
 *    platform/file-storage.ts — so kept orphans wait for an operator.)
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

export async function settleStagedAttachmentsAfterEnqueueError(input: {
  attachments: EmailAttachment[] | undefined;
  data: EnqueueEmailData;
  jobId: string;
  error: unknown;
  probeQueuedJob?: EmailQueuedJobProbe;
  removeStagedAttachments?: RemoveStagedAttachments;
}): Promise<UncertainEnqueueSettlement> {
  const remove = input.removeStagedAttachments ?? deleteStoredEmailAttachments;
  let jobIds: string[];
  try {
    jobIds = await expectedEmailJobIds(input.data, input.jobId);
  } catch {
    // The enqueue plan cannot be built from this data, and the real
    // producer builds the identical plan before touching Redis — so it
    // provably accepted nothing. Delete this attempt's refs and rethrow.
    await remove(input.attachments);
    throw input.error;
  }
  const probe = input.probeQueuedJob ?? defaultProbeQueuedJob;
  let found: string[];
  try {
    found = [];
    for (const jobId of jobIds) {
      if (await probe(jobId)) found.push(jobId);
    }
  } catch {
    // The queue cannot be reached to check: the job may exist, so the
    // refs stay and the original error propagates for a retry.
    throw input.error;
  }
  if (found.length === jobIds.length) return { outcome: "already-queued", jobIds: found };
  if (found.length === 0) {
    await remove(input.attachments);
    throw input.error;
  }
  // Partial acceptance: the live jobs still need their refs, and the
  // missing recipients still need a retry — keep everything and rethrow.
  throw input.error;
}
