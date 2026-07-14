CREATE TABLE "attachment_blobs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"attachment_id" uuid NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"target_table" text NOT NULL,
	"target_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_kind" text DEFAULT 'db' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_blobs_attachment" ON "attachment_blobs" USING btree ("attachment_id");--> statement-breakpoint
CREATE INDEX "attachments_target" ON "attachments" USING btree ("org_id","target_table","target_id");