import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
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
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true,
  });
  return client;
}

const objectKey = (versionId: string) => `file-cabinet/${versionId}`;

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
