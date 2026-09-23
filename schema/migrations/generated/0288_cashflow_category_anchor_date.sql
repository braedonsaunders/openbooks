-- OpenBooks forward migration 0288_cashflow_category_anchor_date.
--
-- Manual monthly cashflow schedules stepped from the horizon's Sunday with no
-- persisted payment anchor, so moving the forecast date rephased them (a bill
-- on the 30th showed Aug 30 / Sep 30 / Oct 30 from a Sep 2 forecast but
-- Sep 6 / Oct 6 / Nov 6 from a Sep 9 one). The forecast now steps monthly
-- and biweekly schedules from a persisted anchorDate on the category. This
-- backfills anchorDate = migration date onto manual_recurring categories
-- that lack it, freezing their phase from here on; the categories API stamps
-- the anchor on every later write, and the forecast still reads legacy rows
-- without one (stepping from the horizon start, as before). Re-runnable:
-- rows whose categories already carry anchorDate match no predicate.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

UPDATE public.orgs o
   SET settings = jsonb_set(
     jsonb_set(
       COALESCE(o.settings, '{}'::jsonb),
       '{analytics}',
       COALESCE(o.settings -> 'analytics', '{}'::jsonb),
       true
     ),
     '{analytics,cashflowCategories}',
     (
       SELECT COALESCE(jsonb_agg(
         CASE
           WHEN (elem ->> 'method') = 'manual_recurring' AND NOT (elem ? 'anchorDate')
           THEN elem || jsonb_build_object('anchorDate', CURRENT_DATE::text)
           ELSE elem
         END
         ORDER BY idx
       ), '[]'::jsonb)
         FROM jsonb_array_elements(
           COALESCE(o.settings -> 'analytics' -> 'cashflowCategories', '[]'::jsonb)
         ) WITH ORDINALITY AS t(elem, idx)
     ),
     true
   )
 WHERE EXISTS (
   SELECT 1
     FROM jsonb_array_elements(
       COALESCE(o.settings -> 'analytics' -> 'cashflowCategories', '[]'::jsonb)
     ) AS u(elem)
    WHERE (u.elem ->> 'method') = 'manual_recurring'
      AND NOT (u.elem ? 'anchorDate')
 );
