CREATE TABLE "qbd_captures" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"since" timestamp with time zone,
	"captured_through" timestamp with time zone NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "qbd_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"family" text NOT NULL,
	"request_kind" text NOT NULL,
	"sequence" integer NOT NULL,
	"page" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"request_xml" text NOT NULL,
	"response_xml" text,
	"response_sha256" text,
	"session_id" uuid,
	"error_message" text,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "qbd_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"company_file" text,
	"country" text,
	"qbxml_major" integer,
	"qbxml_minor" integer,
	"last_error" text,
	"authenticated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "qbd_captures_connection" ON "qbd_captures" USING btree ("connection_id","created_at");
--> statement-breakpoint
CREATE INDEX "qbd_captures_expiry" ON "qbd_captures" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "qbd_requests_next" ON "qbd_requests" USING btree ("connection_id","status","sequence");
--> statement-breakpoint
CREATE INDEX "qbd_requests_capture" ON "qbd_requests" USING btree ("capture_id","family","page");
--> statement-breakpoint
CREATE UNIQUE INDEX "qbd_requests_capture_sequence" ON "qbd_requests" USING btree ("capture_id","sequence");
--> statement-breakpoint
CREATE INDEX "qbd_sessions_connection" ON "qbd_sessions" USING btree ("connection_id","authenticated_at");
--> statement-breakpoint
CREATE INDEX "qbd_sessions_expiry" ON "qbd_sessions" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "qbd_captures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "qbd_captures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "qbd_captures" USING (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true)) WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true));
--> statement-breakpoint
ALTER TABLE "qbd_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "qbd_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "qbd_requests" USING (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true)) WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true));
--> statement-breakpoint
ALTER TABLE "qbd_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "qbd_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "qbd_sessions" USING (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true)) WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true));
