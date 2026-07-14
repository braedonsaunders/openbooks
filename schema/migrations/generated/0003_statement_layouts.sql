CREATE TABLE "statement_layouts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"statement" text NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "statement_layouts_org" ON "statement_layouts" USING btree ("org_id","statement");