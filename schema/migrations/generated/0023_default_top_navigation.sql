ALTER TABLE "orgs"
  ALTER COLUMN "settings"
  SET DEFAULT '{"defaultNavMode":"topbar"}'::jsonb;

UPDATE "orgs"
   SET "settings" = jsonb_set(
     coalesce("settings", '{}'::jsonb),
     '{defaultNavMode}',
     '"topbar"'::jsonb,
     true
   )
 WHERE "settings" ->> 'defaultNavMode' IS DISTINCT FROM 'topbar';
