CREATE TABLE "ai_conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text DEFAULT 'assistant' NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "home_dashboard_id" uuid;--> statement-breakpoint
ALTER TABLE "insight_dashboards" ADD COLUMN "is_home" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "insight_dashboards" ADD COLUMN "home_for_role" text;--> statement-breakpoint
CREATE INDEX "ai_conversations_owner_scope" ON "ai_conversations" USING btree ("org_id","user_id","scope","updated_at");--> statement-breakpoint
CREATE INDEX "ai_messages_conversation" ON "ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "insight_dashboards_org_home" ON "insight_dashboards" USING btree ("org_id","is_home");--> statement-breakpoint
CREATE INDEX "insight_dashboards_org_role_home" ON "insight_dashboards" USING btree ("org_id","home_for_role");