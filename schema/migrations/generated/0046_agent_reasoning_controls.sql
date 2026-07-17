ALTER TABLE "ai_agent_policies" ADD COLUMN "analysis_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_agent_policies" ADD CONSTRAINT "ai_agent_policies_analysis_settings_object_check" CHECK (jsonb_typeof("analysis_settings") = 'object');
