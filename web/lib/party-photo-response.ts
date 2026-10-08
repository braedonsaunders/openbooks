import { blobResponse } from './blob-response'

/** A photo URL follows the current pointer and cabinet version, so it must revalidate. */
export function partyPhotoResponse(request: Request, photo: {
  name: string; content_type: string; bytes: Buffer; version_id: string
}) {
  return blobResponse(request, {
    filename: photo.name, contentType: photo.content_type, bytes: photo.bytes, versionId: photo.version_id,
  }, { fallbackName: 'photo' })
}
