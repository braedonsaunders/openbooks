export const STORAGE_CLEANUP_OWNER_KINDS = [
  "file_version",
  "file_version_copy",
  "email_attachment",
] as const;

export type StorageCleanupOwnerKind = (typeof STORAGE_CLEANUP_OWNER_KINDS)[number];
