import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * File Cabinet — a NetSuite-class document management system.
 *
 * Cabinet-first: files exist independently in folders; attaching a file to a
 * record (transaction, party, etc.) is a *link*, not a container. This
 * inverts the old attachment-only model so files can be browsed, moved,
 * renamed, reused across records, and versioned — exactly like NetSuite's
 * File Cabinet, with one improvement: real append-only versioning (NetSuite
 * has none).
 *
 * Tables:
 *   - folders: hierarchical folder tree (system, private, shared, per-record)
 *   - files: standalone file metadata (lives in a folder, has versions)
 *   - file_versions: append-only versions (surpasses NetSuite)
 *   - file_blobs: raw bytes (fetched only on download)
 *   - file_attachments: polymorphic join between a file and any record
 *
 * When a user attaches a file to a record, a per-record folder is
 * auto-created under the system "Attachments" root so files are always
 * browsable from the File Cabinet, not just from the record.
 */

/**
 * Postgres `bytea` mapped to raw bytes. node-postgres already returns `bytea`
 * columns as a Buffer (a Uint8Array) and accepts Buffer/Uint8Array as bind
 * params, so this custom type is a straight passthrough that gives Drizzle the
 * right SQL type. Typed as `Uint8Array` (not `Buffer`) to keep the schema
 * package free of Node ambient types; Buffer is assignable at the call site.
 */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Hierarchical folder tree. Folders can be:
 *   - System folders (is_system = true): auto-created roots like "Attachments"
 *     and "User Documents". Cannot be deleted or renamed.
 *   - Record folders (record_table + record_id set): auto-created when a file
 *     is attached to a record. One folder per (org, record_table, record_id).
 *   - User folders: created by users in the File Cabinet UI.
 *   - Private folders (is_private = true): visible only to the owner + admins.
 */
export const folders = pgTable(
  "folders",
  {
    id: id(),
    orgId: orgRef(),
    parentFolderId: uuid("parent_folder_id"),
    name: text("name").notNull(),
    /** System folders are auto-created and cannot be deleted or renamed. */
    isSystem: boolean("is_system").notNull().default(false),
    /**
     * System folder kind: 'attachments' (root for record attachment folders),
     * 'user_documents' (per-user root), or 'ap_capture' (AP intake evidence).
     */
    systemKind: text("system_kind"),
    /** When set, this folder is the auto-created attachment folder for a
     * specific record. record_table + record_id identify the record. */
    recordTable: text("record_table"),
    recordId: uuid("record_id"),
    /** Private folders are visible only to the owner + admins. */
    isPrivate: boolean("is_private").notNull().default(false),
    ownerId: uuid("owner_id"),
    isInactive: boolean("is_inactive").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    index("folders_parent").on(t.orgId, t.parentFolderId),
    index("folders_org").on(t.orgId),
    index("folders_record").on(t.orgId, t.recordTable, t.recordId),
    // Main-pane child-folder listing ordered by name.
    index("folders_parent_name").on(t.orgId, t.parentFolderId, t.name),
  ],
);

/**
 * Standalone file metadata. A file lives in exactly one folder but can be
 * attached to many records via file_attachments. Versioning is append-only:
 * each upload/replace creates a new file_versions row and points
 * current_version_id at it.
 */
export const files = pgTable(
  "files",
  {
    id: id(),
    orgId: orgRef(),
    folderId: uuid("folder_id").notNull(),
    name: text("name").notNull(),
    /** File extension without the dot, e.g. 'pdf', 'xlsx'. */
    extension: text("extension"),
    /** Category derived from content type: pdf, image, spreadsheet, document,
     * csv, text, other. */
    fileType: text("file_type").notNull().default("other"),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Where the bytes live. 'db' = file_blobs; 's3' = S3-compatible object storage. */
    storageKind: text("storage_kind").notNull().default("db"),
    /** Stable upstream identity for idempotent source-system migrations. */
    sourceSystem: text("source_system"),
    sourceId: text("source_id"),
    /** SHA-256 hash of the bytes — change-tracking for text files. */
    contentHash: text("content_hash"),
    isInactive: boolean("is_inactive").notNull().default(false),
    /** Points to the current (latest) file_versions row. */
    currentVersionId: uuid("current_version_id"),
    ...auditColumns,
  },
  (t) => [
    index("files_folder").on(t.orgId, t.folderId),
    index("files_org").on(t.orgId),
    uniqueIndex("files_source_identity").on(t.orgId, t.sourceSystem, t.sourceId),
    // Folder-scoped listing ordered by the cabinet's default sorts.
    index("files_folder_name").on(t.orgId, t.folderId, t.name),
    index("files_folder_created").on(t.orgId, t.folderId, t.createdAt),
    // Leading-wildcard ILIKE name search (files.name ilike '%q%').
    index("files_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
  ],
);

/**
 * Append-only file versions. Each upload or replace creates a new row here;
 * the file's current_version_id points to the active version. This is where
 * openbooks surpasses NetSuite — its File Cabinet has no versioning at all.
 */
export const fileVersions = pgTable(
  "file_versions",
  {
    id: id(),
    fileId: uuid("file_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentType: text("content_type").notNull(),
    storageKind: text("storage_kind").notNull().default("db"),
    contentHash: text("content_hash"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("file_versions_file_version").on(t.fileId, t.versionNumber),
    index("file_versions_file").on(t.fileId),
  ],
);

/** Raw file bytes — fetched only on the download route. */
export const fileBlobs = pgTable(
  "file_blobs",
  {
    id: id(),
    versionId: uuid("version_id").notNull(),
    bytes: bytea("bytes").notNull(),
  },
  (t) => [uniqueIndex("file_blobs_version").on(t.versionId)],
);

/**
 * Polymorphic join between a file and any record (transactions, parties,
 * items, etc.). A file can be attached to many records; a record can have
 * many files. Detaching (deleting a row) does NOT delete the file — the file
 * remains in the cabinet.
 */
export const fileAttachments = pgTable(
  "file_attachments",
  {
    id: id(),
    orgId: orgRef(),
    fileId: uuid("file_id").notNull(),
    /** The kind of record this file is attached to, e.g. 'documents'. */
    targetTable: text("target_table").notNull(),
    /** The specific record's id within `target_table`. */
    targetId: uuid("target_id").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("file_attachments_target").on(t.orgId, t.targetTable, t.targetId),
    index("file_attachments_file").on(t.orgId, t.fileId),
    uniqueIndex("file_attachments_unique").on(t.orgId, t.fileId, t.targetTable, t.targetId),
  ],
);

/**
 * Access grants — per-folder / per-file sharing beyond the org-role baseline.
 *
 * A grant gives a principal (a specific user, or a role) an access tier on a
 * resource. Folder grants inherit to descendant folders and the files they
 * contain; file grants apply to that one file. Effective access is the highest
 * of: the `*` admin (Manager everywhere), the org-role baseline
 * (documents.manage → Manager, documents.read → Viewer), the private-folder
 * owner (Manager), and any applicable grant on the resource or its ancestors.
 *
 * Tiers (text, ordered): 'viewer' < 'editor' < 'manager'.
 *   - viewer:  read + download
 *   - editor:  + upload / rename / move / replace
 *   - manager: + delete + edit sharing
 *
 * Enforced in the query layer (like saved_views), never in RLS; RLS stays
 * org-isolation only.
 */
export const resourceGrants = pgTable(
  "resource_grants",
  {
    id: id(),
    orgId: orgRef(),
    /** 'folder' | 'file'. */
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    /** 'user' | 'role'. */
    principalType: text("principal_type").notNull(),
    /** users.id when principalType='user', app_roles.id when 'role'. */
    principalId: uuid("principal_id").notNull(),
    /** 'viewer' | 'editor' | 'manager'. */
    access: text("access").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("resource_grants_unique").on(
      t.orgId,
      t.resourceType,
      t.resourceId,
      t.principalType,
      t.principalId,
    ),
    index("resource_grants_resource").on(t.orgId, t.resourceType, t.resourceId),
    index("resource_grants_principal").on(t.orgId, t.principalType, t.principalId),
  ],
);

/*
 * Foreign keys (add to schema/migrations/referential-integrity.sql):
 *
 *   alter table folders add foreign key (org_id) references orgs(id);
 *   alter table folders add foreign key (parent_folder_id) references folders(id) on delete restrict;
 *   alter table files add foreign key (org_id) references orgs(id);
 *   alter table files add foreign key (folder_id) references folders(id) on delete restrict;
 *   alter table files add foreign key (current_version_id) references file_versions(id) on delete set null;
 *   alter table file_versions add foreign key (file_id) references files(id) on delete cascade;
 *   alter table file_blobs add foreign key (version_id) references file_versions(id) on delete cascade;
 *   alter table file_attachments add foreign key (org_id) references orgs(id);
 *   alter table file_attachments add foreign key (file_id) references files(id) on delete cascade;
 */
