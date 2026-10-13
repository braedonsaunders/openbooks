-- Financial tenant policies use the authenticated privileged-login bypass predicate.
-- Backfill: none. Configuration, accounting and retained audit rows are unchanged.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $guard$
BEGIN
  IF EXISTS (
WITH expected(table_name, relation_id) AS (
  VALUES ('fx_rate_types', 'public.fx_rate_types'::regclass),
    ('account_translation_policies', 'public.account_translation_policies'::regclass),
    ('subsidiary_accounting_preferences', 'public.subsidiary_accounting_preferences'::regclass),
    ('journal_reversal_instructions', 'public.journal_reversal_instructions'::regclass),
    ('segment_balancing_policies', 'public.segment_balancing_policies'::regclass),
    ('gl_audit_number_policies', 'public.gl_audit_number_policies'::regclass),
    ('gl_audit_number_assignments', 'public.gl_audit_number_assignments'::regclass)
), catalog AS (
  SELECT e.table_name,c.relrowsecurity,c.relforcerowsecurity,
    count(p.oid) AS policy_count,
    bool_and(p.polname='org_isolation' AND p.polcmd='*' AND p.polpermissive
      AND p.polroles=ARRAY[0::oid]
      AND obj_description(p.oid,'pg_policy')='openbooks:org_isolation:v1'
      AND pg_get_expr(p.polqual,p.polrelid)=pg_get_expr(p.polwithcheck,p.polrelid)
      AND pg_get_expr(p.polqual,p.polrelid) IN (
        '((current_setting(''app.bypass_rls''::text, true) = ''on''::text) OR ((org_id)::text = current_setting(''app.current_org''::text, true)))',
        '(( SELECT app_bypass_rls_active() AS app_bypass_rls_active) OR ((org_id)::text = ( SELECT current_setting(''app.current_org''::text, true) AS current_setting)))'
      )) AS definition_matches
  FROM expected e JOIN pg_class c ON c.oid=e.relation_id
  LEFT JOIN pg_policy p ON p.polrelid=c.oid
  GROUP BY e.table_name,c.relrowsecurity,c.relforcerowsecurity
)
SELECT '0707.policy_definition' AS code,'refuse' AS severity,
  'public.'||table_name AS subject,
  'The financial tenant policy differs from its published or native canonical definition.' AS detail,
  'Preserve the policy and tenant records; reconcile its definition through the database owner before retrying the native migration runner.' AS remedy
FROM catalog WHERE NOT relrowsecurity OR NOT relforcerowsecurity
  OR policy_count<>1 OR definition_matches IS DISTINCT FROM true
  ) THEN
    RAISE EXCEPTION 'Financial tenant policy definitions require database-owner reconciliation before migration.' USING ERRCODE='23514';
  END IF;
END
$guard$;

DROP POLICY org_isolation ON public.fx_rate_types;
CREATE POLICY org_isolation ON public.fx_rate_types
  USING ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.fx_rate_types IS 'openbooks:org_isolation:v1';

DROP POLICY org_isolation ON public.account_translation_policies;
CREATE POLICY org_isolation ON public.account_translation_policies
  USING ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.account_translation_policies IS 'openbooks:org_isolation:v1';

DROP POLICY org_isolation ON public.subsidiary_accounting_preferences;
CREATE POLICY org_isolation ON public.subsidiary_accounting_preferences
  USING ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.subsidiary_accounting_preferences IS 'openbooks:org_isolation:v1';

DROP POLICY org_isolation ON public.journal_reversal_instructions;
CREATE POLICY org_isolation ON public.journal_reversal_instructions
  USING ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.journal_reversal_instructions IS 'openbooks:org_isolation:v1';

DROP POLICY org_isolation ON public.segment_balancing_policies;
CREATE POLICY org_isolation ON public.segment_balancing_policies
  USING ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.segment_balancing_policies IS 'openbooks:org_isolation:v1';

DROP POLICY org_isolation ON public.gl_audit_number_policies;
CREATE POLICY org_isolation ON public.gl_audit_number_policies
  USING ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.gl_audit_number_policies IS 'openbooks:org_isolation:v1';

DROP POLICY org_isolation ON public.gl_audit_number_assignments;
CREATE POLICY org_isolation ON public.gl_audit_number_assignments
  USING ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active())
    OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.gl_audit_number_assignments IS 'openbooks:org_isolation:v1';

