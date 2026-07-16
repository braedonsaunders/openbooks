ALTER TABLE "users" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "user_org_access" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"member_user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"acting_user_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_org_access_member_org" ON "user_org_access" ("member_user_id","org_id");--> statement-breakpoint
CREATE INDEX "user_org_access_member" ON "user_org_access" ("member_user_id");--> statement-breakpoint
CREATE INDEX "user_org_access_org" ON "user_org_access" ("org_id");
