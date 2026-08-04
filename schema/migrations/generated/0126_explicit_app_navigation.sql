-- App placement has one authoritative source: org_nav_configs.
-- Installed apps remain available from the Apps library and never acquire a
-- workspace shortcut merely because they were installed or authored.
UPDATE app_versions
   SET manifest = jsonb_set(manifest, '{nav}', (manifest -> 'nav') - 'show')
 WHERE jsonb_typeof(manifest -> 'nav') = 'object'
   AND (manifest -> 'nav') ? 'show';

ALTER TABLE apps DROP COLUMN show_in_nav;
