ALTER TABLE "document_lines" ADD COLUMN IF NOT EXISTS "tax_overridden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" text;