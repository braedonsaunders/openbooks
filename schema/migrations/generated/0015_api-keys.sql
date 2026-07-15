-- api_keys + api_key_events — bearer/X-API-Key auth for the versioned REST API.
-- Keys are org-scoped, owned by a user, and carry scoped permission keys (the
-- same module.action catalogue roles use). The plaintext key (ob_live_…)
-- is shown once at creation; at rest we keep the SHA-256 hash + a 4-char
-- preview. Revocation is is_active = false (preserves the event-log FK).
-- FKs + grants are added by referential-integrity.sql + the apply step.

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "key_prefix" text NOT NULL,
  "key_hash" text NOT NULL,
  "key_preview" text NOT NULL,
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "expires_at" timestamptz,
  "last_used_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_hash" ON "api_keys" ("key_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_org" ON "api_keys" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_org_user" ON "api_keys" ("org_id","user_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "api_key_events" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "org_id" uuid NOT NULL,
  "key_id" uuid,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "status_code" integer NOT NULL,
  "duration_ms" integer NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_key_events_key" ON "api_key_events" ("key_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_key_events_org_created" ON "api_key_events" ("org_id","created_at");
