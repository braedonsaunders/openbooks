CREATE TABLE "fx_provider_configs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "org_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "display_name" text NOT NULL,
  "base_currency" text NOT NULL,
  "currencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "schedule" text DEFAULT 'daily' NOT NULL,
  "sync_hour_utc" integer DEFAULT 22 NOT NULL,
  "lookback_days" integer DEFAULT 7 NOT NULL,
  "is_enabled" boolean DEFAULT false NOT NULL,
  "secrets" text,
  "next_sync_at" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "last_observation_date" date,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "fx_provider_configs_provider_check" CHECK (provider in ('bank_of_canada','ecb','open_exchange_rates')),
  CONSTRAINT "fx_provider_configs_schedule_check" CHECK (schedule in ('manual','daily','weekdays','weekly')),
  CONSTRAINT "fx_provider_configs_hour_check" CHECK (sync_hour_utc between 0 and 23),
  CONSTRAINT "fx_provider_configs_lookback_check" CHECK (lookback_days between 1 and 31),
  CONSTRAINT "fx_provider_configs_base_check" CHECK (base_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT "fx_provider_configs_currencies_check" CHECK (jsonb_typeof(currencies) = 'array')
);
CREATE UNIQUE INDEX "fx_provider_configs_org" ON "fx_provider_configs" ("org_id");
CREATE INDEX "fx_provider_configs_due" ON "fx_provider_configs" ("is_enabled", "next_sync_at");

CREATE TABLE "fx_provider_runs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "org_id" uuid NOT NULL,
  "provider_config_id" uuid NOT NULL,
  "trigger" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "requested_from" date,
  "requested_to" date,
  "observations_received" integer DEFAULT 0 NOT NULL,
  "rates_inserted" integer DEFAULT 0 NOT NULL,
  "rates_updated" integer DEFAULT 0 NOT NULL,
  "manual_overrides_preserved" integer DEFAULT 0 NOT NULL,
  "error_message" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "created_by" uuid,
  CONSTRAINT "fx_provider_runs_trigger_check" CHECK (trigger in ('test','manual','scheduler')),
  CONSTRAINT "fx_provider_runs_status_check" CHECK (status in ('running','ok','failed'))
);
CREATE INDEX "fx_provider_runs_org_started" ON "fx_provider_runs" ("org_id", "started_at");
CREATE INDEX "fx_provider_runs_config_started" ON "fx_provider_runs" ("provider_config_id", "started_at");
CREATE UNIQUE INDEX "fx_provider_runs_one_running" ON "fx_provider_runs" ("provider_config_id") WHERE status = 'running';

ALTER TABLE "fx_rates" ADD COLUMN "provider_config_id" uuid;
ALTER TABLE "fx_rates" ADD COLUMN "imported_at" timestamp with time zone;
CREATE INDEX "fx_rates_provider" ON "fx_rates" ("provider_config_id", "as_of");

ALTER TABLE fx_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_provider_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON fx_provider_configs
  USING (current_setting('app.bypass_rls', true) = 'on' OR org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR org_id = nullif(current_setting('app.current_org', true), '')::uuid);
ALTER TABLE fx_provider_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_provider_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON fx_provider_runs
  USING (current_setting('app.bypass_rls', true) = 'on' OR org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR org_id = nullif(current_setting('app.current_org', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbooks_read') THEN
    GRANT SELECT ON fx_provider_configs, fx_provider_runs TO openbooks_read;
  END IF;
END $$;
