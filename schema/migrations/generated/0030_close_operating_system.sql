set local app.bypass_rls = 'on';
--> statement-breakpoint
CREATE TABLE "fiscal_calendars" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cadence" text DEFAULT 'monthly' NOT NULL,
	"year_start_month" integer DEFAULT 1 NOT NULL,
	"week_starts_on" integer DEFAULT 1 NOT NULL,
	"anchor_date" date,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"adjustment_period_enabled" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "fiscal_calendars_month_check" CHECK ("year_start_month" between 1 and 12),
	CONSTRAINT "fiscal_calendars_week_check" CHECK ("week_starts_on" between 0 and 6),
	CONSTRAINT "fiscal_calendars_cadence_check" CHECK ("cadence" in ('monthly','four_four_five','four_five_four','five_four_four','thirteen_period','custom'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_calendars_org_name" ON "fiscal_calendars" USING btree ("org_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_calendars_one_default" ON "fiscal_calendars" USING btree ("org_id") WHERE "is_default";
--> statement-breakpoint
CREATE INDEX "fiscal_calendars_org_active" ON "fiscal_calendars" USING btree ("org_id","is_active");
--> statement-breakpoint
INSERT INTO fiscal_calendars
  (org_id, name, cadence, year_start_month, time_zone, is_default, is_active)
SELECT id, 'close.defaultData.calendar.name', 'monthly',
       coalesce((settings->>'fiscalYearStartMonth')::integer, 1),
       coalesce(settings->>'timeZone', 'UTC'), true, true
  FROM orgs;
--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD COLUMN "fiscal_calendar_id" uuid;
--> statement-breakpoint
UPDATE accounting_periods p
   SET fiscal_calendar_id = c.id
  FROM fiscal_calendars c
 WHERE c.org_id = p.org_id AND c.is_default;
--> statement-breakpoint
ALTER TABLE "accounting_periods" ALTER COLUMN "fiscal_calendar_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "periods_org_year_num";
--> statement-breakpoint
CREATE UNIQUE INDEX "periods_calendar_year_num" ON "accounting_periods" USING btree ("org_id","fiscal_calendar_id","fiscal_year","period_number");
--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_date_check" CHECK ("starts_on" <= "ends_on");
--> statement-breakpoint
CREATE TABLE "period_locks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"subsidiary_id" uuid,
	"module" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"reason" text,
	"reopen_expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "period_locks_module_check" CHECK ("module" in ('ar','ap','banking','assets','tax','gl')),
	CONSTRAINT "period_locks_state_check" CHECK ("state" in ('open','soft_closed','closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "period_locks_scope" ON "period_locks" ("org_id","period_id","book_id","subsidiary_id","module") NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX "period_locks_lookup" ON "period_locks" USING btree ("org_id","period_id","book_id","module","subsidiary_id");
--> statement-breakpoint
INSERT INTO period_locks
  (org_id, period_id, book_id, module, state, locked_at, created_at, updated_at)
SELECT p.org_id, p.id, b.id, m.module,
       CASE m.module
         WHEN 'ar' THEN CASE WHEN p.ar_closed_at IS NULL THEN 'open' ELSE 'closed' END
         WHEN 'ap' THEN CASE WHEN p.ap_closed_at IS NULL THEN 'open' ELSE 'closed' END
         WHEN 'gl' THEN CASE WHEN p.gl_closed_at IS NULL THEN 'open' ELSE 'closed' END
         ELSE 'open'
       END,
       CASE m.module WHEN 'ar' THEN p.ar_closed_at WHEN 'ap' THEN p.ap_closed_at WHEN 'gl' THEN p.gl_closed_at END,
       now(), now()
  FROM accounting_periods p
  JOIN accounting_books b ON b.org_id = p.org_id AND b.is_active
 CROSS JOIN (VALUES ('ar'), ('ap'), ('banking'), ('assets'), ('tax'), ('gl')) AS m(module);
--> statement-breakpoint
ALTER TABLE "accounting_periods" DROP COLUMN "ar_closed_at";
--> statement-breakpoint
ALTER TABLE "accounting_periods" DROP COLUMN "ap_closed_at";
--> statement-breakpoint
ALTER TABLE "accounting_periods" DROP COLUMN "gl_closed_at";
--> statement-breakpoint
CREATE TABLE "close_blueprints" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"period_type" text DEFAULT 'any' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"scope_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "close_blueprints_period_type_check" CHECK ("period_type" in ('month','quarter','year','adjustment','any'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "close_blueprints_org_name_version" ON "close_blueprints" USING btree ("org_id","name","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "close_blueprints_one_default" ON "close_blueprints" USING btree ("org_id") WHERE "is_default" AND "is_active";
--> statement-breakpoint
CREATE TABLE "close_blueprint_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"blueprint_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"workstream" text NOT NULL,
	"task_type" text DEFAULT 'action' NOT NULL,
	"completion_mode" text DEFAULT 'manual' NOT NULL,
	"gate_type" text DEFAULT 'none' NOT NULL,
	"due_offset_business_days" integer DEFAULT 0 NOT NULL,
	"evidence_required" boolean DEFAULT false NOT NULL,
	"default_owner_role_key" text,
	"default_reviewer_role_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"applicability" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "close_blueprint_steps_key" ON "close_blueprint_steps" USING btree ("blueprint_id","key");
--> statement-breakpoint
CREATE INDEX "close_blueprint_steps_order" ON "close_blueprint_steps" USING btree ("blueprint_id","sort_order");
--> statement-breakpoint
CREATE TABLE "close_blueprint_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"blueprint_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"depends_on_step_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "close_blueprint_dependencies_not_self" CHECK ("step_id" <> "depends_on_step_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "close_blueprint_dependency_unique" ON "close_blueprint_dependencies" USING btree ("step_id","depends_on_step_id");
--> statement-breakpoint
CREATE INDEX "close_blueprint_dependencies_blueprint" ON "close_blueprint_dependencies" USING btree ("blueprint_id");
--> statement-breakpoint
CREATE TABLE "close_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"policy_type" text NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "close_policies_org_code" ON "close_policies" USING btree ("org_id","code");
--> statement-breakpoint
CREATE TABLE "close_automation_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"action" text NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "close_automation_org_trigger" ON "close_automation_rules" USING btree ("org_id","trigger","is_active");
--> statement-breakpoint
CREATE TABLE "close_automation_executions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"task_id" uuid,
	"trigger" text NOT NULL,
	"event_key" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "close_automation_executions_status_check" CHECK ("status" in ('running','completed','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "close_automation_execution_once" ON "close_automation_executions" USING btree ("rule_id","event_key");
--> statement-breakpoint
CREATE INDEX "close_automation_executions_run" ON "close_automation_executions" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE TABLE "close_reporting_packages" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"reports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delivery" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "close_reporting_packages_org_name" ON "close_reporting_packages" USING btree ("org_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "close_reporting_packages_one_default" ON "close_reporting_packages" USING btree ("org_id") WHERE "is_default" AND "is_active";
--> statement-breakpoint
CREATE TABLE "close_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"blueprint_id" uuid NOT NULL,
	"reporting_package_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_stage" text DEFAULT 'scope' NOT NULL,
	"target_close_date" date NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"readiness_score" integer DEFAULT 0 NOT NULL,
	"data_fingerprint" text,
	"last_validated_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"started_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"binder_snapshot" jsonb,
	"binder_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "close_runs_readiness_check" CHECK ("readiness_score" between 0 and 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "close_runs_period_book" ON "close_runs" USING btree ("org_id","period_id","book_id");
--> statement-breakpoint
CREATE INDEX "close_runs_org_status" ON "close_runs" USING btree ("org_id","status","target_close_date");
--> statement-breakpoint
CREATE TABLE "close_run_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"blueprint_step_id" uuid,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"workstream" text NOT NULL,
	"task_type" text NOT NULL,
	"completion_mode" text NOT NULL,
	"gate_type" text NOT NULL,
	"status" text DEFAULT 'blocked' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"owner_id" uuid,
	"reviewer_id" uuid,
	"due_on" date,
	"evidence_required" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"data_fingerprint" text,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "close_run_tasks_key" ON "close_run_tasks" USING btree ("run_id","key");
--> statement-breakpoint
CREATE INDEX "close_run_tasks_worklist" ON "close_run_tasks" USING btree ("org_id","owner_id","status","due_on");
--> statement-breakpoint
CREATE INDEX "close_run_tasks_run_order" ON "close_run_tasks" USING btree ("run_id","sort_order");
--> statement-breakpoint
CREATE TABLE "close_task_evidence" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"file_id" uuid,
	"evidence_type" text NOT NULL,
	"reference_id" uuid,
	"reference_url" text,
	"label" text NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "close_task_evidence_task" ON "close_task_evidence" USING btree ("task_id","created_at");
--> statement-breakpoint
CREATE TABLE "close_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"task_id" uuid,
	"code" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"source" text DEFAULT 'system' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "close_exceptions_run_code" ON "close_exceptions" USING btree ("run_id","code");
--> statement-breakpoint
CREATE INDEX "close_exceptions_run_status" ON "close_exceptions" USING btree ("run_id","status","severity");
--> statement-breakpoint
CREATE TABLE "close_signoffs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"task_id" uuid,
	"signoff_type" text NOT NULL,
	"decision" text NOT NULL,
	"comment" text,
	"data_fingerprint" text,
	"signed_by" uuid NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "close_signoffs_run" ON "close_signoffs" USING btree ("run_id","signed_at");
--> statement-breakpoint
CREATE TABLE "close_reopen_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"subsidiary_id" uuid,
	"modules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"impact_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"reclosed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "close_reopen_requests_status" ON "close_reopen_requests" USING btree ("org_id","status","created_at");
--> statement-breakpoint
CREATE TABLE "close_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid,
	"task_id" uuid,
	"event_type" text NOT NULL,
	"actor_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "close_events_run_at" ON "close_events" USING btree ("run_id","at");
--> statement-breakpoint
ALTER TABLE accounting_periods
  ADD FOREIGN KEY (fiscal_calendar_id) REFERENCES fiscal_calendars(id);
ALTER TABLE fiscal_calendars ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE;
ALTER TABLE period_locks
  ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (period_id) REFERENCES accounting_periods(id),
  ADD FOREIGN KEY (book_id) REFERENCES accounting_books(id),
  ADD FOREIGN KEY (subsidiary_id) REFERENCES subsidiaries(id),
  ADD FOREIGN KEY (locked_by) REFERENCES users(id);
ALTER TABLE close_blueprints ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE;
ALTER TABLE close_blueprint_steps
  ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (blueprint_id) REFERENCES close_blueprints(id) ON DELETE CASCADE;
ALTER TABLE close_blueprint_dependencies
  ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (blueprint_id) REFERENCES close_blueprints(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (step_id) REFERENCES close_blueprint_steps(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (depends_on_step_id) REFERENCES close_blueprint_steps(id) ON DELETE CASCADE;
ALTER TABLE close_policies ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE;
ALTER TABLE close_automation_rules ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE;
ALTER TABLE close_automation_executions
  ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (rule_id) REFERENCES close_automation_rules(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (run_id) REFERENCES close_runs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (task_id) REFERENCES close_run_tasks(id) ON DELETE SET NULL;
ALTER TABLE close_reporting_packages ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE;
ALTER TABLE close_runs
  ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (period_id) REFERENCES accounting_periods(id),
  ADD FOREIGN KEY (book_id) REFERENCES accounting_books(id),
  ADD FOREIGN KEY (blueprint_id) REFERENCES close_blueprints(id),
  ADD FOREIGN KEY (reporting_package_id) REFERENCES close_reporting_packages(id),
  ADD FOREIGN KEY (started_by) REFERENCES users(id),
  ADD FOREIGN KEY (approved_by) REFERENCES users(id),
  ADD FOREIGN KEY (closed_by) REFERENCES users(id),
  ADD FOREIGN KEY (published_by) REFERENCES users(id);
ALTER TABLE close_run_tasks
  ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (run_id) REFERENCES close_runs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (blueprint_step_id) REFERENCES close_blueprint_steps(id),
  ADD FOREIGN KEY (owner_id) REFERENCES users(id),
  ADD FOREIGN KEY (reviewer_id) REFERENCES users(id),
  ADD FOREIGN KEY (completed_by) REFERENCES users(id),
  ADD FOREIGN KEY (reviewed_by) REFERENCES users(id);
ALTER TABLE close_task_evidence
  ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (run_id) REFERENCES close_runs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (task_id) REFERENCES close_run_tasks(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (file_id) REFERENCES files(id);
ALTER TABLE close_exceptions
  ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (run_id) REFERENCES close_runs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (task_id) REFERENCES close_run_tasks(id),
  ADD FOREIGN KEY (resolved_by) REFERENCES users(id);
ALTER TABLE close_signoffs
  ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (run_id) REFERENCES close_runs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (task_id) REFERENCES close_run_tasks(id),
  ADD FOREIGN KEY (signed_by) REFERENCES users(id);
ALTER TABLE close_reopen_requests
  ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (period_id) REFERENCES accounting_periods(id),
  ADD FOREIGN KEY (book_id) REFERENCES accounting_books(id),
  ADD FOREIGN KEY (subsidiary_id) REFERENCES subsidiaries(id),
  ADD FOREIGN KEY (requested_by) REFERENCES users(id),
  ADD FOREIGN KEY (approved_by) REFERENCES users(id);
ALTER TABLE close_events
  ADD FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (run_id) REFERENCES close_runs(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (task_id) REFERENCES close_run_tasks(id),
  ADD FOREIGN KEY (actor_id) REFERENCES users(id);
--> statement-breakpoint
DO $$
DECLARE close_table text;
BEGIN
  FOREACH close_table IN ARRAY ARRAY[
    'fiscal_calendars','period_locks','close_blueprints','close_blueprint_steps',
    'close_blueprint_dependencies','close_policies','close_automation_rules','close_automation_executions',
    'close_reporting_packages','close_runs','close_run_tasks','close_task_evidence',
    'close_exceptions','close_signoffs','close_reopen_requests','close_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', close_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', close_table);
    EXECUTE format($policy$
      CREATE POLICY org_isolation ON %I
        USING (current_setting('app.bypass_rls', true) = 'on'
               OR org_id::text = current_setting('app.current_org', true))
        WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
               OR org_id::text = current_setting('app.current_org', true))
    $policy$, close_table);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION close_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER close_events_append_only BEFORE UPDATE OR DELETE ON close_events
FOR EACH ROW EXECUTE FUNCTION close_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER close_signoffs_append_only BEFORE UPDATE OR DELETE ON close_signoffs
FOR EACH ROW EXECUTE FUNCTION close_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER close_evidence_append_only BEFORE UPDATE OR DELETE ON close_task_evidence
FOR EACH ROW EXECUTE FUNCTION close_append_only_guard();
--> statement-breakpoint
GRANT SELECT ON fiscal_calendars, period_locks, close_blueprints,
  close_blueprint_steps, close_blueprint_dependencies, close_policies,
  close_automation_rules, close_automation_executions, close_reporting_packages, close_runs,
  close_run_tasks, close_task_evidence, close_exceptions, close_signoffs,
  close_reopen_requests, close_events TO openbooks_read;
