-- Rename saved_searches → saved_views (feature rebranded "Saved Searches" → "Views").
-- Postgres carries the table's indexes, constraints, and foreign keys through a
-- RENAME, so no data moves and the four FKs (added by referential-integrity.sql)
-- follow automatically. The indexes are renamed explicitly to keep their names
-- in sync with schema/src/views.ts. IF EXISTS guards make this safe to skip when
-- an environment was created fresh from the renamed schema.

ALTER TABLE IF EXISTS "saved_searches" RENAME TO "saved_views";
--> statement-breakpoint
-- Keep the auto-named primary-key index in sync with the new table name, so a
-- migrated database matches one created fresh (Postgres names it saved_views_pkey).
ALTER INDEX IF EXISTS "saved_searches_pkey" RENAME TO "saved_views_pkey";
--> statement-breakpoint
ALTER INDEX IF EXISTS "saved_searches_org_slug" RENAME TO "saved_views_org_slug";
--> statement-breakpoint
ALTER INDEX IF EXISTS "saved_searches_org_scope" RENAME TO "saved_views_org_scope";
--> statement-breakpoint
ALTER INDEX IF EXISTS "saved_searches_org_owner" RENAME TO "saved_views_org_owner";
--> statement-breakpoint
ALTER INDEX IF EXISTS "saved_searches_org_name" RENAME TO "saved_views_org_name";
--> statement-breakpoint
-- Bring the foreign-key constraint names in line with the new table too. On a
-- database created fresh from the renamed schema these FKs are added later (by
-- referential-integrity.sql) already named saved_views_*, and don't exist when
-- this migration runs — so each rename is guarded to a no-op in that case.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_searches_org_id_fkey') THEN
    ALTER TABLE "saved_views" RENAME CONSTRAINT "saved_searches_org_id_fkey" TO "saved_views_org_id_fkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_searches_owner_id_fkey') THEN
    ALTER TABLE "saved_views" RENAME CONSTRAINT "saved_searches_owner_id_fkey" TO "saved_views_owner_id_fkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_searches_created_by_fkey') THEN
    ALTER TABLE "saved_views" RENAME CONSTRAINT "saved_searches_created_by_fkey" TO "saved_views_created_by_fkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_searches_updated_by_fkey') THEN
    ALTER TABLE "saved_views" RENAME CONSTRAINT "saved_searches_updated_by_fkey" TO "saved_views_updated_by_fkey";
  END IF;
END $$;
