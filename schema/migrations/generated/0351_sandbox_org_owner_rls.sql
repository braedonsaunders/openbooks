-- OpenBooks forward migration 0351_sandbox_org_owner_rls.
--
-- A production tenant could previously insert a sandboxes row whose
-- production_org_id was its own, but whose org_id pointed at another
-- tenant's organization. Keep the production-owner visibility rule while
-- requiring writes to bind the row to an actual sandbox organization owned
-- by that same production organization.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DROP POLICY IF EXISTS sandbox_isolation ON public.sandboxes;
CREATE POLICY sandbox_isolation ON public.sandboxes
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
    OR production_org_id::text = current_setting('app.current_org', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR (
      production_org_id::text = current_setting('app.current_org', true)
      AND EXISTS (
        SELECT 1
          FROM public.orgs sandbox_org
         WHERE sandbox_org.id = public.sandboxes.org_id
           AND sandbox_org.env_kind = 'sandbox'
           AND sandbox_org.sandbox_of = public.sandboxes.production_org_id
      )
    )
  );
COMMENT ON POLICY sandbox_isolation ON public.sandboxes
  IS 'openbooks:sandbox_isolation:v2';
