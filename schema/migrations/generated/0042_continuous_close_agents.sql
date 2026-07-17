CREATE TABLE "ai_agent_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"automatic_runs" boolean DEFAULT false NOT NULL,
	"cadence" text DEFAULT 'daily' NOT NULL,
	"materiality_threshold" numeric(19,4) DEFAULT '1000' NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_key" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"detector_version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"initiated_by" uuid,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "ai_work_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_key" text NOT NULL,
	"finding_type" text NOT NULL,
	"detector_version" text NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"confidence" numeric(19,4) DEFAULT '1' NOT NULL,
	"materiality" numeric(19,4) DEFAULT '0' NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_detected_run_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" uuid,
	"dismissal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_work_item_evidence" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_work_item_feedback" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_agent_policies_org_agent" ON "ai_agent_policies" USING btree ("org_id","agent_key");
--> statement-breakpoint
CREATE INDEX "ai_agent_policies_due" ON "ai_agent_policies" USING btree ("enabled","automatic_runs","next_run_at");
--> statement-breakpoint
CREATE INDEX "ai_agent_runs_org_started" ON "ai_agent_runs" USING btree ("org_id","started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_work_items_org_fingerprint" ON "ai_work_items" USING btree ("org_id","agent_key","fingerprint");
--> statement-breakpoint
CREATE INDEX "ai_work_items_org_status_seen" ON "ai_work_items" USING btree ("org_id","status","last_detected_at");
--> statement-breakpoint
CREATE INDEX "ai_work_items_agent_status" ON "ai_work_items" USING btree ("org_id","agent_key","status");
--> statement-breakpoint
CREATE INDEX "ai_work_item_evidence_item" ON "ai_work_item_evidence" USING btree ("work_item_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_work_item_feedback_user" ON "ai_work_item_feedback" USING btree ("work_item_id","user_id");
--> statement-breakpoint
CREATE INDEX "ai_work_item_feedback_org" ON "ai_work_item_feedback" USING btree ("org_id","created_at");
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ai_agent_policies','ai_agent_runs','ai_work_items','ai_work_item_evidence','ai_work_item_feedback'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (current_setting(''app.bypass_rls'', true) = ''on'' OR org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid) WITH CHECK (current_setting(''app.bypass_rls'', true) = ''on'' OR org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE ai_agent_policies ADD CONSTRAINT ai_agent_policies_agent_key_check CHECK (agent_key IN ('accounting','finance'));
ALTER TABLE ai_agent_policies ADD CONSTRAINT ai_agent_policies_cadence_check CHECK (cadence IN ('daily','weekly'));
ALTER TABLE ai_agent_policies ADD CONSTRAINT ai_agent_policies_materiality_check CHECK (materiality_threshold >= 0);
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_agent_key_check CHECK (agent_key IN ('accounting','finance'));
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_trigger_check CHECK (trigger IN ('manual','scheduler'));
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_status_check CHECK (status IN ('running','completed','failed','skipped'));
ALTER TABLE ai_work_items ADD CONSTRAINT ai_work_items_agent_key_check CHECK (agent_key IN ('accounting','finance'));
ALTER TABLE ai_work_items ADD CONSTRAINT ai_work_items_severity_check CHECK (severity IN ('info','warning','critical'));
ALTER TABLE ai_work_items ADD CONSTRAINT ai_work_items_status_check CHECK (status IN ('open','in_review','resolved','dismissed'));
ALTER TABLE ai_work_items ADD CONSTRAINT ai_work_items_confidence_check CHECK (confidence >= 0 AND confidence <= 1);
ALTER TABLE ai_work_items ADD CONSTRAINT ai_work_items_materiality_check CHECK (materiality >= 0);
ALTER TABLE ai_work_item_feedback ADD CONSTRAINT ai_work_item_feedback_rating_check CHECK (rating IN ('helpful','not_helpful'));
--> statement-breakpoint
GRANT SELECT ON ai_agent_policies, ai_agent_runs, ai_work_items, ai_work_item_evidence, ai_work_item_feedback TO openbooks_read;
