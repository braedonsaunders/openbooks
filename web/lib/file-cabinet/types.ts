import "server-only";

export type FolderNode = {
  id: string;
  name: string;
  parentId: string | null;
  isSystem: boolean;
  systemKind: string | null;
  isPrivate: boolean;
  isInactive: boolean;
  recordTable: string | null;
  recordId: string | null;
  childCount: number;
  fileCount: number;
};

export type FileMeta = import("@openbooks/engine/platform/file-ingestion").FileMeta;

export interface FileDetail extends FileMeta {
  versions: FileVersion[];
  attachments: FileAttachmentLink[];
}

export interface FileVersion {
  id: string;
  versionNumber: number;
  sizeBytes: number;
  contentType: string;
  contentHash: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface FileAttachmentLink {
  id: string;
  targetTable: string;
  targetId: string;
  createdAt: string;
}
