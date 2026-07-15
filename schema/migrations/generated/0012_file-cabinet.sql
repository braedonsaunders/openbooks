-- File Cabinet — cabinet-first document management (replaces flat attachments).
-- Files exist independently in a folder tree; attachment is a link between a
-- file and a record. Versioning is append-only (surpasses NetSuite).

CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_folder_id" uuid,
	"name" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"system_kind" text,
	"record_table" text,
	"record_id" uuid,
	"is_private" boolean DEFAULT false NOT NULL,
	"owner_id" uuid,
	"is_inactive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"name" text NOT NULL,
	"extension" text,
	"file_type" text DEFAULT 'other' NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_kind" text DEFAULT 'db' NOT NULL,
	"content_hash" text,
	"is_inactive" boolean DEFAULT false NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "file_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"file_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"storage_kind" text DEFAULT 'db' NOT NULL,
	"content_hash" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_blobs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"version_id" uuid NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"target_table" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "folders_parent" ON "folders" USING btree ("org_id","parent_folder_id");--> statement-breakpoint
CREATE INDEX "folders_org" ON "folders" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "folders_record" ON "folders" USING btree ("org_id","record_table","record_id");--> statement-breakpoint
CREATE INDEX "files_folder" ON "files" USING btree ("org_id","folder_id");--> statement-breakpoint
CREATE INDEX "files_org" ON "files" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_versions_file_version" ON "file_versions" USING btree ("file_id","version_number");--> statement-breakpoint
CREATE INDEX "file_versions_file" ON "file_versions" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_blobs_version" ON "file_blobs" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "file_attachments_target" ON "file_attachments" USING btree ("org_id","target_table","target_id");--> statement-breakpoint
CREATE INDEX "file_attachments_file" ON "file_attachments" USING btree ("org_id","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_attachments_unique" ON "file_attachments" USING btree ("org_id","file_id","target_table","target_id");--> statement-breakpoint

-- Migrate existing attachment data into the cabinet-first model. For each
-- attachment: create a system "Attachments" root folder per org (if missing),
-- a per-record subfolder (if missing), then a file + version + blob +
-- file_attachments link preserving the original created_at / created_by.
DO $$
DECLARE
  att RECORD;
  root_folder uuid;
  record_folder uuid;
  new_file uuid;
  new_version uuid;
BEGIN
  FOR att IN SELECT * FROM attachments LOOP
    -- Find or create the system "Attachments" root folder for this org
    SELECT id INTO root_folder FROM folders
      WHERE org_id = att.org_id AND system_kind = 'attachments';
    IF root_folder IS NULL THEN
      INSERT INTO folders (id, org_id, name, is_system, system_kind, created_at, updated_at)
        VALUES (uuid_generate_v7(), att.org_id, 'Attachments', true, 'attachments', now(), now())
        RETURNING id INTO root_folder;
    END IF;

    -- Find or create the per-record folder
    SELECT id INTO record_folder FROM folders
      WHERE org_id = att.org_id AND record_table = att.target_table AND record_id = att.target_id;
    IF record_folder IS NULL THEN
      INSERT INTO folders (id, org_id, parent_folder_id, name, is_system, record_table, record_id, created_at, updated_at)
        VALUES (uuid_generate_v7(), att.org_id, root_folder,
                att.target_table || ' / ' || left(att.target_id::text, 8),
                true, att.target_table, att.target_id, now(), now())
        RETURNING id INTO record_folder;
    END IF;

    -- Create the file (current_version_id set after the version is inserted)
    INSERT INTO files (id, org_id, folder_id, name, extension, file_type, content_type,
                       size_bytes, storage_kind, created_at, created_by, updated_at, updated_by)
      VALUES (uuid_generate_v7(), att.org_id, record_folder, att.filename,
        CASE WHEN position('.' in att.filename) > 0
             THEN lower(substring(att.filename from position('.' in att.filename) + 1))
             ELSE NULL END,
        CASE
          WHEN att.content_type = 'application/pdf' THEN 'pdf'
          WHEN att.content_type LIKE 'image/%' THEN 'image'
          WHEN att.content_type = 'text/csv' THEN 'csv'
          WHEN att.content_type LIKE '%spreadsheet%' THEN 'spreadsheet'
          WHEN att.content_type LIKE '%wordprocessing%' THEN 'document'
          WHEN att.content_type LIKE 'text/%' THEN 'text'
          ELSE 'other' END,
        att.content_type, att.size_bytes, 'db', att.created_at, att.created_by,
        att.created_at, att.created_by)
      RETURNING id INTO new_file;

    -- Create the initial version
    INSERT INTO file_versions (id, file_id, version_number, size_bytes, content_type,
                               storage_kind, created_at, created_by)
      VALUES (uuid_generate_v7(), new_file, 1, att.size_bytes, att.content_type, 'db',
              att.created_at, att.created_by)
      RETURNING id INTO new_version;

    -- Link the file to its current version
    UPDATE files SET current_version_id = new_version WHERE id = new_file;

    -- Copy the blob bytes
    INSERT INTO file_blobs (version_id, bytes)
      SELECT new_version, ab.bytes FROM attachment_blobs ab WHERE ab.attachment_id = att.id;

    -- Create the attachment link
    INSERT INTO file_attachments (id, org_id, file_id, target_table, target_id, created_at, created_by)
      VALUES (uuid_generate_v7(), att.org_id, new_file, att.target_table, att.target_id,
              att.created_at, att.created_by);
  END LOOP;
END $$;
--> statement-breakpoint

-- Drop the old attachment tables (data has been migrated above)
DROP TABLE "attachment_blobs";--> statement-breakpoint
DROP TABLE "attachments";

-- Post-migration: grant select on new tables to the read-only role
-- grant select on folders, files, file_versions, file_blobs, file_attachments to openbooks_read;
