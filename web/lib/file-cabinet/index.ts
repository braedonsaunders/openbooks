/** Cabinet-first document management, split into modules.
 *
 * This index re-exports the exact public API of the former web/lib/file-cabinet.ts,
 * so `@/lib/file-cabinet` keeps resolving with zero importer churn.
 */
import 'server-only'

export { titleizeKind } from './shared'
export { attachmentReadPermission, accessAtLeast } from './types'
export type { FileViewer, AccessLevel, FolderNode, FileMeta, FileDetail, FileVersion, FileAttachmentLink } from './types'
export { ownedFilePredicate, liveFilePredicate, fileReadPredicate, folderPathVisiblePredicate, folderAccessLevel, fileAccessLevel } from './visibility'
export type { ReadScope } from './visibility'
export { isAccessLevel, GrantScopeRefusal, cabinetResourceExists, listGrants, setGrant, removeGrant } from './grants'
export type { ResourceType, PrincipalType, GrantRow } from './grants'
export { ensureAttachmentsRoot, ensureApCaptureRoot, ensureRecordFolder } from './system-folders'
export { getFolderTree, getFolderPath, getFolder, createFolder, renameFolder, moveFolder, updateFolder, patchFolder, deleteFolder, restoreFolder, purgeFolder } from './folders'
export type { FolderPatch, FolderPatchResult } from './folders'
export { listTrash } from './trash'
export type { TrashItem } from './trash'
export { listFiles, listFolderContents, getFile, createFile, replaceFile, renameFile, moveFile, deleteFile, restoreFile, isRetainedFileEvidence, purgeFile, getFileBlob } from './files'
export type { ListFilesOptions, FolderContents, PurgeFileOutcome } from './files'
export type { FileMutationAudit } from './mutation'
export { listAttachments, uploadAndAttach, attachExisting, detachAttachment, getAttachmentLink } from './attachments'
export type { AttachedFile, AttachmentLink, DetachOutcome } from './attachments'
