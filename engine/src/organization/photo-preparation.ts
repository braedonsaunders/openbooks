import sharp from 'sharp'
import { MAX_PARTY_PHOTO_BYTES, PartyPhotoRefusal, partyPhotoContentType, rasterPhotoContentType } from './party-photos.ts'

export const MAX_SOURCE_PHOTO_BYTES = 25 * 1024 * 1024

/** Preserve normal source bytes; retain oversized originals alongside a bounded display image. */
export async function prepareConnectorPhoto(file: { filename: string; bytes: Buffer }) {
  if (file.bytes.length > MAX_SOURCE_PHOTO_BYTES) throw new PartyPhotoRefusal('The source image exceeds the 25 MB connector photo limit.', 413)
  rasterPhotoContentType(file.bytes)
  if (file.bytes.length <= MAX_PARTY_PHOTO_BYTES) return { ...file, contentType: partyPhotoContentType(file.bytes), original: undefined }
  const bytes = await sharp(file.bytes, { limitInputPixels: 40_000_000, sequentialRead: true, failOn: 'error' })
    .rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 }).toBuffer()
  return {
    filename: `${file.filename.replace(/\.[^.]+$/, '')}.photo.webp`, bytes,
    contentType: partyPhotoContentType(bytes), original: file,
  }
}
