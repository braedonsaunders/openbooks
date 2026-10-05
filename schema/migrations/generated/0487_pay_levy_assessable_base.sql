-- Employer levies assess their own earnings base, never gross pay: a
-- non-taxable earning type is not assessable for workers' compensation or
-- employer health tax. Components created before per-levy exclusions carry
-- an empty program_exclusions list, which the old gross-pay levies read as
-- assess-everything.
--
-- This backfill materializes the default the setup write path now applies
-- to new components: every non-taxable earning in the Canada scope (pack
-- country CA, or shared country-less components) gains the four CA
-- employer-levy keys (wcb, eht, hsf, cnt). Taxable earnings — cash or
-- non-cash — keep the empty list and stay assessable. Deductions and
-- employer contributions are untouched: levy applicability is read on
-- earning lines alone.
--
-- One-shot by audit evidence: the update stamps one audit row per touched
-- component, and a replay skips every component that already carries one,
-- so an operator's later exclusion edit is never rewritten by a second
-- run. The update stamps updated_at, so runs calculated before the upgrade
-- recalculate before committing.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $backfill$
DECLARE
  component RECORD;
  missing text[];
BEGIN
  FOR component IN
    SELECT c.id, c.org_id, c.code, c.program_exclusions
      FROM public.pay_components c
     WHERE c.kind = 'earning'
       AND c.taxable = false
       AND (c.country IS NULL OR c.country = 'CA')
       AND NOT (
         c.program_exclusions @> ARRAY['wcb', 'eht', 'hsf', 'cnt']
       )
  LOOP
    missing := ARRAY(
      SELECT key FROM (VALUES ('wcb'), ('eht'), ('hsf'), ('cnt')) AS keys(key)
       WHERE NOT (component.program_exclusions @> ARRAY[key])
    );
    IF array_length(missing, 1) IS NULL THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.audit_log
       WHERE org_id = component.org_id
         AND table_name = 'pay_components'
         AND row_id = component.id
         AND changes->>'operation' = 'levy_exclusion_backfill_0483'
    ) THEN
      CONTINUE;
    END IF;
    UPDATE public.pay_components
       SET program_exclusions = (
             SELECT array_agg(DISTINCT key ORDER BY key)
               FROM unnest(program_exclusions || missing) AS key
           ),
           updated_at = now()
     WHERE id = component.id;
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes)
    VALUES (component.org_id, 'pay_components', component.id, 'update',
            jsonb_build_object(
              'operation', 'levy_exclusion_backfill_0483',
              'before', jsonb_build_object('program_exclusions', component.program_exclusions),
              'after', jsonb_build_object('program_exclusions', (
                SELECT array_agg(DISTINCT key ORDER BY key)
                  FROM unnest(component.program_exclusions || missing) AS key
              )),
              'reason', 'Non-taxable earnings default to excluded from employer levies (wcb, eht, hsf, cnt); taxable earnings stay assessable.'
            ));
  END LOOP;
END;
$backfill$;

SELECT public.openbooks_refresh_query_catalog();
