import { createHash } from "node:crypto";
import { basename } from "node:path";
import { sql } from "drizzle-orm";
import { enqueueApCapture } from "@openbooks/jobs";
import { db } from "@openbooks/engine/platform/db";
import { extractNativeInvoice } from "@openbooks/engine/payables/einvoice";
import { orgFeatureEnabled } from "@openbooks/engine/organization/features";
import { captureContentMatchesMime } from "@openbooks/engine/payables/ap-capture";
import { EInvoiceParseError } from "@openbooks/engine/einvoice/parse";
import {
  getDocumentCaptureRuntimeConfig,
  type DocumentCaptureRuntimeConfig,
} from "@openbooks/engine/payables/ap-capture-config";
import {
  assertLlmReadable,
  LlmCaptureError,
} from "@openbooks/engine/payables/document-capture-llm";
import { createFile, deleteFile, ensureApCaptureRoot } from "../../../lib/file-cabinet";
import { enqueueStorageCleanupStandalone, fileCabinetObjectKey } from "../../../lib/file-storage";

/**
 * The one capture intake. The upload button and the inbound email webhook
 * both store source documents and queue extraction through here, so every
 * channel meets the same type, size, signature, e-invoicing and provider
 * checks and the same storage and queue failure handling.
 */

export const CAPTURE_MAX_FILES = 50;
export const CAPTURE_MAX_BYTES = 20 * 1024 * 1024;
export const CAPTURE_MAX_BATCH_BYTES = 100 * 1024 * 1024;
export const CAPTURE_ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "application/xml",
  "text/xml",
]);

export type CaptureSourceFile = { filename: string; contentType: string; bytes: Buffer };

export type CaptureIntakeResult = {
  filename: string;
  id?: string;
  status: "uploaded" | "failed" | "duplicate";
  error?: string;
};

/**
 * A refusal of the whole batch: either a named refusal body with its status,
 * or a typed error the caller answers through the shared error mapping.
 */
export type CaptureIntakeRefusal =
  | { ok: false; status: number; body: { error: string } & Record<string, unknown> }
  | { ok: false; thrown: unknown; safeStatus?: number };

export type CaptureIntakeAccepted = { ok: true; ids: string[]; results: CaptureIntakeResult[] };

export function safeCaptureFilename(value: string): string {
  return (
    basename(value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 240) || "document"
  );
}

/**
 * Detailed reason for a batch refusal, recorded where administrators read it
 * (the inbound message outcome). It may carry configuration or decoder
 * detail, so it is never sent to an unauthenticated caller.
 */
export function captureIntakeRefusalReason(refusal: CaptureIntakeRefusal): string {
  if ("body" in refusal) {
    const filename = typeof refusal.body.filename === "string" ? ` (${refusal.body.filename})` : "";
    return `${refusal.body.error}${filename}`;
  }
  return refusal.thrown instanceof Error ? refusal.thrown.message : "capture intake failed";
}

export async function ingestCaptureFiles(input: {
  orgId: string;
  /** The actor the stored file and capture are attributed to; the worker acts as them. */
  actorId: string;
  /** Frozen into the extraction job so auto-materialize cannot widen the actor's scope. */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  files: CaptureSourceFile[];
  source: "upload" | "email";
  /** Receiving legal entity named by the intake channel. */
  subsidiaryId?: string | null;
  /** Event detail recorded with each capture (for example the inbound message it came from). */
  evidence?: Record<string, unknown>;
  /** Skip files whose bytes already back a live capture (email retries and re-forwards). */
  skipKnownContent?: boolean;
}): Promise<CaptureIntakeRefusal | CaptureIntakeAccepted> {
  const files = input.files;
  if (files.length === 0) return { ok: false, status: 400, body: { error: "no_files" } };
  if (files.length > CAPTURE_MAX_FILES)
    return { ok: false, status: 422, body: { error: "too_many_files", limit: CAPTURE_MAX_FILES } };
  const prepared: Array<{
    contentType: string;
    bytes: Buffer;
    filename: string;
    hash: string;
    native: boolean;
  }> = [];
  let batchBytes = 0;
  for (const file of files) {
    if (!CAPTURE_ALLOWED_TYPES.has(file.contentType))
      return {
        ok: false,
        status: 422,
        body: { error: "unsupported_type", filename: file.filename },
      };
    if (file.bytes.length <= 0 || file.bytes.length > CAPTURE_MAX_BYTES)
      return { ok: false, status: 422, body: { error: "invalid_size", filename: file.filename } };
    batchBytes += file.bytes.length;
    if (batchBytes > CAPTURE_MAX_BATCH_BYTES)
      return { ok: false, status: 422, body: { error: "batch_too_large" } };
    if (!captureContentMatchesMime(file.bytes, file.contentType))
      return {
        ok: false,
        status: 422,
        body: { error: "content_type_mismatch", filename: file.filename },
      };
    const nativeEnabled = await orgFeatureEnabled(input.orgId, "einvoicing");
    if (
      !nativeEnabled &&
      (file.contentType === "application/xml" || file.contentType === "text/xml")
    ) {
      return {
        ok: false,
        status: 422,
        body: {
          error: "Enable E-invoicing in Company Settings → Features to receive XML invoices.",
        },
      };
    }
    let native = false;
    try {
      native = nativeEnabled && (await extractNativeInvoice(file.bytes, file.contentType)) !== null;
    } catch (error) {
      // Parse refusals name the defect at 422; a decoder or PDF failure
      // is unexpected and answers through the shared mapping.
      if (error instanceof EInvoiceParseError) return { ok: false, thrown: error, safeStatus: 422 };
      return { ok: false, thrown: error };
    }
    prepared.push({
      contentType: file.contentType,
      bytes: file.bytes,
      filename: safeCaptureFilename(file.filename),
      hash: createHash("sha256").update(file.bytes).digest("hex"),
      native,
    });
  }
  if (prepared.some((upload) => !upload.native)) {
    let captureConfig: DocumentCaptureRuntimeConfig | null;
    try {
      captureConfig = await getDocumentCaptureRuntimeConfig(input.orgId);
    } catch (error) {
      // Endpoint misconfiguration is typed 422 at its origin with its
      // remedy; collapsing it into capture_not_configured sent operators
      // to reconfigure a correctly configured endpoint. Anything else is
      // unexpected: the shared mapping logs it and answers 500.
      return { ok: false, thrown: error };
    }
    if (!captureConfig)
      return { ok: false, status: 409, body: { error: "capture_not_configured" } };
    if (captureConfig.provider === "llm_vision") {
      // The AI model provider reads only the formats its API accepts;
      // refuse the others before anything is stored or queued.
      for (const upload of prepared.filter((entry) => !entry.native)) {
        try {
          assertLlmReadable(captureConfig.llm.provider, upload.contentType);
        } catch (error) {
          if (error instanceof LlmCaptureError) {
            return {
              ok: false,
              status: 422,
              body: {
                error: `${upload.filename}: ${error.message}`,
                code: error.code,
                filename: upload.filename,
              },
            };
          }
          throw error;
        }
      }
    }
  }
  const known =
    input.skipKnownContent && prepared.length > 0
      ? new Set(
          (
            await db.execute<{ hash: string }>(
              sql`
        select distinct content_hash as hash from ap_capture_items
         where org_id = ${input.orgId} and status not in ('rejected', 'failed')
           and content_hash = any(${`{${prepared.map((upload) => upload.hash).join(",")}}`}::text[])
      `,
              "objects",
            )
          ).map((row) => row.hash),
        )
      : new Set<string>();
  const folderId = await ensureApCaptureRoot(input.orgId, input.actorId);
  const created: string[] = [];
  const results: CaptureIntakeResult[] = [];
  for (const upload of prepared) {
    if (known.has(upload.hash)) {
      results.push({ filename: upload.filename, status: "duplicate" });
      continue;
    }
    known.add(upload.hash);
    let storedId: string | null = null;
    let captureItemId: string | null = null;
    try {
      const stored = await createFile({
        orgId: input.orgId,
        folderId,
        filename: upload.filename,
        contentType: upload.contentType,
        bytes: upload.bytes,
        createdBy: input.actorId,
      });
      storedId = stored.id;
      captureItemId = await db.transaction(async (tx) => {
        const inserted = await tx.execute<{ id: string }>(
          sql`
          insert into ap_capture_items (org_id, file_id, status, source, original_filename,
                                        content_hash, subsidiary_id, created_by, updated_by)
          values (${input.orgId}, ${stored.id}, 'queued', ${input.source}, ${upload.filename},
                  ${upload.hash}, ${input.subsidiaryId ?? null}, ${input.actorId}, ${input.actorId})
          returning id
        `,
          "objects",
        );
        const id = inserted[0]!.id;
        await tx.execute(sql`
          insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
          values (${input.orgId}, ${id}, ${input.source === "email" ? "email_received" : "uploaded"},
                  ${JSON.stringify({ filename: upload.filename, sizeBytes: upload.bytes.length, ...input.evidence })}::jsonb,
                  ${input.actorId})
        `);
        return id;
      });
      created.push(captureItemId!);
    } catch {
      // deleteFile only marks the file inactive, so
      // the committed S3 blobs would strand. Record durable cleanup intents
      // for every staged version, then keep the existing failure handling.
      if (storedId) {
        try {
          const staged = await db.execute<{ id: string }>(
            sql`
            select fv.id from file_versions fv
            join files fi on fi.id = fv.file_id and fi.org_id = ${input.orgId}
            where fv.file_id = ${storedId} and fv.storage_kind = 's3'
          `,
            "objects",
          );
          for (const version of staged) {
            await enqueueStorageCleanupStandalone({
              orgId: input.orgId,
              objectKey: fileCabinetObjectKey(version.id),
              ownerKind: "file_version",
              ownerId: storedId,
            });
          }
        } catch {
          // Intent recording is best-effort on this path; the upload_failed
          // result below is the evidence that must survive.
        }
        await deleteFile(input.orgId, storedId).catch(() => false);
      }
      results.push({ filename: upload.filename, status: "failed", error: "upload_failed" });
      continue;
    }
    const committedId = captureItemId!;
    try {
      // Capture the actor's scope in the job: the worker acts as this
      // actor when it auto-materializes, and must not inherit an
      // unrestricted default there.
      await enqueueApCapture({
        orgId: input.orgId,
        captureItemId: committedId,
        actorId: input.actorId,
        allowedSubsidiaryIds:
          input.allowedSubsidiaryIds === null ? null : [...input.allowedSubsidiaryIds],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "queue_unavailable";
      try {
        await db.execute(sql`
          update ap_capture_items set status = 'failed', last_error = ${message}, updated_at = now()
           where id = ${committedId} and org_id = ${input.orgId}
        `);
      } catch {
        // The item is committed and its id must remain observable even when
        // recording the queue refusal also fails; reporting this file as a
        // plain request failure would make a client retry create a duplicate.
      }
      results.push({
        filename: upload.filename,
        id: committedId,
        status: "failed",
        error: "processing_failed",
      });
      continue;
    }
    results.push({ filename: upload.filename, id: committedId, status: "uploaded" });
  }
  return { ok: true, ids: created, results };
}
