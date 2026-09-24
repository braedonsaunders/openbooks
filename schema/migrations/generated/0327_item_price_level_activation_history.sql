-- OpenBooks forward migration 0327_item_price_level_activation_history.
--
-- resolveItemPrice reads the customer's level assignment and the level row
-- with their CURRENT activation flags, although assignments and schedules
-- carry effective windows and 0301 retains schedule history: deactivating a
-- Gold assignment or the Gold level in March moved a legitimate late January
-- transaction off Gold onto the base price. Activation is current state in
-- the old model, so history cannot answer "was Gold offered on January 15".
--
-- Two changes, matching the two halves of the defect:
--
-- (a) Level activation becomes versioned history. New table
--     price_level_activation_history keeps one [active_from, active_to)
--     period per activation (active_to NULL while open), maintained by a
--     trigger off price_levels inserts and is_active flips, backfilled open.
--     A level is a standing offer: the first period opens at -infinity
--     because creation is not withdrawal — the human-dated schedule and
--     assignment windows carry the real dating (a level created today with
--     a backdated January schedule prices January; deactivation is what can
--     end coverage, never creation). The resolver uses the period covering
--     the transaction date for past dates and the current flag for today
--     and the future (a dead level must not price new work). Reactivations
--     open a new period dated from the reactivation, so the gap between
--     deactivation and reactivation stays correctly dark.
--     Residual, stated: levels deactivated BEFORE this upgrade get one open
--     period from creation, so they read active for past dates after their
--     real deactivation too — the deactivation instant was never recorded
--     and cannot be reconstructed. Current dates are unaffected (the flag
--     governs them).
-- (b) Assignment membership becomes end-dated. Deactivating an effective
--     customer_price_level_assignments row now end-dates it (effective_to =
--     yesterday) instead of only flipping the flag, and the resolver matches
--     assignments by window coverage alone — never by current activation.
--     An explicitly end-dated row is left alone; reactivating an ended row
--     does not silently reopen its window (the operator extends it
--     explicitly, visibly). A revocation before the row ever started
--     (effective_from = today or later) never covered any date, so
--     end-dating it to yesterday would violate the dates CHECK (today) or
--     leave a live future window on a dead row: the trigger removes the row
--     instead (PRC15c for today, PRC15d for future starts). Backfill:
--     inactive rows with an open window are end-dated to the day before
--     their last touch (the deactivation is the only write such rows
--     receive), floored at effective_from so the dates CHECK holds —
--     except never-effective rows, which are removed with their before-image
--     audited, to match the trigger.
--
-- Re-runnable: table and trigger are IF NOT EXISTS-guarded; the backfills
-- only fill gaps (no open period / still-open inactive window /
-- never-effective half-revocation), so replay changes nothing.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS public.price_level_activation_history (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  price_level_id uuid NOT NULL,
  active_from date NOT NULL,
  active_to date,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT price_level_activation_history_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT price_level_activation_history_level_fk FOREIGN KEY (org_id, price_level_id)
    REFERENCES public.price_levels (org_id, id),
  CONSTRAINT price_level_activation_history_window CHECK (active_to IS NULL OR active_to >= active_from)
);
CREATE INDEX IF NOT EXISTS price_level_activation_history_lookup
  ON public.price_level_activation_history (org_id, price_level_id, active_from);

ALTER TABLE ONLY public.price_level_activation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.price_level_activation_history FORCE ROW LEVEL SECURITY;
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'price_level_activation_history' AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.price_level_activation_history
      USING ((current_setting('app.bypass_rls', true) = 'on') OR (org_id::text = current_setting('app.current_org', true)))
      WITH CHECK ((current_setting('app.bypass_rls', true) = 'on') OR (org_id::text = current_setting('app.current_org', true)));
  END IF;
END;
$policy$;

COMMENT ON TABLE public.price_level_activation_history IS 'Versioned price-level activation: one [active_from, active_to) period per activation (0327). Historical pricing reads the period covering the transaction date; the live is_active flag governs today and the future only.';
COMMENT ON COLUMN public.price_level_activation_history.active_to IS 'First inactive date (exclusive bound). NULL while the activation is open.';

CREATE OR REPLACE FUNCTION public.price_level_activation_maintenance() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A level born inactive was never offered: no period until activated.
    -- Otherwise the standing offer opens at -infinity (see above): creation
    -- must not end coverage of human-backdated schedules.
    IF NEW.is_active THEN
      INSERT INTO public.price_level_activation_history (org_id, price_level_id, active_from)
      VALUES (NEW.org_id, NEW.id, '-infinity'::date);
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.is_active AND NOT NEW.is_active THEN
    UPDATE public.price_level_activation_history
       SET active_to = current_date, updated_at = now()
     WHERE org_id = NEW.org_id AND price_level_id = NEW.id AND active_to IS NULL;
  ELSIF NOT OLD.is_active AND NEW.is_active THEN
    INSERT INTO public.price_level_activation_history (org_id, price_level_id, active_from)
    SELECT NEW.org_id, NEW.id, current_date
     WHERE NOT EXISTS (
       SELECT 1 FROM public.price_level_activation_history h
        WHERE h.org_id = NEW.org_id AND h.price_level_id = NEW.id AND h.active_to IS NULL
     );
  END IF;
  RETURN NEW;
END;
$func$;

DO $trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'price_level_activation_tracking') THEN
    CREATE TRIGGER price_level_activation_tracking
      AFTER INSERT OR UPDATE OF is_active ON public.price_levels
      FOR EACH ROW EXECUTE FUNCTION public.price_level_activation_maintenance();
  END IF;
END;
$trigger$;

-- One open standing-offer period per level (see the stated residual for
-- levels deactivated before this upgrade).
INSERT INTO public.price_level_activation_history (org_id, price_level_id, active_from)
SELECT l.org_id, l.id, '-infinity'::date
  FROM public.price_levels l
 WHERE NOT EXISTS (
   SELECT 1 FROM public.price_level_activation_history h
    WHERE h.org_id = l.org_id AND h.price_level_id = l.id
 );

-- End-dated membership: deactivating an effective assignment closes its
-- window instead of only flipping the flag, so the resolver's window read
-- stays truthful for both past and current dates.
CREATE OR REPLACE FUNCTION public.customer_price_level_end_date_on_deactivate() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  -- Only a still-open window can be revoked into history or removed; an
  -- already-closed window stays exactly as the operator left it, so late
  -- transactions inside it keep pricing off it.
  IF NEW.effective_to IS NULL OR NEW.effective_to >= current_date THEN
    -- Revoked before it ever started (today or later): never effective, so
    -- end-dating would either violate customer_price_level_dates (today) or
    -- leave a live future window on a dead row. Remove it instead; no
    -- transaction could have priced off it, so no pricing history is lost —
    -- but the removal is audited with the row's before-image, never silent
    -- (PRC15d). The delete and its audit run as the deactivating role under
    -- the same org_isolation predicate that permitted the update, and the
    -- caller observes zero updated rows and must report the revocation as
    -- the delete it was (see updateSetupRecord). (PRC15c for today, PRC15d
    -- for future starts.)
    IF NEW.effective_from >= current_date THEN
      INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
      VALUES (NEW.org_id, 'customer_price_level_assignments', NEW.id, 'delete',
              jsonb_build_object('before', to_jsonb(OLD)), NEW.updated_by);
      DELETE FROM public.customer_price_level_assignments
       WHERE org_id = NEW.org_id AND id = NEW.id;
      RETURN NULL;
    END IF;
    NEW.effective_to := current_date - 1;
  END IF;
  RETURN NEW;
END;
$func$;

DO $trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'customer_price_level_end_date_tracking') THEN
    CREATE TRIGGER customer_price_level_end_date_tracking
      BEFORE UPDATE OF is_active ON public.customer_price_level_assignments
      FOR EACH ROW WHEN (OLD.is_active AND NOT NEW.is_active)
      EXECUTE FUNCTION public.customer_price_level_end_date_on_deactivate();
  END IF;
END;
$trigger$;

-- Repair pre-upgrade deactivations: an inactive row with an open window was
-- flipped without end-dating, so it would read as covering today. End-date
-- it to the day before its last touch (see the stated residuals).
--
-- Never-effective half-revocations converge to the trigger's post-upgrade
-- meaning: an inactive row starting today or later with an open window never
-- priced anything, and end-dating it would violate customer_price_level_dates
-- (today) or leave a live future window on a dead row, so the upgrade
-- removes it instead of flooring it at a single live day — audited with the
-- before-image like the trigger's own removals. (PRC15c for today, PRC15d
-- for future starts.)
WITH removed AS (
  DELETE FROM public.customer_price_level_assignments a
   WHERE NOT a.is_active
     AND a.effective_from >= current_date
     AND (a.effective_to IS NULL OR a.effective_to >= current_date)
  RETURNING a.*
)
INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
SELECT removed.org_id, 'customer_price_level_assignments', removed.id, 'delete',
       jsonb_build_object('before', to_jsonb(removed)), removed.updated_by
  FROM removed;
UPDATE public.customer_price_level_assignments a
   SET effective_to = GREATEST(a.updated_at::date - 1, a.effective_from)
 WHERE NOT a.is_active
   AND (a.effective_to IS NULL OR a.effective_to >= current_date);
