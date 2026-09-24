-- OpenBooks forward migration 0341_project_site_jurisdiction.
--
-- A lien waiver releases a claim against improved real property, and the law
-- that decides whether the release is effective is the law of the place
-- where the property sits — not the vendor's home state, not the org's home
-- state. The waiver row carried a free-text jurisdiction that nothing
-- validated and nothing evaluated, so a wrong-state waiver released
-- payment; and the project it releases against carried no jurisdiction at
-- all, so there was nothing to match the waiver against.
--
-- projects.site_jurisdiction records where the improved property sits, as an
-- ISO 3166-2 subdivision code (e.g. US-CA, CA-ON, DE-BY) validated by the
-- application against the vendored registry. It is nullable with no
-- default: history cannot be invented, so existing projects keep a null
-- site, and a null site fails closed in lien-waiver coverage as unevaluable
-- rather than matching any waiver.
--
-- The column is nullable with no default: a metadata-only change that
-- rewrites no rows.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS site_jurisdiction text;

COMMENT ON COLUMN public.projects.site_jurisdiction IS
  'ISO 3166-2 subdivision code where the improved property sits (e.g. US-CA). Null for projects whose site was never recorded; lien-waiver coverage treats a null site as unevaluable, never as a match.';
