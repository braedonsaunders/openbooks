-- OpenBooks forward migration 0247_customer_role_guard_sandbox_wipe.
--
-- 0245 exempted price_level_base_guard from a sandbox wipe but asserted in a
-- comment that its sibling was safe without one:
--
--   "The sibling customer_roles guard from 0244 is already conditional on live
--    assignments and schedules, which the generic child passes clear first, so
--    it needs no bypass."
--
-- That is false. `protect_pricing_customer_role` refuses DELETE when the
-- customer holds an active customer_price_level_assignment OR an active
-- item_price_schedules row. The generic wipe removes customer_roles at
-- deletion-order position 94 and item_price_schedules at position 218 — no FK
-- references customer_roles, so nothing orders the schedules first — so the
-- guard fires while the schedules still exist. Reproduced against a database
-- bootstrapped at 0246: a sandbox wipe whose org holds one active customer role
-- and one active item price schedule for that customer raises
--
--   Customer <id> has active pricing; deactivate its price-level assignments
--   and item pricing schedules first
--
-- and the clone/refresh/reset/delete of that sandbox fails exactly as 0245's
-- price-level failure did. The claim was a promise about an absent mechanism:
-- there is no code to contradict it, so it passed review.
--
-- The fix mirrors 0245: DELETE yields to a wipe, which is not an edit, through
-- the canonical openbooks_sandbox_wipe_allowed helper (true only when the
-- transaction-local wipe GUC is on AND the target org is itself a sandbox). An
-- ordinary delete, and the UPDATE that deactivates a customer role, still
-- refuse exactly as before.
--
-- 0245's text is left in place: migrations are immutable once applied, and any
-- database may already carry its digest. This migration is the correction.

CREATE OR REPLACE FUNCTION public.protect_pricing_customer_role() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.is_active AND EXISTS (
      SELECT 1 FROM public.customer_price_level_assignments assignment
       WHERE assignment.org_id = OLD.org_id AND assignment.customer_id = OLD.party_id AND assignment.is_active
      UNION ALL
      SELECT 1 FROM public.item_price_schedules schedule
       WHERE schedule.org_id = OLD.org_id AND schedule.customer_id = OLD.party_id AND schedule.is_active
    ) THEN
      RAISE EXCEPTION 'Customer % has active pricing; deactivate its price-level assignments and item pricing schedules first', OLD.party_id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_active AND NOT NEW.is_active AND EXISTS (
    SELECT 1 FROM public.customer_price_level_assignments assignment
     WHERE assignment.org_id = OLD.org_id AND assignment.customer_id = OLD.party_id AND assignment.is_active
    UNION ALL
    SELECT 1 FROM public.item_price_schedules schedule
     WHERE schedule.org_id = OLD.org_id AND schedule.customer_id = OLD.party_id AND schedule.is_active
  ) THEN
    RAISE EXCEPTION 'Customer % has active pricing; deactivate its price-level assignments and item pricing schedules first', OLD.party_id;
  END IF;
  RETURN NEW;
END;
$func$;