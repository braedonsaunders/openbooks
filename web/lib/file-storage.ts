import 'server-only'

export {
  activeStorageKind,
  deleteS3Blobs,
  getS3Blob,
  isMaskedFileContentError,
  MASKED_STORAGE_KIND,
  MaskedFileContentError,
  putS3Blob,
  refuseMaskedStorageKind,
  s3Enabled,
  emailAttachmentObjectKey,
  emailAttachmentsKeyPrefix,
  fileCabinetKeyPrefix,
  fileCabinetObjectKey,
} from '@openbooks/engine/src/platform/file-storage.ts'
export {
  enqueueStorageCleanup,
  enqueueStorageCleanupStandalone,
  type StorageCleanupIntent,
  type StorageCleanupOwnerKind,
} from '@openbooks/engine/src/platform/storage-cleanup.ts'
