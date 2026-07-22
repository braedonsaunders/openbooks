-- Line-level subledger entity: document_lines.party_id (→ parties).
-- Faithful to how every source system models a transaction line (source platform line
-- "Name" / source platform line Entity): the customer/vendor/employee lives on the LINE, not
-- only the header. Idempotent — the FK is added here too because bootstrap does
-- not re-run referential-integrity.sql on an already-migrated cluster.
ALTER TABLE "document_lines" ADD COLUMN IF NOT EXISTS "party_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "doc_lines_party" ON "document_lines" ("party_id");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_party_id_parties_id_fk"
    FOREIGN KEY ("party_id") REFERENCES "parties"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
