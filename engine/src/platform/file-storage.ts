import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
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

export async function putS3Blob(versionId: string, bytes: Buffer, contentType: string): Promise<void> {
  await s3().send(new PutObjectCommand({
    Bucket: env.S3_BUCKET!,
    Key: objectKey(versionId),
    Body: bytes,
    ContentType: contentType,
  }));
}

export async function getS3Blob(versionId: string): Promise<Buffer | null> {
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

export async function deleteS3Blobs(versionIds: string[]): Promise<void> {
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
}
