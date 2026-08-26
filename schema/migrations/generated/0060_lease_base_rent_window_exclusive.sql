-- OpenBooks forward migration 0060_lease_base_rent_window_exclusive.
--
-- lease_charges accepted any caller-supplied charge_type without excluding
-- base_rent, and the table carried only amount/frequency/type/window CHECK
-- constraints — nothing stopped a second base-rent row overlapping the
-- canonical one beside it (or an open-ended original), and neither could any
-- BEFORE-trigger read under READ COMMITTED: two concurrent writers are
-- mutually invisible until commit. scheduleLeaseCharges iterates every charge
-- row and billDueLeaseCharges consumes every due schedule line, so both rent
-- streams generated invoice lines and the tenant was billed two rents for the
-- same period.
--
-- The generic addCharge surface is closed at the service layer; the storage
-- boundary below covers every writer that remains legitimate (lease creation,
-- controlled escalations) plus direct SQL:
--
--   1. repair rows only a lost race or the old generic API could have
--      produced — earlier windows close the day before their successor and
--      the successor's stream wins going forward (the same supersede
--      semantics applyLeaseEscalation already uses). Loser-side schedule
--      lines keep their committed invoices untouched; only still-unbilled
--      scheduled lines beyond the new closure are prorated or cancelled, so
--      no billed history is ever deleted. Same-start duplicates resolve to a
--      single owner: whichever side carries billed history keeps the shared
--      start, otherwise the newest row does; an ownerless schedule-line
--      shadow is deleted outright, and any same-start duplicate still holding
--      schedule-line history aborts loudly rather than guessing which posted
--      evidence is authoritative, mirroring 0051's posture;
--   2. add one partial GiST exclusion constraint over (org_id, lease_id)
--      identity with inclusive daterange overlap, scoped to base_rent rows.
--      Unlike an API precheck, the constraint arbitrates the race in the
--      index: the second writer waits on the first transaction and is
--      rejected the moment it commits. Adjacent windows — a charge closed at
--      day X-1 and its escalation starting at X — do not overlap and remain
--      exactly how escalations version the canon.
--
-- The whole file runs in one bootstrap transaction: no external writer ever
-- observes an enforcement gap.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- btree_gist ships the UUID/date equality operator classes the constraint
-- needs; 0051 already made it mandatory on fresh installs, IF NOT EXISTS
-- keeps this migration self-contained regardless of application order.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

DO $lease_charges_base_rent_repair$
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
      -- Distinct starts: the successor supersedes. Close the older window the
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
      SELECT count(*) INTO v_lines_cancelled FROM cancelled;

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
END
$lease_charges_base_rent_repair$;

ALTER TABLE public.lease_charges
  ADD CONSTRAINT lease_charges_base_rent_no_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    lease_id WITH =,
    (daterange(effective_from, effective_to, '[]')) WITH &&
  )
  WHERE (charge_type = 'base_rent');

COMMENT ON CONSTRAINT lease_charges_base_rent_no_overlap
  ON public.lease_charges IS
  'openbooks:lease_charges_base_rent_no_overlap:v1 - one base-rent window per lease; escalations supersede adjacent windows, inclusive ranges treat NULL effective_to as open-ended';
