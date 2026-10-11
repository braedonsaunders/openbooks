-- OpenBooks forward migration 0661_information_returns_feature_split.
--
-- The year-end information-returns surfaces (1099-NEC/MISC and T4A
-- worksheet/filings, vendor TIN capture, information-return box rules) move
-- from the `subcontractorCompliance` switch to their own `informationReturns`
-- tax switch (Company Settings -> Features -> Finance -> Tax). Data change
-- only: no schema, no function, no trigger in this file.
--
-- Existing organizations that stored subcontractorCompliance on keep their
-- 1099 surfaces: the new switch is stored on for exactly those orgs that
-- have the old switch explicitly on and no explicit stored value for the new
-- switch yet. Idempotent on re-run. Each change is audited per the native
-- feature-change audit (audit_log on orgs with before/after feature maps,
-- the same shape web/lib/features-admin.ts writes).

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

WITH candidates AS (
  SELECT o.id,
         coalesce(o.settings -> 'features', '{}'::jsonb) AS before_features
    FROM public.orgs o
   WHERE jsonb_typeof(coalesce(o.settings -> 'features', '{}'::jsonb)) = 'object'
     AND coalesce(o.settings -> 'features' ->> 'subcontractorCompliance', 'false')::boolean
     AND (o.settings -> 'features' ->> 'informationReturns') IS NULL
),
updated AS (
  UPDATE public.orgs o
     SET settings = jsonb_set(coalesce(o.settings, '{}'::jsonb), '{features}',
                       c.before_features || '{"informationReturns": true}'::jsonb)
    FROM candidates c
   WHERE o.id = c.id
  RETURNING o.id, c.before_features,
            c.before_features || '{"informationReturns": true}'::jsonb AS after_features
)
INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
SELECT id, 'orgs', id, 'update',
       jsonb_build_object('before', jsonb_build_object('features', before_features),
                          'after', jsonb_build_object('features', after_features)),
       NULL
  FROM updated;
