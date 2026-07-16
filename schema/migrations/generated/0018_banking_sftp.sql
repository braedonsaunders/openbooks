-- Banking SFTP subsystem: built-in SFTP servers (MinIO/local backed), the
-- shared daemon config, and scheduled inbound imports. Hand-authored (the
-- generator would have swept concurrent, unrelated schema changes); reconcile
-- the drizzle journal/snapshot when the concurrent migrations settle.

CREATE TABLE IF NOT EXISTS "sftp_daemon" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"port" integer DEFAULT 2222 NOT NULL,
	"host_key" text NOT NULL,
	"advertised_host" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sftp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"password_encrypted" text,
	"authorized_keys" text,
	"backend" text DEFAULT 's3' NOT NULL,
	"bucket" text,
	"root_prefix" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sftp_import_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sftp_server_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"format" text DEFAULT 'auto' NOT NULL,
	"folder" text DEFAULT 'inbound' NOT NULL,
	"csv_mapping" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sftp_servers_username" ON "sftp_servers" ("username");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sftp_servers_org_username" ON "sftp_servers" ("org_id","username");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sftp_import_schedules_active" ON "sftp_import_schedules" ("org_id","is_active");
