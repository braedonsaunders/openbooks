-- OpenBooks forward migration 0089_asset_category_policy_guard.
-- Category policy is historical accounting configuration after its first use.
-- Preserve all rows; corrections require a new category or controlled adjustment.
CREATE OR REPLACE FUNCTION public.asset_category_policy_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.org_id, NEW.asset_account_id,
         NEW.accumulated_depreciation_account_id, NEW.depreciation_expense_account_id,
         NEW.gain_loss_account_id, NEW.default_method, NEW.default_depreciation_method_id,
         NEW.default_life_months, NEW.default_convention)
     IS NOT DISTINCT FROM
     ROW(OLD.id, OLD.org_id, OLD.asset_account_id,
         OLD.accumulated_depreciation_account_id, OLD.depreciation_expense_account_id,
         OLD.gain_loss_account_id, OLD.default_method, OLD.default_depreciation_method_id,
         OLD.default_life_months, OLD.default_convention) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.fixed_assets a
     WHERE a.org_id = OLD.org_id AND a.category_id = OLD.id
       AND (EXISTS (
         SELECT 1 FROM public.depreciation_schedules s
         JOIN public.depreciation_schedule_lines l ON l.org_id = s.org_id AND l.schedule_id = s.id
          WHERE s.org_id = a.org_id AND s.asset_id = a.id AND l.posted_amount IS NOT NULL
       ) OR EXISTS (
         SELECT 1 FROM public.asset_events e
         JOIN public.journal_entries j ON j.org_id = e.org_id AND j.id = e.journal_entry_id
          WHERE e.org_id = a.org_id AND e.asset_id = a.id AND j.status IN ('posted', 'reversed')
       ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'asset_category_posted_policy',
      MESSAGE = 'Asset category accounting policy is fixed after financial history exists. Create a new category or use a controlled adjustment.';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS asset_category_policy_guard ON public.asset_categories;
CREATE TRIGGER asset_category_policy_guard BEFORE UPDATE ON public.asset_categories
FOR EACH ROW EXECUTE FUNCTION public.asset_category_policy_guard();
