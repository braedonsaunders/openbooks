CREATE TABLE "report_definitions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text DEFAULT 'custom' NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"query" jsonb NOT NULL,
	"layout" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"schedule_id" uuid,
	"definition_id" uuid NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"row_count" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result_csv" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"cadence" text NOT NULL,
	"day_of_week" integer,
	"day_of_month" integer,
	"hour" integer DEFAULT 7 NOT NULL,
	"minute" integer DEFAULT 0 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"recipient_emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"filters" jsonb,
	"next_run_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "report_definitions_org_slug" ON "report_definitions" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "report_definitions_org_kind" ON "report_definitions" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "report_runs_definition" ON "report_runs" USING btree ("definition_id","created_at");--> statement-breakpoint
CREATE INDEX "report_runs_schedule" ON "report_runs" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "report_runs_org_status" ON "report_runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "report_schedules_definition" ON "report_schedules" USING btree ("definition_id");--> statement-breakpoint
CREATE INDEX "report_schedules_due" ON "report_schedules" USING btree ("active","next_run_at");--> statement-breakpoint
CREATE INDEX "report_schedules_org" ON "report_schedules" USING btree ("org_id");