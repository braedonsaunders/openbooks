ALTER TABLE "ai_agent_policies" ADD COLUMN "detector_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_agent_policies" ADD CONSTRAINT "ai_agent_policies_detector_settings_object_check" CHECK (jsonb_typeof("detector_settings") = 'object');
