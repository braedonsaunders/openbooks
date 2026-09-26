import { sql } from "drizzle-orm";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { db, withBypassContext, type SqlExecutor } from "./db.ts";
import {
  deleteS3Blobs,
  emailAttachmentsKeyPrefix,
  fileCabinetKeyPrefix,
  getS3Client,
  s3Bucket,
} from "./file-storage.ts";

/**
 * Durable S3 cleanup outbox (migration 0386).
 *
 * Object storage has no transactions: a blob written before its DB commit
 * (or deleted beside a row delete) can strand bytes no row references when
 * the database rolls back, crashes, or partially fails. Every S3 delete
 * path therefore records its object key here — in the same transaction as
 * the row delete where one exists — and the `storage-cleanup` worker duty
 * drains due rows with claim-expiry reclaim. Inline best-effort deletes
 * stay where they are; this table is the backstop, and the S3 delete itself
 * is idempotent, so a double delete (inline + drained) is a confirmed
 * no-op rather than an error.
 *
 * Row shape mirrors scheduler_outbox: org isolation (`org_id` + the
 * standard org_isolation policy), attempts/next_attempt_at backoff,
 * claimed_at leases. The worker always drains under bypass; org writers
 * enqueue through their own transaction with their own org id.
 */

export const STORAGE_CLEANUP_OWNER_KINDS = [
  "file_version",
  "file_version_copy",
  "email_attachment",
] as const;

export type StorageCleanupOwnerKind = (typeof STORAGE_CLEANUP_OWNER_KINDS)[number];

export interface StorageCleanupIntent {
  orgId: string;
  /** Full bucket key, e.g. `file-cabinet/<versionId>` or `email-attachments/<id>`. */
  objectKey: string;
  ownerKind: StorageCleanupOwnerKind;
  /** The owning row id (version id, staging id) for operator triage. */
  ownerId: string;
}

/** Claim lease: a crashed drain pass reclaims its rows after this long. */
const CLAIM_LEASE_SECONDS = 300;
/** Backoff cap between attempts (30 * n^2 seconds, capped). */
const MAX_BACKOFF_SECONDS = 1800;
const DRAIN_BATCH_LIMIT = 100;

function assertIntent(intent: StorageCleanupIntent): void {
  if (!intent.orgId?.trim()) throw new Error("storage cleanup intent needs an org id — refusing an unscoped delete");
  if (!intent.objectKey?.includes("/")) throw new Error("storage cleanup intent needs a namespaced object key — refusing a bare id");
  if (!(STORAGE_CLEANUP_OWNER_KINDS as readonly string[]).includes(intent.ownerKind)) {
    throw new Error(`storage cleanup intent has unknown owner kind ${intent.ownerKind}`);
  }
  if (!intent.ownerId?.trim()) throw new Error("storage cleanup intent needs an owner id for triage");
}

/**
 * Record a cleanup intent on the caller's executor (transaction or handle).
 * Safe to call when the object may already be gone: the drain treats a
 * confirmed-absent delete as success and drops the row.
 *
 * The caller MUST pass the transaction that owns the row delete when one
 * exists, so intent and delete commit atomically. Standalone callers (no
 * ambient transaction) must use enqueueStorageCleanupStandalone instead —
 * a bypass insert on another connection would survive the caller's
 * rollback and let the worker delete a still-referenced object.
 */
export async function enqueueStorageCleanup(
  executor: SqlExecutor,
  intent: StorageCleanupIntent,
): Promise<void> {
  assertIntent(intent);
  await executor.execute(sql`
    insert into storage_cleanup_outbox (org_id, object_key, owner_kind, owner_id)
    values (${intent.orgId}, ${intent.objectKey}, ${intent.ownerKind}, ${intent.ownerId})
    -- A pending intent already owns this key: overlapping delete paths (a
    -- row delete plus a terminal sweep, or a retried producer) converge
    -- here by design, so the second write is expected and benign. The
    -- worker drains the single surviving intent.
    on conflict (object_key) do nothing
  `);
}

/**
 * Record a cleanup intent outside any caller transaction (rowless paths:
 * staging rollback, clone compensation, post-commit sweeps). Runs its own
 * bypass transaction — call ONLY on failure paths or after the owner's
 * commit, never where a surrounding transaction may still roll back (see
 * enqueueStorageCleanup). A failed enqueue here is logged, never thrown:
 * this runs on catch paths where masking the original error would destroy
 * the only evidence of what failed.
 */
export async function enqueueStorageCleanupStandalone(intent: StorageCleanupIntent): Promise<void> {
  try {
    await withBypassContext(async () => {
      await enqueueStorageCleanup(db, intent);
    });
  } catch (error) {
    console.error(
      `[storage-cleanup] could not record cleanup for ${intent.objectKey} (${intent.ownerKind} ${intent.ownerId}):`,
      error instanceof Error ? error.message : error,
    );
  }
}

const FILE_CABINET_PREFIX = fileCabinetKeyPrefix;
const EMAIL_ATTACHMENTS_PREFIX = emailAttachmentsKeyPrefix;

/** Delete one outbox key, confirming per-object success (S3 reports some failures inside a 200). */
async function deleteCleanupObject(objectKey: string): Promise<void> {
  if (objectKey.startsWith(FILE_CABINET_PREFIX)) {
    const versionId = objectKey.slice(FILE_CABINET_PREFIX.length);
    if (!/^[A-Za-z0-9_.-]{1,160}$/.test(versionId)) throw new Error(`refusing to delete malformed cabinet key ${objectKey}`);
    // Confirms every key internally; throws FileBlobDeleteError when unconfirmed.
    await deleteS3Blobs([versionId]);
    return;
  }
  if (objectKey.startsWith(EMAIL_ATTACHMENTS_PREFIX)) {
    const id = objectKey.slice(EMAIL_ATTACHMENTS_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`refusing to delete malformed staging key ${objectKey}`);
    const result = await getS3Client().send(
      new DeleteObjectsCommand({
        Bucket: s3Bucket(),
        Delete: { Objects: [{ Key: objectKey }], Quiet: false },
      }),
    );
    const failures = result.Errors ?? [];
    if (failures.length > 0) {
      const first = failures[0]!;
      throw new Error(
        `staging delete refused for ${objectKey}: ${[first.Code, first.Message].filter(Boolean).join(" ") || "unknown"}`,
      );
    }
    return;
  }
  throw new Error(`refusing to delete object under unknown storage prefix: ${objectKey}`);
}

export interface StorageCleanupDrainSummary {
  claimed: number;
  deleted: number;
  deferred: number;
}

/**
 * Drain due intents: claim with a lease (crashed passes are reclaimed after
 * CLAIM_LEASE_SECONDS), delete each object, drop the row on confirmed
 * delete, back off with the service cause otherwise. Deletes the row only
 * AFTER the object delete confirms, so a crash between the two retries a
 * no-op delete rather than leaking a referenced row. Never throws — the
 * duty registry records per-duty failure, and every intent stays visible
 * with its last_error for operators.
 */
export async function drainStorageCleanupOutbox(limit: number = DRAIN_BATCH_LIMIT): Promise<StorageCleanupDrainSummary> {
  const summary: StorageCleanupDrainSummary = { claimed: 0, deleted: 0, deferred: 0 };
  await withBypassContext(async () => {
    const due = (await db.execute<{
      id: string;
      object_key: string;
      owner_kind: string;
      owner_id: string;
      attempts: number;
    }>(sql`
      update storage_cleanup_outbox
         set claimed_at = now(),
             next_attempt_at = now() + make_interval(secs => ${CLAIM_LEASE_SECONDS}),
             attempts = attempts + 1,
             updated_at = now()
       where id in (
         select id from storage_cleanup_outbox
          where next_attempt_at <= now()
          order by next_attempt_at
          limit ${limit}
          for update skip locked
       )
       returning id, object_key, owner_kind, owner_id, attempts
    `)).rows;
    summary.claimed = due.length;
    for (const row of due) {
      try {
        await deleteCleanupObject(row.object_key);
        await db.execute(sql`delete from storage_cleanup_outbox where id = ${row.id}`);
        summary.deleted += 1;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
        await db.execute(sql`
          update storage_cleanup_outbox
             set last_error = ${message},
                 next_attempt_at = now() + make_interval(secs => least(${MAX_BACKOFF_SECONDS}, 30 * attempts * attempts)),
                 claimed_at = null,
                 updated_at = now()
           where id = ${row.id}
        `);
        summary.deferred += 1;
      }
    }
  });
  return summary;
}
