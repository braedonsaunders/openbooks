CREATE TABLE "flow_gates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"title" text NOT NULL,
	"assignee_user_id" uuid,
	"assignee_role" text,
	"group_key" text NOT NULL,
	"quorum" text DEFAULT 'any' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"signature_required" boolean DEFAULT false NOT NULL,
	"comment" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"remind_at" timestamp with time zone,
	"escalate_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "flow_run_effects" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"effect_key" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "flow_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text DEFAULT 'Flow' NOT NULL,
	"description" text,
	"subject_kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"graph" jsonb NOT NULL,
	"last_scheduled_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'general' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_gates_run_node_assignee" ON "flow_gates" USING btree ("run_id","node_id","assignee_user_id");--> statement-breakpoint
CREATE INDEX "flow_gates_assignee" ON "flow_gates" USING btree ("org_id","status","assignee_user_id");--> statement-breakpoint
CREATE INDEX "flow_gates_subject" ON "flow_gates" USING btree ("org_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "flow_gates_remind" ON "flow_gates" USING btree ("org_id","status","remind_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_run_effects_run_effect" ON "flow_run_effects" USING btree ("run_id","effect_key");--> statement-breakpoint
CREATE INDEX "flow_runs_org_flow" ON "flow_runs" USING btree ("org_id","flow_id");--> statement-breakpoint
CREATE INDEX "flow_runs_subject" ON "flow_runs" USING btree ("org_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "flow_runs_status" ON "flow_runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "flows_org_subject" ON "flows" USING btree ("org_id","subject_kind","enabled");--> statement-breakpoint
CREATE INDEX "notifications_user_inbox" ON "notifications" USING btree ("org_id","user_id","read_at");--> statement-breakpoint
CREATE INDEX "notifications_user_created" ON "notifications" USING btree ("user_id","created_at");