CREATE TABLE "crm_account_assignment_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"from_owner_user_id" uuid,
	"to_owner_user_id" uuid,
	"from_territory_id" uuid,
	"to_territory_id" uuid,
	"source" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "crm_account_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"lifecycle_stage" text DEFAULT 'lead' NOT NULL,
	"status_id" uuid,
	"owner_user_id" uuid,
	"territory_id" uuid,
	"lead_source_id" uuid,
	"industry" text,
	"category" text,
	"annual_revenue" numeric(19, 4),
	"employee_count" integer,
	"qualification_score" integer,
	"qualification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_action_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"qualified_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"acquired_on" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "crm_account_qualification_score" CHECK ("crm_account_profiles"."qualification_score" is null or ("crm_account_profiles"."qualification_score" >= 0 and "crm_account_profiles"."qualification_score" <= 100)),
	CONSTRAINT "crm_account_employee_count" CHECK ("crm_account_profiles"."employee_count" is null or "crm_account_profiles"."employee_count" >= 0)
);

CREATE TABLE "crm_account_stage_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"from_stage" text,
	"to_stage" text NOT NULL,
	"source_kind" text DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "crm_account_statuses" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"lifecycle_stage" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sequence" integer DEFAULT 0 NOT NULL,
	"is_qualified" boolean DEFAULT false NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "crm_activities" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"subject" text NOT NULL,
	"body" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"owner_user_id" uuid,
	"assigned_user_id" uuid,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"reminder_at" timestamp with time zone,
	"duration_minutes" integer,
	"recurrence" jsonb,
	"is_private" boolean DEFAULT false NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "crm_activity_duration" CHECK ("crm_activities"."duration_minutes" is null or "crm_activities"."duration_minutes" >= 0),
	CONSTRAINT "crm_activity_dates" CHECK ("crm_activities"."ends_at" is null or "crm_activities"."starts_at" is null or "crm_activities"."ends_at" >= "crm_activities"."starts_at")
);

CREATE TABLE "crm_activity_links" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "crm_activity_participants" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"user_id" uuid,
	"contact_id" uuid,
	"email" text,
	"response" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "crm_activity_participant_target" CHECK (num_nonnulls("crm_activity_participants"."user_id", "crm_activity_participants"."contact_id", "crm_activity_participants"."email") = 1)
);

CREATE TABLE "crm_lead_sources" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "crm_sales_territories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"manager_user_id" uuid,
	"default_owner_user_id" uuid,
	"match_mode" text DEFAULT 'all' NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "crm_forecast_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"sales_team_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"as_of" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot_kind" text NOT NULL,
	"currency" text NOT NULL,
	"pipeline_amount" numeric(19, 4) NOT NULL,
	"weighted_amount" numeric(19, 4) NOT NULL,
	"worst_case_amount" numeric(19, 4) NOT NULL,
	"most_likely_amount" numeric(19, 4) NOT NULL,
	"upside_amount" numeric(19, 4) NOT NULL,
	"closed_amount" numeric(19, 4) NOT NULL,
	"override_amount" numeric(19, 4),
	"note" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "crm_forecast_snapshot_target" CHECK (num_nonnulls("crm_forecast_snapshots"."owner_user_id", "crm_forecast_snapshots"."sales_team_id") = 1),
	CONSTRAINT "crm_forecast_snapshot_dates" CHECK ("crm_forecast_snapshots"."period_end" >= "crm_forecast_snapshots"."period_start")
);

CREATE TABLE "crm_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"opportunity_number" text NOT NULL,
	"title" text NOT NULL,
	"party_id" uuid,
	"primary_contact_id" uuid,
	"owner_user_id" uuid,
	"sales_team_id" uuid,
	"status_id" uuid NOT NULL,
	"lead_source_id" uuid,
	"expected_close_date" date,
	"forecast_category" text DEFAULT 'upside' NOT NULL,
	"probability" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"projected_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"weighted_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"range_low" numeric(19, 4),
	"range_high" numeric(19, 4),
	"subsidiary_id" uuid,
	"department_id" uuid,
	"location_id" uuid,
	"class_id" uuid,
	"extra_dims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_step" text,
	"competitor_notes" text,
	"win_loss_reason" text,
	"description" text,
	"closed_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "crm_opportunity_probability" CHECK ("crm_opportunities"."probability" >= 0 and "crm_opportunities"."probability" <= 100),
	CONSTRAINT "crm_opportunity_amounts" CHECK ("crm_opportunities"."projected_amount" >= 0 and "crm_opportunities"."weighted_amount" >= 0 and ("crm_opportunities"."range_low" is null or "crm_opportunities"."range_low" >= 0) and ("crm_opportunities"."range_high" is null or "crm_opportunities"."range_high" >= 0) and ("crm_opportunities"."range_low" is null or "crm_opportunities"."range_high" is null or "crm_opportunities"."range_high" >= "crm_opportunities"."range_low"))
);

CREATE TABLE "crm_opportunity_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "crm_opportunity_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_id" uuid,
	"description" text,
	"quantity" numeric(19, 4) DEFAULT '1' NOT NULL,
	"unit" text,
	"unit_price" numeric(19, 4) DEFAULT '0' NOT NULL,
	"amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"probability" integer,
	"expected_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "crm_opportunity_line_values" CHECK ("crm_opportunity_lines"."quantity" > 0 and "crm_opportunity_lines"."unit_price" >= 0 and "crm_opportunity_lines"."amount" >= 0 and "crm_opportunity_lines"."expected_amount" >= 0 and ("crm_opportunity_lines"."probability" is null or ("crm_opportunity_lines"."probability" >= 0 and "crm_opportunity_lines"."probability" <= 100)))
);

CREATE TABLE "crm_opportunity_stage_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"from_status_id" uuid,
	"to_status_id" uuid NOT NULL,
	"probability" integer NOT NULL,
	"forecast_category" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "crm_opportunity_statuses" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sequence" integer DEFAULT 0 NOT NULL,
	"probability" integer DEFAULT 0 NOT NULL,
	"default_forecast_category" text DEFAULT 'upside' NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"is_won" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "crm_opportunity_status_probability" CHECK ("crm_opportunity_statuses"."probability" >= 0 and "crm_opportunity_statuses"."probability" <= 100),
	CONSTRAINT "crm_opportunity_status_won_closed" CHECK (not "crm_opportunity_statuses"."is_won" or "crm_opportunity_statuses"."is_closed")
);

CREATE TABLE "crm_opportunity_team_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"contribution_percent" numeric(19, 4) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "crm_opportunity_contribution" CHECK ("crm_opportunity_team_members"."contribution_percent" > 0 and "crm_opportunity_team_members"."contribution_percent" <= 100)
);

CREATE TABLE "crm_sales_quotas" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"sales_team_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "crm_sales_quota_target" CHECK (num_nonnulls("crm_sales_quotas"."owner_user_id", "crm_sales_quotas"."sales_team_id") = 1),
	CONSTRAINT "crm_sales_quota_dates" CHECK ("crm_sales_quotas"."period_end" >= "crm_sales_quotas"."period_start"),
	CONSTRAINT "crm_sales_quota_amount" CHECK ("crm_sales_quotas"."amount" >= 0)
);

CREATE TABLE "crm_sales_team_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "crm_sales_teams" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"manager_user_id" uuid,
	"parent_team_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE INDEX "crm_account_assignment_events_profile" ON "crm_account_assignment_events" USING btree ("account_profile_id","occurred_at");
CREATE UNIQUE INDEX "crm_account_profiles_party" ON "crm_account_profiles" USING btree ("party_id");
CREATE INDEX "crm_account_profiles_stage_owner" ON "crm_account_profiles" USING btree ("org_id","lifecycle_stage","owner_user_id");
CREATE INDEX "crm_account_profiles_territory" ON "crm_account_profiles" USING btree ("org_id","territory_id");
CREATE INDEX "crm_account_stage_events_profile" ON "crm_account_stage_events" USING btree ("account_profile_id","occurred_at");
CREATE UNIQUE INDEX "crm_account_statuses_org_stage_key" ON "crm_account_statuses" USING btree ("org_id","lifecycle_stage","key");
CREATE INDEX "crm_account_statuses_org_stage" ON "crm_account_statuses" USING btree ("org_id","lifecycle_stage","sequence");
CREATE INDEX "crm_activities_assignee" ON "crm_activities" USING btree ("org_id","assigned_user_id","status","due_at");
CREATE INDEX "crm_activities_calendar" ON "crm_activities" USING btree ("org_id","starts_at","ends_at");
CREATE UNIQUE INDEX "crm_activity_links_unique" ON "crm_activity_links" USING btree ("activity_id","subject_kind","subject_id");
CREATE INDEX "crm_activity_links_subject" ON "crm_activity_links" USING btree ("org_id","subject_kind","subject_id");
CREATE INDEX "crm_activity_participants_activity" ON "crm_activity_participants" USING btree ("activity_id");
CREATE UNIQUE INDEX "crm_lead_sources_org_key" ON "crm_lead_sources" USING btree ("org_id","key");
CREATE UNIQUE INDEX "crm_sales_territories_org_key" ON "crm_sales_territories" USING btree ("org_id","key");
CREATE INDEX "crm_sales_territories_routing" ON "crm_sales_territories" USING btree ("org_id","is_active","priority");
CREATE INDEX "crm_forecast_snapshots_owner_period" ON "crm_forecast_snapshots" USING btree ("org_id","owner_user_id","period_start","period_end","as_of");
CREATE UNIQUE INDEX "crm_opportunities_org_number" ON "crm_opportunities" USING btree ("org_id","opportunity_number");
CREATE INDEX "crm_opportunities_pipeline" ON "crm_opportunities" USING btree ("org_id","status_id","expected_close_date");
CREATE INDEX "crm_opportunities_owner" ON "crm_opportunities" USING btree ("org_id","owner_user_id","expected_close_date");
CREATE INDEX "crm_opportunities_party" ON "crm_opportunities" USING btree ("org_id","party_id");
CREATE UNIQUE INDEX "crm_opportunity_documents_document" ON "crm_opportunity_documents" USING btree ("document_id");
CREATE INDEX "crm_opportunity_documents_opportunity" ON "crm_opportunity_documents" USING btree ("opportunity_id");
CREATE UNIQUE INDEX "crm_opportunity_lines_number" ON "crm_opportunity_lines" USING btree ("opportunity_id","line_number");
CREATE INDEX "crm_opportunity_lines_opportunity" ON "crm_opportunity_lines" USING btree ("opportunity_id");
CREATE INDEX "crm_opportunity_stage_events_opportunity" ON "crm_opportunity_stage_events" USING btree ("opportunity_id","occurred_at");
CREATE UNIQUE INDEX "crm_opportunity_statuses_org_key" ON "crm_opportunity_statuses" USING btree ("org_id","key");
CREATE INDEX "crm_opportunity_statuses_org_sequence" ON "crm_opportunity_statuses" USING btree ("org_id","sequence");
CREATE UNIQUE INDEX "crm_opportunity_team_members_unique" ON "crm_opportunity_team_members" USING btree ("opportunity_id","user_id");
CREATE INDEX "crm_sales_quotas_owner_period" ON "crm_sales_quotas" USING btree ("org_id","owner_user_id","period_start","period_end");
CREATE UNIQUE INDEX "crm_sales_team_members_unique" ON "crm_sales_team_members" USING btree ("team_id","user_id");
CREATE UNIQUE INDEX "crm_sales_teams_org_key" ON "crm_sales_teams" USING btree ("org_id","key");

-- Tenant and relationship integrity.
alter table crm_account_assignment_events add constraint crm_account_assignment_events_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_account_profiles add constraint crm_account_profiles_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_account_stage_events add constraint crm_account_stage_events_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_account_statuses add constraint crm_account_statuses_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_activities add constraint crm_activities_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_activity_links add constraint crm_activity_links_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_activity_participants add constraint crm_activity_participants_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_lead_sources add constraint crm_lead_sources_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_sales_territories add constraint crm_sales_territories_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_forecast_snapshots add constraint crm_forecast_snapshots_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_opportunities add constraint crm_opportunities_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_opportunity_documents add constraint crm_opportunity_documents_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_opportunity_lines add constraint crm_opportunity_lines_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_opportunity_stage_events add constraint crm_opportunity_stage_events_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_opportunity_statuses add constraint crm_opportunity_statuses_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_opportunity_team_members add constraint crm_opportunity_team_members_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_sales_quotas add constraint crm_sales_quotas_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_sales_team_members add constraint crm_sales_team_members_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_sales_teams add constraint crm_sales_teams_org_fk foreign key (org_id) references orgs(id) on delete cascade;
alter table crm_account_profiles add constraint crm_account_profiles_party_fk foreign key (party_id) references parties(id) on delete cascade;
alter table crm_account_profiles add constraint crm_account_profiles_status_fk foreign key (status_id) references crm_account_statuses(id) on delete restrict;
alter table crm_account_profiles add constraint crm_account_profiles_owner_fk foreign key (owner_user_id) references users(id) on delete set null;
alter table crm_account_profiles add constraint crm_account_profiles_territory_fk foreign key (territory_id) references crm_sales_territories(id) on delete set null;
alter table crm_account_profiles add constraint crm_account_profiles_source_fk foreign key (lead_source_id) references crm_lead_sources(id) on delete set null;
alter table crm_account_stage_events add constraint crm_account_stage_events_profile_fk foreign key (account_profile_id) references crm_account_profiles(id) on delete cascade;
alter table crm_account_assignment_events add constraint crm_account_assignment_events_profile_fk foreign key (account_profile_id) references crm_account_profiles(id) on delete cascade;
alter table crm_lead_sources add constraint crm_lead_sources_parent_fk foreign key (parent_id) references crm_lead_sources(id) on delete restrict;
alter table crm_sales_territories add constraint crm_sales_territories_parent_fk foreign key (parent_id) references crm_sales_territories(id) on delete restrict;
alter table crm_sales_territories add constraint crm_sales_territories_manager_fk foreign key (manager_user_id) references users(id) on delete set null;
alter table crm_sales_territories add constraint crm_sales_territories_owner_fk foreign key (default_owner_user_id) references users(id) on delete set null;
alter table crm_activities add constraint crm_activities_owner_fk foreign key (owner_user_id) references users(id) on delete set null;
alter table crm_activities add constraint crm_activities_assignee_fk foreign key (assigned_user_id) references users(id) on delete set null;
alter table crm_activity_links add constraint crm_activity_links_activity_fk foreign key (activity_id) references crm_activities(id) on delete cascade;
alter table crm_activity_participants add constraint crm_activity_participants_activity_fk foreign key (activity_id) references crm_activities(id) on delete cascade;
alter table crm_activity_participants add constraint crm_activity_participants_user_fk foreign key (user_id) references users(id) on delete cascade;
alter table crm_activity_participants add constraint crm_activity_participants_contact_fk foreign key (contact_id) references contacts(id) on delete cascade;
alter table crm_sales_teams add constraint crm_sales_teams_manager_fk foreign key (manager_user_id) references users(id) on delete set null;
alter table crm_sales_teams add constraint crm_sales_teams_parent_fk foreign key (parent_team_id) references crm_sales_teams(id) on delete restrict;
alter table crm_sales_team_members add constraint crm_sales_team_members_team_fk foreign key (team_id) references crm_sales_teams(id) on delete cascade;
alter table crm_sales_team_members add constraint crm_sales_team_members_user_fk foreign key (user_id) references users(id) on delete cascade;
alter table crm_opportunities add constraint crm_opportunities_party_fk foreign key (party_id) references parties(id) on delete restrict;
alter table crm_opportunities add constraint crm_opportunities_contact_fk foreign key (primary_contact_id) references contacts(id) on delete set null;
alter table crm_opportunities add constraint crm_opportunities_owner_fk foreign key (owner_user_id) references users(id) on delete set null;
alter table crm_opportunities add constraint crm_opportunities_team_fk foreign key (sales_team_id) references crm_sales_teams(id) on delete set null;
alter table crm_opportunities add constraint crm_opportunities_status_fk foreign key (status_id) references crm_opportunity_statuses(id) on delete restrict;
alter table crm_opportunities add constraint crm_opportunities_source_fk foreign key (lead_source_id) references crm_lead_sources(id) on delete set null;
alter table crm_opportunities add constraint crm_opportunities_subsidiary_fk foreign key (subsidiary_id) references subsidiaries(id) on delete restrict;
alter table crm_opportunities add constraint crm_opportunities_department_fk foreign key (department_id) references departments(id) on delete restrict;
alter table crm_opportunities add constraint crm_opportunities_location_fk foreign key (location_id) references locations(id) on delete restrict;
alter table crm_opportunities add constraint crm_opportunities_class_fk foreign key (class_id) references classes(id) on delete restrict;
alter table crm_opportunity_lines add constraint crm_opportunity_lines_opportunity_fk foreign key (opportunity_id) references crm_opportunities(id) on delete cascade;
alter table crm_opportunity_lines add constraint crm_opportunity_lines_item_fk foreign key (item_id) references items(id) on delete restrict;
alter table crm_opportunity_team_members add constraint crm_opportunity_team_members_opportunity_fk foreign key (opportunity_id) references crm_opportunities(id) on delete cascade;
alter table crm_opportunity_team_members add constraint crm_opportunity_team_members_user_fk foreign key (user_id) references users(id) on delete restrict;
alter table crm_opportunity_documents add constraint crm_opportunity_documents_opportunity_fk foreign key (opportunity_id) references crm_opportunities(id) on delete cascade;
alter table crm_opportunity_documents add constraint crm_opportunity_documents_document_fk foreign key (document_id) references documents(id) on delete cascade;
alter table crm_opportunity_stage_events add constraint crm_opportunity_stage_events_opportunity_fk foreign key (opportunity_id) references crm_opportunities(id) on delete cascade;
alter table crm_opportunity_stage_events add constraint crm_opportunity_stage_events_from_status_fk foreign key (from_status_id) references crm_opportunity_statuses(id) on delete restrict;
alter table crm_opportunity_stage_events add constraint crm_opportunity_stage_events_to_status_fk foreign key (to_status_id) references crm_opportunity_statuses(id) on delete restrict;
alter table crm_sales_quotas add constraint crm_sales_quotas_owner_fk foreign key (owner_user_id) references users(id) on delete restrict;
alter table crm_sales_quotas add constraint crm_sales_quotas_team_fk foreign key (sales_team_id) references crm_sales_teams(id) on delete restrict;
alter table crm_forecast_snapshots add constraint crm_forecast_snapshots_owner_fk foreign key (owner_user_id) references users(id) on delete restrict;
alter table crm_forecast_snapshots add constraint crm_forecast_snapshots_team_fk foreign key (sales_team_id) references crm_sales_teams(id) on delete restrict;

-- Tenant isolation follows the existing request-scoped org setting.
alter table crm_account_assignment_events enable row level security;
create policy crm_account_assignment_events_org_isolation on crm_account_assignment_events
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_account_profiles enable row level security;
create policy crm_account_profiles_org_isolation on crm_account_profiles
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_account_stage_events enable row level security;
create policy crm_account_stage_events_org_isolation on crm_account_stage_events
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_account_statuses enable row level security;
create policy crm_account_statuses_org_isolation on crm_account_statuses
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_activities enable row level security;
create policy crm_activities_org_isolation on crm_activities
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_activity_links enable row level security;
create policy crm_activity_links_org_isolation on crm_activity_links
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_activity_participants enable row level security;
create policy crm_activity_participants_org_isolation on crm_activity_participants
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_lead_sources enable row level security;
create policy crm_lead_sources_org_isolation on crm_lead_sources
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_sales_territories enable row level security;
create policy crm_sales_territories_org_isolation on crm_sales_territories
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_forecast_snapshots enable row level security;
create policy crm_forecast_snapshots_org_isolation on crm_forecast_snapshots
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_opportunities enable row level security;
create policy crm_opportunities_org_isolation on crm_opportunities
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_opportunity_documents enable row level security;
create policy crm_opportunity_documents_org_isolation on crm_opportunity_documents
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_opportunity_lines enable row level security;
create policy crm_opportunity_lines_org_isolation on crm_opportunity_lines
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_opportunity_stage_events enable row level security;
create policy crm_opportunity_stage_events_org_isolation on crm_opportunity_stage_events
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_opportunity_statuses enable row level security;
create policy crm_opportunity_statuses_org_isolation on crm_opportunity_statuses
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_opportunity_team_members enable row level security;
create policy crm_opportunity_team_members_org_isolation on crm_opportunity_team_members
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_sales_quotas enable row level security;
create policy crm_sales_quotas_org_isolation on crm_sales_quotas
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_sales_team_members enable row level security;
create policy crm_sales_team_members_org_isolation on crm_sales_team_members
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
alter table crm_sales_teams enable row level security;
create policy crm_sales_teams_org_isolation on crm_sales_teams
  using (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('openbooks.org_id', true), '')::uuid);
grant select on crm_account_assignment_events, crm_account_profiles, crm_account_stage_events, crm_account_statuses, crm_activities, crm_activity_links, crm_activity_participants, crm_lead_sources, crm_sales_territories, crm_forecast_snapshots, crm_opportunities, crm_opportunity_documents, crm_opportunity_lines, crm_opportunity_stage_events, crm_opportunity_statuses, crm_opportunity_team_members, crm_sales_quotas, crm_sales_team_members, crm_sales_teams to openbooks_read;
