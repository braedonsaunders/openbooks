-- OpenBooks forward migration 0069_lease_cancelled_lines_accumulation.
--
-- Migration 0060 repaired overlapping base-rent windows in an anonymous DO
-- block.  Its cancellation counter was assigned from each pass, so the NOTICE
-- reported only the final conflict's cancelled lines.  0060 is already
-- applied in production and is immutable; editing it cannot change a live
-- database and replaying its historical repair would rewrite tenant data.
--
-- Install the corrected repair as a callable function instead.  Installation
-- is deliberately the only action performed by this migration: it does not
-- invoke the repair or revisit any existing lease, schedule line, invoice, or
-- audit evidence.  A maintenance operator can call the function explicitly
-- only when a pre-enforcement dataset needs the same deterministic repair.
-- The function is idempotent after a successful pass: resolved conflicts no
-- longer match the loop, and already-invoiced/credited schedule evidence is
-- never cancelled or deleted.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.lease_charges_base_rent_repair()
RETURNS TABLE (
  windows_closed integer,
  shadows_deleted integer,
  lines_cancelled integer
)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $lease_charges_base_rent_repair$
DECLARE
  v_conflict record;
  v_older_billed integer;
  v_newer_billed integer;
  v_windows_closed integer := 0;
  v_shadows_deleted integer := 0;
  v_lines_cancelled integer := 0;
BEGIN
  -- Resolve one chronologically-first conflict per pass so every decision
  -- sees the state the previous one produced (0051 ownership-repair pattern).
  LOOP
    SELECT first_charge.id AS older_id, second_charge.id AS newer_id,
           second_charge.effective_from AS newer_from,
           second_charge.effective_from > first_charge.effective_from AS distinct_start
      INTO v_conflict
      FROM public.lease_charges first_charge
      JOIN public.lease_charges second_charge
        ON second_charge.org_id = first_charge.org_id
       AND second_charge.lease_id = first_charge.lease_id
       AND second_charge.charge_type = 'base_rent'
       AND (second_charge.effective_from, second_charge.id) > (first_charge.effective_from, first_charge.id)
     WHERE first_charge.charge_type = 'base_rent'
       AND coalesce(first_charge.effective_to, 'infinity'::date) >= second_charge.effective_from
     ORDER BY first_charge.lease_id, second_charge.effective_from, second_charge.id, first_charge.id
     LIMIT 1;
    EXIT WHEN NOT FOUND;

    IF v_conflict.distinct_start THEN
      -- Distinct starts: the successor supersedes.  Close the older window the
      -- day before the successor begins — exactly what applying an escalation
      -- already does to the canon.
      UPDATE public.lease_charges
         SET effective_to = v_conflict.newer_from - 1, updated_at = now()
       WHERE id = v_conflict.older_id;
      v_windows_closed := v_windows_closed + 1;

      -- Retire the older row's unbilled future coverage that no longer has a
      -- contractual window, keeping every invoiced line as history.
      WITH cancelled AS (
        UPDATE public.lease_schedule_lines s
           SET status = 'cancelled', updated_at = now()
          FROM public.lease_charges c
         WHERE c.id = v_conflict.older_id
           AND s.org_id = c.org_id
           AND s.charge_id = c.id
           AND s.status = 'scheduled'
           AND s.period_starts_on >= v_conflict.newer_from
        RETURNING s.id
      )
      -- This is the corrective behavior: each conflict contributes to the
      -- running total instead of replacing the prior pass's count.
      SELECT v_lines_cancelled + count(*) INTO v_lines_cancelled FROM cancelled;

      UPDATE public.lease_schedule_lines s
         SET period_ends_on = v_conflict.newer_from - 1,
             amount = round((s.amount * ((v_conflict.newer_from - 1 - s.period_starts_on + 1)::numeric
                                         / (s.period_ends_on - s.period_starts_on + 1))), 4),
             updated_at = now()
       WHERE s.charge_id = v_conflict.older_id
         AND s.org_id = (SELECT org_id FROM public.lease_charges WHERE id = v_conflict.older_id)
         AND s.status = 'scheduled'
         AND s.period_starts_on < v_conflict.newer_from
         AND s.period_ends_on >= v_conflict.newer_from;
    ELSE
      -- Same-start duplicates: only one row may own the shared window. Billed
      -- history always wins; ties fall to the newest row (uuidv7 ids sort by
      -- creation time), as 0051 kept shadow duplicates.
      SELECT
        count(*) FILTER (WHERE s.status IN ('invoiced', 'credited') AND c.id = v_conflict.older_id),
        count(*) FILTER (WHERE s.status IN ('invoiced', 'credited') AND c.id = v_conflict.newer_id)
        INTO v_older_billed, v_newer_billed
        FROM (VALUES (v_conflict.older_id), (v_conflict.newer_id)) AS pair(id)
        JOIN public.lease_charges c ON c.id = pair.id
        LEFT JOIN public.lease_schedule_lines s ON s.charge_id = c.id AND s.org_id = c.org_id;

      DECLARE
        v_loser uuid := CASE WHEN v_older_billed > v_newer_billed THEN v_conflict.newer_id ELSE v_conflict.older_id END;
        v_loser_lines integer;
      BEGIN
        SELECT count(*) INTO v_loser_lines
          FROM public.lease_schedule_lines
         WHERE charge_id = v_loser
           AND org_id = (SELECT org_id FROM public.lease_charges WHERE id = v_loser);
        IF v_loser_lines > 0 THEN
          RAISE EXCEPTION 'lease_charges repair: base-rent rows % and % share effective_from % and both hold schedule-line history — resolve them manually before migrating',
            v_conflict.older_id, v_conflict.newer_id, v_conflict.newer_from;
        END IF;
        DELETE FROM public.lease_charges WHERE id = v_loser;
        v_shadows_deleted := v_shadows_deleted + 1;
      END;
    END IF;
  END LOOP;

  RAISE NOTICE 'lease_charges repair: % overlapping window(s) closed before successor, % orphanless duplicate(s) deleted, % future scheduled line(s) cancelled',
    v_windows_closed, v_shadows_deleted, v_lines_cancelled;
  windows_closed := v_windows_closed;
  shadows_deleted := v_shadows_deleted;
  lines_cancelled := v_lines_cancelled;
  RETURN NEXT;
END
$lease_charges_base_rent_repair$;

COMMENT ON FUNCTION public.lease_charges_base_rent_repair() IS
  'openbooks:lease_charges_base_rent_repair:v2 - explicit, idempotent maintenance repair for pre-0060 overlaps; migration 0069 installs but never invokes it, and each conflict contributes to the cumulative cancelled-line total while billed evidence remains untouched';

-- This maintenance repair is not an application write path.  Keep it out of
-- the default PUBLIC function ACL so only the migration owner (or an explicit
-- maintenance grant) can invoke a data-changing repair.
REVOKE EXECUTE ON FUNCTION public.lease_charges_base_rent_repair() FROM PUBLIC;
