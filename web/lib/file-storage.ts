import 'server-only'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { env } from '@openbooks/engine/src/db.ts'

/**
 * File-cabinet blob storage driver. Two backends selected by environment:
 *
 *   - 'db'  (default): bytes live in the file_blobs table — zero-config local dev.
 *   - 's3'  : bytes live in an S3-compatible object store (MinIO in the dev
 *             deployment) under `file-cabinet/<versionId>`. Enabled when all
 *             four S3_* vars are set.
 *
 * The files/file_versions rows record which backend wrote each version in
 * their `storage_kind` column, so a deployment can switch backends without
 * migrating old blobs — reads dispatch per version.
 */

const S3_VARS = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'] as const

export const s3Enabled: boolean = S3_VARS.every((k) => !!env[k])

export function activeStorageKind(): 'db' | 's3' {
  return s3Enabled ? 's3' : 'db'
}

let client: S3Client | null = null
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
      // MinIO serves buckets on paths, not subdomains.
      forcePathStyle: true,
    })
  }
  return client
}

const objectKey = (versionId: string) => `file-cabinet/${versionId}`

export async function putS3Blob(versionId: string, bytes: Buffer, contentType: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET!,
      Key: objectKey(versionId),
      Body: bytes,
      ContentType: contentType,
    }),
  )
}

export async function getS3Blob(versionId: string): Promise<Buffer | null> {
  try {
    const res = await s3().send(
      new GetObjectCommand({ Bucket: env.S3_BUCKET!, Key: objectKey(versionId) }),
    )
    if (!res.Body) return null
    return Buffer.from(await res.Body.transformToByteArray())
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return null
    throw err
  }
}

/** Best-effort bulk delete — called after the DB rows are gone, so a failure
 *  only leaves unreferenced objects behind (never dangling metadata). */
export async function deleteS3Blobs(versionIds: string[]): Promise<void> {
  if (versionIds.length === 0) return
  for (let i = 0; i < versionIds.length; i += 1000) {
    const chunk = versionIds.slice(i, i + 1000)
    try {
      await s3().send(
        new DeleteObjectsCommand({
          Bucket: env.S3_BUCKET!,
          Delete: { Objects: chunk.map((id) => ({ Key: objectKey(id) })), Quiet: true },
        }),
      )
    } catch (err) {
      console.error('[file-storage] S3 blob cleanup failed (objects orphaned):', (err as Error).message)
    }
  }
}
