import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectsCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { env } from "./db.ts";

/** Shared file-cabinet blob driver used by both web requests and workers. */
const S3_VARS = ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"] as const;

export const s3Enabled: boolean = S3_VARS.every((key) => Boolean(env[key]));

export function activeStorageKind(): "db" | "s3" {
  return s3Enabled ? "s3" : "db";
}

let client: S3Client | null = null;
function s3(): S3Client {
  client ??= new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || "us-east-1",
    credentials: {
      // Live reads: db.ts snapshots the environment at module evaluation.
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true,
    // Only send integrity checksums when an operation requires them (e.g.
    // DeleteObjects). The SDK's default ("WHEN_SUPPORTED") appends a trailing
    // CRC32 to streamed PUT bodies, which several S3-compatible stores either
    // reject or silently fold into the object; the backup service computes
    // its own sha256, so nothing is lost.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return client;
}

const objectKey = (versionId: string) => `file-cabinet/${versionId}`;

/**
 * Build the `x-amz-copy-source` value for an S3 server-side copy: the bucket
 * plus the source key with every path segment URL-encoded (`/` separators
 * kept). The installed SDK sends CopySource verbatim and AWS requires the
 * encoded form — keys with spaces, `#`, `?`, `+` or non-ASCII otherwise break
 * the copy (versioned blobs, SFTP renames). The single shared helper for every
 * server-side copy in the engine; do not fork it.
 */
export function encodeS3CopySource(bucket: string, sourceKey: string): string {
  const encodedKey = sourceKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${encodeURIComponent(bucket)}/${encodedKey}`;
}

/** Shared S3 client + bucket for other object-storage users (org backups). */
export function getS3Client(): S3Client {
  return s3();
}

export function s3Bucket(): string {
  return env.S3_BUCKET!;
}

/** Bounded callers may pass an AbortSignal for readiness probes. */
export async function assertS3Ready(abortSignal?: AbortSignal): Promise<void> {
  await s3().send(new HeadBucketCommand({ Bucket: s3Bucket() }), { abortSignal });
}

/**
 * Object-store driver behind the file-cabinet blob functions. Production
 * traffic uses the S3 implementation; tests replace the network (not the
 * dispatch) with an in-memory store via setFileBlobStoreForTests.
 */
export interface FileBlobStore {
  putObject(versionId: string, bytes: Buffer, contentType: string): Promise<void>;
  getObject(versionId: string): Promise<Buffer | null>;
  copyObject(fromVersionId: string, toVersionId: string): Promise<void>;
  deleteObjects(versionIds: string[]): Promise<void>;
}

const s3Store: FileBlobStore = {
  async putObject(versionId, bytes, contentType) {
    await s3().send(new PutObjectCommand({
      Bucket: env.S3_BUCKET!,
      Key: objectKey(versionId),
      Body: bytes,
      ContentType: contentType,
    }));
  },
  async getObject(versionId) {
    try {
      const result = await s3().send(new GetObjectCommand({
        Bucket: env.S3_BUCKET!,
        Key: objectKey(versionId),
      }));
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey") return null;
      throw error;
    }
  },
  async copyObject(fromVersionId, toVersionId) {
    // Server-side copy: bytes never transit the clone worker.
    await s3().send(new CopyObjectCommand({
      Bucket: env.S3_BUCKET!,
      CopySource: encodeS3CopySource(env.S3_BUCKET!, objectKey(fromVersionId)),
      Key: objectKey(toVersionId),
    }));
  },
  async deleteObjects(versionIds) {
    for (let index = 0; index < versionIds.length; index += 1_000) {
      const chunk = versionIds.slice(index, index + 1_000);
      try {
        await s3().send(new DeleteObjectsCommand({
          Bucket: env.S3_BUCKET!,
          Delete: { Objects: chunk.map((id) => ({ Key: objectKey(id) })), Quiet: true },
        }));
      } catch (error) {
        console.error("[file-storage] S3 blob cleanup failed (objects orphaned):", (error as Error).message);
      }
    }
  },
};

let storeOverride: FileBlobStore | null = null;

/**
 * Test seam: replace the object store (the network) with an in-memory
 * implementation. Pass null to restore the S3 driver. Callers keep using
 * put/get/copy/deleteS3Blob, so the dispatch under test is the real one.
 */
export function setFileBlobStoreForTests(store: FileBlobStore | null): void {
  storeOverride = store;
}

/** In-memory FileBlobStore for tests: no network, same interface. */
export function createInMemoryFileBlobStore(): FileBlobStore & { keys(): string[] } {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  return {
    async putObject(versionId, bytes, contentType) {
      objects.set(versionId, { bytes: Buffer.from(bytes), contentType });
    },
    async getObject(versionId) {
      const found = objects.get(versionId);
      return found ? Buffer.from(found.bytes) : null;
    },
    async copyObject(fromVersionId, toVersionId) {
      const found = objects.get(fromVersionId);
      if (!found) throw new Error(`in-memory blob store has no object for version ${fromVersionId}`);
      objects.set(toVersionId, { bytes: Buffer.from(found.bytes), contentType: found.contentType });
    },
    async deleteObjects(versionIds) {
      for (const id of versionIds) objects.delete(id);
    },
    keys() {
      return [...objects.keys()];
    },
  };
}

function activeStore(): FileBlobStore {
  return storeOverride ?? s3Store;
}

export async function putS3Blob(versionId: string, bytes: Buffer, contentType: string): Promise<void> {
  await activeStore().putObject(versionId, bytes, contentType);
}

export async function getS3Blob(versionId: string): Promise<Buffer | null> {
  return activeStore().getObject(versionId);
}

/** Server-side object copy for sandbox clones (S3-backed versions only). */
export async function copyS3Blob(fromVersionId: string, toVersionId: string): Promise<void> {
  await activeStore().copyObject(fromVersionId, toVersionId);
}

/**
 * Ephemeral email-attachment objects: rendered PDFs staged for the queue,
 * fetched by the worker at send time and deleted once the delivery reaches a
 * terminal state. A separate prefix keeps them out of the file cabinet (they
 * are transport staging, not tenant records) so cabinet retention and
 * lifecycle rules never apply to them.
 */
const emailAttachmentKey = (id: string) => `email-attachments/${id}`;

/** Storage ids are path segments, never paths: reject anything escapable. */
function assertEmailAttachmentId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error("email attachment storage id is malformed");
  }
}

export async function putEmailAttachmentBlob(id: string, bytes: Buffer, contentType: string): Promise<void> {
  assertEmailAttachmentId(id);
  await s3().send(new PutObjectCommand({
    Bucket: env.S3_BUCKET!,
    Key: emailAttachmentKey(id),
    Body: bytes,
    ContentType: contentType,
  }));
}

export async function getEmailAttachmentBlob(id: string): Promise<Buffer | null> {
  assertEmailAttachmentId(id);
  try {
    const result = await s3().send(new GetObjectCommand({
      Bucket: env.S3_BUCKET!,
      Key: emailAttachmentKey(id),
    }));
    if (!result.Body) return null;
    return Buffer.from(await result.Body.transformToByteArray());
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") return null;
    throw error;
  }
}

/** Best-effort: a failed delete must never fail a delivery. The worker
 *  deletes eagerly on terminal states; a blob orphaned by a crash between
 *  send and delete stays under the unlisted prefix until an operator clears
 *  it — it is never re-read, because only live job payloads reference ids. */
export async function deleteEmailAttachmentBlobs(ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      assertEmailAttachmentId(id);
      await s3().send(new DeleteObjectsCommand({
        Bucket: env.S3_BUCKET!,
        Delete: { Objects: [{ Key: emailAttachmentKey(id) }], Quiet: true },
      }));
    } catch (error) {
      console.error("[file-storage] email attachment cleanup failed (object orphaned):", (error as Error).message);
    }
  }
}

/**
 * Tombstone storage kind written onto cloned file/files_versions rows by a
 * masked sandbox clone INSTEAD of the production bytes (engine/src/sandbox).
 * It is not a readable location: every download path must refuse it by name
 * via refuseMaskedStorageKind below, so masked bytes can never be fetched.
 */
export const MASKED_STORAGE_KIND = "masked";

/** Named refusal for tombstoned (masked-clone) file content. Carries the
 * remedy in the message: the bytes were never copied, so nothing can be
 * "fixed" from inside the sandbox — re-upload or use an unmasked tier. */
export class MaskedFileContentError extends Error {
  readonly name = "MaskedFileContentError";
  readonly code = "masked_content_unavailable";

  constructor() {
    super(
      "file content is unavailable: masked sandboxes never receive production file bytes " +
        "(re-upload the file here, or clone an unmasked tier)",
    );
  }
}

/** Throw the named masked-content refusal when a version row carries the
 * tombstone kind. Call at every bytes-dispatch site (DB and S3 alike) BEFORE
 * attempting the read, so a tombstoned row can never fall through to a
 * bytea/S3 fetch. */
export function refuseMaskedStorageKind(storageKind: string | null | undefined): void {
  if (storageKind === MASKED_STORAGE_KIND) throw new MaskedFileContentError();
}

/**
 * Identify the masked-content refusal across module-graph boundaries: the
 * web layer may instantiate the engine through both the workspace alias and
 * a relative import (see engine/src/platform/db.ts), which defeats
 * instanceof — so match the stable error name as well.
 */
export function isMaskedFileContentError(err: unknown): boolean {
  return err instanceof MaskedFileContentError
    || (err as { name?: string } | null | undefined)?.name === "MaskedFileContentError";
}

export async function deleteS3Blobs(versionIds: string[]): Promise<void> {
  await activeStore().deleteObjects(versionIds);
}
