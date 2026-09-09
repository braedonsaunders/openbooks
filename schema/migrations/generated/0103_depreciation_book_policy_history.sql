-- Book overrides are historical accounting policy under the same contract as
-- asset categories (0089). No tenant data or posted evidence is rewritten.
CREATE OR REPLACE FUNCTION public.depreciation_book_policy_history_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.orgs WHERE id = OLD.org_id) THEN
    RETURN OLD; -- Permit the owning tenant's cascade, not ordinary policy deletion.
  END IF;
  IF TG_OP = 'UPDATE' AND
     ROW(NEW.id, NEW.org_id, NEW.book_id, NEW.category_id, NEW.method,
         NEW.depreciation_method_id, NEW.life_months, NEW.rate_percent, NEW.units_total, NEW.convention)
     IS NOT DISTINCT FROM
     ROW(OLD.id, OLD.org_id, OLD.book_id, OLD.category_id, OLD.method,
         OLD.depreciation_method_id, OLD.life_months, OLD.rate_percent, OLD.units_total, OLD.convention) THEN
    RETURN NEW;
  END IF;

  -- Builders/posters take this same fence. They must read policy by MVCC,
  -- without a policy tuple lock: UPDATE already owns that tuple before its
  -- trigger executes and may be waiting here for a builder to finish.
  PERFORM 1 FROM public.asset_categories c
   WHERE (TG_OP <> 'INSERT' AND c.org_id = OLD.org_id AND c.id = OLD.category_id)
      OR (TG_OP <> 'DELETE' AND c.org_id = NEW.org_id AND c.id = NEW.category_id)
   ORDER BY c.org_id, c.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.fixed_assets a
     WHERE ((TG_OP <> 'INSERT' AND a.org_id = OLD.org_id AND a.category_id = OLD.category_id)
         OR (TG_OP <> 'DELETE' AND a.org_id = NEW.org_id AND a.category_id = NEW.category_id))
       AND (EXISTS (
       SELECT 1 FROM public.depreciation_schedules s
       JOIN public.depreciation_schedule_lines l ON l.org_id = s.org_id AND l.schedule_id = s.id
        WHERE s.org_id = a.org_id AND s.asset_id = a.id AND l.posted_amount IS NOT NULL
          AND ((TG_OP <> 'INSERT' AND a.org_id = OLD.org_id AND a.category_id = OLD.category_id AND s.book_id = OLD.book_id)
            OR (TG_OP <> 'DELETE' AND a.org_id = NEW.org_id AND a.category_id = NEW.category_id AND s.book_id = NEW.book_id))
     ) OR EXISTS (
       SELECT 1 FROM public.asset_events e
       JOIN public.journal_entries j ON j.org_id = e.org_id AND j.id = e.journal_entry_id
        WHERE e.org_id = a.org_id AND e.asset_id = a.id AND j.status IN ('posted', 'reversed')
          AND ((TG_OP <> 'INSERT' AND a.org_id = OLD.org_id AND a.category_id = OLD.category_id AND j.book_id = OLD.book_id)
            OR (TG_OP <> 'DELETE' AND a.org_id = NEW.org_id AND a.category_id = NEW.category_id AND j.book_id = NEW.book_id))
     ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'depreciation_book_posted_policy',
      MESSAGE = 'Depreciation book accounting policy is fixed after financial history exists. Create a new category or use a controlled adjustment.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS depreciation_book_policy_history_guard ON public.depreciation_book_policies;
CREATE TRIGGER depreciation_book_policy_history_guard BEFORE INSERT OR UPDATE OR DELETE ON public.depreciation_book_policies
FOR EACH ROW EXECUTE FUNCTION public.depreciation_book_policy_history_guard();
