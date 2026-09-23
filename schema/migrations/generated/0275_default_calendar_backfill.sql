-- OpenBooks forward migration 0275_default_calendar_backfill.
--
-- The shared posting-period resolver reads the org's default active
-- fiscal calendar. Before it, covering-date queries accepted any
-- calendar's period, so an org whose calendars carry no ACTIVE default
-- posted fine — and would have every posting refused after the resolver
-- deploys. This backfill promotes exactly one active default per such
-- org, deterministically: the active calendar holding the most periods
-- (the calendar the org actually posts into), breaking ties by oldest
-- creation, then id. A tie for first on BOTH period count and creation
-- time cannot be resolved by usage or age, so the migration refuses
-- naming the org ids instead of guessing; likewise an org whose
-- calendars are all inactive (nothing safe to promote — reactivate
-- through the close screen first). Re-runnable: orgs already holding an
-- active default are untouched, and a second run finds nothing to do.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

DO $$
DECLARE
  ambiguous uuid[];
  inactive_only uuid[];
BEGIN
  -- Tie for first place on both usage and age: refuse with the org ids.
  WITH target_orgs AS (
    SELECT c.org_id
      FROM public.fiscal_calendars c
     GROUP BY c.org_id
    HAVING COUNT(*) FILTER (WHERE c.is_active) > 0
       AND COUNT(*) FILTER (WHERE c.is_default AND c.is_active) = 0
  ),
  ranked AS (
    SELECT c.org_id, c.id,
           COUNT(p.id) AS period_count, c.created_at,
           ROW_NUMBER() OVER (
             PARTITION BY c.org_id
             ORDER BY COUNT(p.id) DESC, c.created_at ASC, c.id ASC
           ) AS rn
      FROM public.fiscal_calendars c
      LEFT JOIN public.accounting_periods p
        ON p.fiscal_calendar_id = c.id AND p.org_id = c.org_id
      JOIN target_orgs t ON t.org_id = c.org_id
     WHERE c.is_active
     GROUP BY c.org_id, c.id, c.created_at
  )
  SELECT array_agg(r1.org_id) INTO ambiguous
    FROM ranked r1
    JOIN ranked r2 ON r2.org_id = r1.org_id AND r2.rn = 2
   WHERE r1.rn = 1
     AND r2.period_count = r1.period_count
     AND r2.created_at = r1.created_at;
  IF array_length(ambiguous, 1) > 0 THEN
    RAISE EXCEPTION 'refusing to guess a default fiscal calendar for orgs with tied active calendars (same period count and creation time): % — promote one default per org from the close calendars screen first',
      array_to_string(ambiguous, ', ');
  END IF;

  -- Promote the deterministic winner: most periods, then oldest, then id.
  WITH target_orgs AS (
    SELECT c.org_id
      FROM public.fiscal_calendars c
     GROUP BY c.org_id
    HAVING COUNT(*) FILTER (WHERE c.is_active) > 0
       AND COUNT(*) FILTER (WHERE c.is_default AND c.is_active) = 0
  ),
  ranked AS (
    SELECT c.org_id, c.id,
           ROW_NUMBER() OVER (
             PARTITION BY c.org_id
             ORDER BY COUNT(p.id) DESC, c.created_at ASC, c.id ASC
           ) AS rn
      FROM public.fiscal_calendars c
      LEFT JOIN public.accounting_periods p
        ON p.fiscal_calendar_id = c.id AND p.org_id = c.org_id
      JOIN target_orgs t ON t.org_id = c.org_id
     WHERE c.is_active
     GROUP BY c.org_id, c.id, c.created_at
  )
  UPDATE public.fiscal_calendars c
  SET is_default = true, updated_at = now()
  FROM ranked w
  WHERE c.org_id = w.org_id AND c.id = w.id AND w.rn = 1;

  -- Orgs whose calendars are ALL inactive: nothing safe to promote.
  SELECT array_agg(DISTINCT c.org_id) INTO inactive_only
  FROM public.fiscal_calendars c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.fiscal_calendars a
     WHERE a.org_id = c.org_id AND a.is_active
  )
  AND EXISTS (
    SELECT 1 FROM public.accounting_periods p WHERE p.org_id = c.org_id
  );
  IF array_length(inactive_only, 1) > 0 THEN
    RAISE EXCEPTION 'orgs hold periods but every fiscal calendar is inactive, so no default can post: % — reactivate one calendar per org from the close screen first',
      array_to_string(inactive_only, ', ');
  END IF;
END $$;
