-- OpenBooks forward migration 0245_price_level_guard_sandbox_wipe.
--
-- 0244 gave every org a base price level from an AFTER INSERT trigger on orgs
-- and guarded it with price_level_base_guard, which refuses to delete a base
-- row unconditionally. Every wipe path deletes org-scoped rows wholesale, so
-- that guard stopped them all: the sandbox clone/refresh/reset engine failed
-- with `delete from "price_levels" ...` and the scratch-org fixture teardown
-- failed for EVERY tenant, not only ones that configured pricing.
--
-- Guards that protect operator intent must still yield to a wipe, which is not
-- an edit. The exemption goes through openbooks_sandbox_wipe_allowed, the
-- canonical helper: it is true only when the transaction-local wipe GUC is on
-- AND the target organization is itself a sandbox, so an ordinary session that
-- somehow set the GUC still cannot delete a production org's base level. It is
-- DELETE-only, like every other exemption 0078 authorizes; an UPDATE that
-- demotes a base level is an edit and still refuses.
--
-- Nothing else about the guard changes: an ordinary delete of a base price
-- level, and every in-use check, refuse exactly as before.

CREATE OR REPLACE FUNCTION public.protect_org_base_price_level() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.is_base THEN
      RAISE EXCEPTION 'The organization base price level must remain active; edit its name or add another price level instead';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.customer_price_level_assignments assignment
       WHERE assignment.org_id = OLD.org_id AND assignment.price_level_id = OLD.id AND assignment.is_active
      UNION ALL
      SELECT 1 FROM public.item_price_schedules schedule
       WHERE schedule.org_id = OLD.org_id AND schedule.price_level_id = OLD.id AND schedule.is_active
    ) THEN
      RAISE EXCEPTION 'Price level % is still in use; deactivate its customer assignments and item pricing schedules first', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_base AND (NOT NEW.is_base OR NOT NEW.is_active OR NEW.org_id <> OLD.org_id) THEN
    RAISE EXCEPTION 'The organization base price level must remain active; edit its name or add another price level instead';
  END IF;
  IF OLD.is_active AND NOT NEW.is_active AND EXISTS (
    SELECT 1 FROM public.customer_price_level_assignments assignment
     WHERE assignment.org_id = OLD.org_id AND assignment.price_level_id = OLD.id AND assignment.is_active
    UNION ALL
    SELECT 1 FROM public.item_price_schedules schedule
     WHERE schedule.org_id = OLD.org_id AND schedule.price_level_id = OLD.id AND schedule.is_active
  ) THEN
    RAISE EXCEPTION 'Price level % is still in use; deactivate its customer assignments and item pricing schedules first', OLD.id;
  END IF;
  RETURN NEW;
END;
$func$;

-- The sibling customer_roles guard from 0244 is already conditional on live
-- assignments and schedules, which the generic child passes clear first, so it
-- needs no bypass.

-- Second half of the same incompatibility. 0244 also seeds a base price level
-- from an AFTER INSERT trigger on orgs. A sandbox org's rows are CLONED from
-- its production parent — price_levels among them — so the seed raced the
-- clone and lost: `price_levels_one_base` (unique on org_id where is_base and
-- is_active) rejected the cloned base, and every create/refresh/reset of every
-- sandbox tier failed on `insert into "price_levels"`.
--
-- The condition is read off the row rather than from a GUC a caller must
-- remember to set: an org with sandbox_of is by definition supplied by its
-- parent's clone, and seeding it a row the clone is about to bring is wrong
-- whoever inserts it. Ordinary orgs are unaffected.

CREATE OR REPLACE FUNCTION public.create_org_base_price_level() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  IF NEW.sandbox_of IS NOT NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.price_levels (org_id, code, name, is_base, is_active)
  VALUES (NEW.id, 'BASE', 'Base price', true, true);
  RETURN NEW;
END;
$func$;
