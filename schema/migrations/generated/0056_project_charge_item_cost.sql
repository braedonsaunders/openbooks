ALTER TABLE "items" ADD COLUMN "default_cost" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "cost_recovery_account_id" uuid;
