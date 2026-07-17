CREATE TABLE "ap_capture_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"original_filename" text NOT NULL,
	"content_hash" text NOT NULL,
	"document_kind" text DEFAULT 'vendor_bill' NOT NULL,
	"normalized" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overall_confidence" numeric(5, 4),
	"vendor_candidate_id" uuid,
	"purchase_order_id" uuid,
	"document_id" uuid,
	"assigned_to" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"materialized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "ap_capture_items_status_check" CHECK ("status" IN ('queued','extracting','needs_review','ready','duplicate','failed','materialized','rejected')),
	CONSTRAINT "ap_capture_items_source_check" CHECK ("source" = 'upload'),
	CONSTRAINT "ap_capture_items_kind_check" CHECK ("document_kind" IN ('vendor_bill','vendor_credit')),
	CONSTRAINT "ap_capture_items_confidence_check" CHECK ("overall_confidence" IS NULL OR ("overall_confidence" >= 0 AND "overall_confidence" <= 1)),
	CONSTRAINT "ap_capture_items_normalized_object_check" CHECK (jsonb_typeof("normalized") = 'object'),
	CONSTRAINT "ap_capture_items_issues_array_check" CHECK (jsonb_typeof("validation_issues") = 'array')
);
--> statement-breakpoint
CREATE TABLE "ap_capture_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"capture_item_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"api_version" text,
	"status" text DEFAULT 'running' NOT NULL,
	"raw_provider_payload" jsonb,
	"normalized_snapshot" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_by" uuid,
	CONSTRAINT "ap_capture_runs_status_check" CHECK ("status" IN ('running','succeeded','failed')),
	CONSTRAINT "ap_capture_runs_finished_check" CHECK (("status" = 'running' AND "finished_at" IS NULL) OR ("status" <> 'running' AND "finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ap_capture_fields" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"line_index" integer,
	"raw_value" text,
	"normalized_value" jsonb,
	"confidence" numeric(5, 4),
	"page_number" integer,
	"polygon" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ap_capture_fields_confidence_check" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
	CONSTRAINT "ap_capture_fields_page_check" CHECK ("page_number" IS NULL OR "page_number" > 0),
	CONSTRAINT "ap_capture_fields_line_check" CHECK ("line_index" IS NULL OR "line_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ap_capture_corrections" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"capture_item_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"line_index" integer,
	"before_value" jsonb,
	"after_value" jsonb,
	"corrected_by" uuid NOT NULL,
	"corrected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ap_capture_corrections_line_check" CHECK ("line_index" IS NULL OR "line_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ap_capture_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_kind" text NOT NULL,
	"match" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"confirmation_count" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "ap_capture_rules_kind_check" CHECK ("rule_kind" IN ('vendor_alias','vendor_account','field_mapping')),
	CONSTRAINT "ap_capture_rules_confirmations_check" CHECK ("confirmation_count" > 0),
	CONSTRAINT "ap_capture_rules_json_check" CHECK (jsonb_typeof("match") = 'object' AND jsonb_typeof("output") = 'object')
);
--> statement-breakpoint
CREATE TABLE "ap_capture_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"capture_item_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ap_capture_events_detail_check" CHECK (jsonb_typeof("detail") = 'object')
);
--> statement-breakpoint
CREATE INDEX "ap_capture_items_queue" ON "ap_capture_items" USING btree ("org_id","status","received_at");
CREATE INDEX "ap_capture_items_hash" ON "ap_capture_items" USING btree ("org_id","content_hash");
CREATE INDEX "ap_capture_items_vendor" ON "ap_capture_items" USING btree ("org_id","vendor_candidate_id");
CREATE UNIQUE INDEX "ap_capture_items_document" ON "ap_capture_items" USING btree ("document_id") WHERE "document_id" IS NOT NULL;
CREATE UNIQUE INDEX "ap_capture_runs_attempt" ON "ap_capture_runs" USING btree ("capture_item_id","attempt");
CREATE INDEX "ap_capture_runs_org_started" ON "ap_capture_runs" USING btree ("org_id","started_at");
CREATE INDEX "ap_capture_fields_run" ON "ap_capture_fields" USING btree ("run_id","field_key","line_index");
CREATE INDEX "ap_capture_corrections_item" ON "ap_capture_corrections" USING btree ("capture_item_id","corrected_at");
CREATE INDEX "ap_capture_rules_lookup" ON "ap_capture_rules" USING btree ("org_id","rule_kind","is_active");
CREATE UNIQUE INDEX "ap_capture_rules_identity" ON "ap_capture_rules" USING btree ("org_id","rule_kind","match","output");
CREATE INDEX "ap_capture_events_item" ON "ap_capture_events" USING btree ("capture_item_id","at");
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ap_capture_items','ap_capture_runs','ap_capture_fields','ap_capture_corrections','ap_capture_rules','ap_capture_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (current_setting(''app.bypass_rls'', true) = ''on'' OR org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid) WITH CHECK (current_setting(''app.bypass_rls'', true) = ''on'' OR org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION openbooks_guard_ap_capture_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AP capture evidence is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ap_capture_fields_append_only BEFORE UPDATE OR DELETE ON ap_capture_fields
FOR EACH ROW EXECUTE FUNCTION openbooks_guard_ap_capture_evidence();
CREATE TRIGGER ap_capture_corrections_append_only BEFORE UPDATE OR DELETE ON ap_capture_corrections
FOR EACH ROW EXECUTE FUNCTION openbooks_guard_ap_capture_evidence();
CREATE TRIGGER ap_capture_events_append_only BEFORE UPDATE OR DELETE ON ap_capture_events
FOR EACH ROW EXECUTE FUNCTION openbooks_guard_ap_capture_evidence();
--> statement-breakpoint
CREATE FUNCTION openbooks_guard_finished_ap_capture_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'running' THEN
    RAISE EXCEPTION 'Finished AP capture runs are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ap_capture_runs_immutable AFTER UPDATE OR DELETE ON ap_capture_runs
FOR EACH ROW EXECUTE FUNCTION openbooks_guard_finished_ap_capture_run();
--> statement-breakpoint
CREATE FUNCTION openbooks_guard_ap_capture_source_file() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ap_capture_items WHERE file_id = OLD.id) THEN
    RAISE EXCEPTION 'AP capture source files are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ap_capture_source_file_immutable BEFORE UPDATE OR DELETE ON files
FOR EACH ROW EXECUTE FUNCTION openbooks_guard_ap_capture_source_file();
--> statement-breakpoint
CREATE FUNCTION openbooks_guard_ap_capture_source_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_file_id uuid;
BEGIN
  target_file_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.file_id ELSE OLD.file_id END;
  IF EXISTS (SELECT 1 FROM ap_capture_items WHERE file_id = target_file_id) THEN
    RAISE EXCEPTION 'AP capture source versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ap_capture_source_version_immutable BEFORE INSERT OR UPDATE OR DELETE ON file_versions
FOR EACH ROW EXECUTE FUNCTION openbooks_guard_ap_capture_source_version();
--> statement-breakpoint
CREATE FUNCTION openbooks_guard_ap_capture_source_blob() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM file_versions fv
    JOIN ap_capture_items ci ON ci.file_id = fv.file_id
    WHERE fv.id = OLD.version_id
  ) THEN
    RAISE EXCEPTION 'AP capture source blobs are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ap_capture_source_blob_immutable BEFORE UPDATE OR DELETE ON file_blobs
FOR EACH ROW EXECUTE FUNCTION openbooks_guard_ap_capture_source_blob();
--> statement-breakpoint
GRANT SELECT ON ap_capture_items, ap_capture_runs, ap_capture_fields,
  ap_capture_corrections, ap_capture_rules, ap_capture_events TO openbooks_read;
