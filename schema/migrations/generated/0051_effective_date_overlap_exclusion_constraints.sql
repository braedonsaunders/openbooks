-- OpenBooks forward migration 0051_effective_date_overlap_exclusion_constraints.
--
-- Nine effective-date overlap guards were BEFORE-trigger SELECT EXISTS checks
-- (fair_value_prices, field_ticket_policies, item_rate_book_assignments,
-- item_rate_versions, labor_cost_rates, overhead_rates,
-- subsidiary_ownership_interests, tax_registrations, and
-- project_financial_profile_versions). Under READ COMMITTED two concurrent
-- writers each see only committed rows, so two overlapping uncommitted rows
-- are mutually invisible and BOTH pass their trigger — leaving parallel
-- authoritative prices, wage rates, ownership policies, tax registrations, or
-- project/field policy after both commit. A trigger re-reading the table can
-- never close that window; only storage-side enforcement can.
--
-- Each guard is replaced by a GiST exclusion constraint combining scalar
-- equality for the business key (nullable keys folded onto sentinels, the
-- same coalesce convention the baseline's unique indexes already use) with
-- date-range overlap. Unlike the triggers, exclusion constraints arbitrate
-- the race in the index: the second writer waits on the first transaction
-- and is rejected the moment it commits.
--
-- tax_rates (its own defect) and income_tax_rates (0002) are deliberately
-- untouched here.
--
-- Rollout order matters and is intentional:
--   1. retire the racy overlap checks (drop the six single-duty triggers,
--      replace the three multi-duty trigger bodies with their remaining
--      duties intact) so the data repair below cannot trip per-row trigger
--      re-reads of rows the same repair statement is still closing;
--   2. repair rows that only a lost race could have produced — shadow
--      duplicates at the same effective start are deactivated (deleted for
--      overhead_rates, which has no is_active flag and no dependents), and
--      overlapping ranges are closed to the day before their successor.
--      Consolidation-referenced ownership policies are never rewritten:
--      an unreferenced side of a conflict is closed or deactivated instead,
--      and a conflict between two referenced policies aborts loudly rather
--      than guessing which posted consolidation history is authoritative;
--   3. add the constraints, which now see a repaired, representable state.
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

-- UUID/text/date equality operator classes for GiST come from btree_gist.
-- Mandatory for the same reason as 0023: silently omitting it would silently
-- omit money-configuration invariants.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

--
-- 1. Retire the racy overlap checks.
--

DROP TRIGGER fair_value_prices_no_overlap ON public.fair_value_prices;
DROP FUNCTION public.fair_value_prices_no_overlap_guard();

DROP TRIGGER field_ticket_policy_integrity ON public.field_ticket_policies;
DROP FUNCTION public.field_ticket_policy_guard();
CREATE FUNCTION public.field_ticket_policy_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.customer_party_id is not null and not exists (
    select 1 from parties p
     where p.id = new.customer_party_id and p.org_id = new.org_id
  ) then
    raise exception 'field ticket customer policy must belong to the same organization'
      using errcode = '23514';
  end if;
  if new.project_id is not null and not exists (
    select 1 from projects p
     where p.id = new.project_id and p.org_id = new.org_id
  ) then
    raise exception 'field ticket project policy must belong to the same organization'
      using errcode = '23514';
  end if;
  -- Effective-window exclusivity is owned by the
  -- field_ticket_policies_no_active_overlap exclusion constraint (0051),
  -- which stays correct under concurrent READ COMMITTED writers.
  return new;
end $$;

COMMENT ON FUNCTION public.field_ticket_policy_guard() IS
  'openbooks:field_ticket_policy_guard:v2 - tenant-integrity checks for Field Ticket policies; effective-window exclusivity moved to the field_ticket_policies_no_active_overlap exclusion constraint';

DROP TRIGGER item_rate_book_assignments_no_overlap ON public.item_rate_book_assignments;
DROP FUNCTION public.item_rate_book_assignments_no_overlap_guard();

DROP TRIGGER item_rate_versions_no_overlap ON public.item_rate_versions;
DROP FUNCTION public.item_rate_versions_no_overlap_guard();

DROP TRIGGER labor_cost_rates_no_overlap ON public.labor_cost_rates;
DROP FUNCTION public.labor_cost_rates_no_overlap_guard();

DROP TRIGGER overhead_rates_no_overlap ON public.overhead_rates;
DROP FUNCTION public.overhead_rates_no_overlap_guard();

DROP TRIGGER ownership_interest_guard ON public.subsidiary_ownership_interests;
DROP FUNCTION public.ownership_interest_guard();
CREATE FUNCTION public.ownership_interest_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare actual_parent uuid; bad_account boolean;
begin
  select parent_id into actual_parent from subsidiaries where id=new.subsidiary_id and org_id=new.org_id and is_active and not is_elimination;
  if actual_parent is distinct from new.parent_subsidiary_id or not exists (select 1 from subsidiaries where id=new.parent_subsidiary_id and org_id=new.org_id and is_active and not is_elimination) then raise exception 'ownership interest must follow the active tenant consolidation hierarchy'; end if;
  -- Effective-date exclusivity is owned by the
  -- subsidiary_ownership_interests_no_active_overlap exclusion constraint
  -- (0051). Used-policy immutability below is unchanged.
  select exists (select 1 from unnest(array_remove(array[new.investment_account_id,new.equity_income_account_id,new.distribution_account_id,new.distribution_income_account_id,new.nci_equity_account_id,new.nci_income_account_id,new.goodwill_account_id,new.fair_value_adjustment_account_id],null)) wanted(id) where not exists (select 1 from accounts a where a.id=wanted.id and a.org_id=new.org_id and a.is_active and not a.is_summary)) into bad_account;
  if bad_account then raise exception 'ownership accounts must be active postable accounts in the tenant'; end if;
  if new.method='full' and new.ownership_percent<100 and (new.nci_equity_account_id is null or new.nci_income_account_id is null) then raise exception 'full consolidation below 100 percent requires NCI equity and income accounts'; end if;
  if new.method='full' and (new.goodwill_account_id is null or new.fair_value_adjustment_account_id is null) then raise exception 'full consolidation requires goodwill and fair-value adjustment accounts'; end if;
  if new.distribution_account_id is not null and new.distribution_income_account_id is null then raise exception 'distribution income account is required when a distribution account is configured'; end if;
  if tg_op='UPDATE' and exists(select 1 from ownership_consolidation_entries where interest_id=old.id) and row(new.org_id,new.parent_subsidiary_id,new.subsidiary_id,new.effective_from,new.effective_to,new.ownership_percent,new.method,new.acquisition_date,new.acquisition_cost,new.fair_value_net_assets,new.acquisition_rate,new.nci_measurement,new.nci_fair_value,new.investment_account_id,new.equity_income_account_id,new.distribution_account_id,new.distribution_income_account_id,new.nci_equity_account_id,new.nci_income_account_id,new.goodwill_account_id,new.fair_value_adjustment_account_id,new.is_active) is distinct from row(old.org_id,old.parent_subsidiary_id,old.subsidiary_id,old.effective_from,old.effective_to,old.ownership_percent,old.method,old.acquisition_date,old.acquisition_cost,old.fair_value_net_assets,old.acquisition_rate,old.nci_measurement,old.nci_fair_value,old.investment_account_id,old.equity_income_account_id,old.distribution_account_id,old.distribution_income_account_id,old.nci_equity_account_id,old.nci_income_account_id,old.goodwill_account_id,old.fair_value_adjustment_account_id,old.is_active) then raise exception 'used ownership policy is immutable; close it and create a new effective-dated policy'; end if;
  return new;
end $$;

COMMENT ON FUNCTION public.ownership_interest_guard() IS
  'openbooks:ownership_interest_guard:v2 - hierarchy, account, method, and used-policy immutability checks for ownership interests; effective-date exclusivity moved to the subsidiary_ownership_interests_no_active_overlap exclusion constraint';

DROP TRIGGER tax_registrations_no_overlap ON public.tax_registrations;
DROP FUNCTION public.tax_registrations_no_overlap_guard();

DROP TRIGGER project_financial_profile_version_guard ON public.project_financial_profile_versions;
DROP FUNCTION public.project_financial_profile_version_guard();
CREATE FUNCTION public.project_financial_profile_version_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  publish_mode boolean :=
    coalesce(current_setting('openbooks.publish_project_profile', true), 'off') = 'on';
  correction_mode boolean :=
    coalesce(current_setting('openbooks.correct_project_profile', true), 'off') = 'on';
  correction_reason text :=
    coalesce(current_setting('openbooks.project_profile_correction_reason', true), '');
BEGIN
  IF tg_op <> 'DELETE' AND NOT EXISTS (
    SELECT 1
      FROM project_types pt
     WHERE pt.id = new.project_type_id
       AND pt.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION
      'project financial profile version must belong to the project type organization';
  END IF;

  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'published project financial profile versions are immutable';
  END IF;

  IF tg_op = 'UPDATE' THEN
    IF correction_mode THEN
      IF length(btrim(correction_reason)) < 8
         OR (to_jsonb(new) - 'financial_profile' - 'updated_at' - 'updated_by')
            IS DISTINCT FROM
            (to_jsonb(old) - 'financial_profile' - 'updated_at' - 'updated_by')
      THEN
        RAISE EXCEPTION
          'controlled project financial profile correction may change only policy JSON and requires a reason';
      END IF;
    ELSIF NOT publish_mode
       OR (to_jsonb(new) - 'effective_to' - 'updated_at' - 'updated_by')
          IS DISTINCT FROM
          (to_jsonb(old) - 'effective_to' - 'updated_at' - 'updated_by')
    THEN
      RAISE EXCEPTION 'published project financial profile versions are immutable';
    END IF;
  END IF;

  -- Effective-range exclusivity is owned by the
  -- project_financial_profile_versions_no_overlap exclusion constraint
  -- (0051). Publish-mode window closing and correction-mode immutability
  -- above are unchanged.
  RETURN new;
END;
$$;

COMMENT ON FUNCTION public.project_financial_profile_version_guard() IS
  'openbooks:project_financial_profile_version_guard:v2 - publish/correct-mode immutability for project financial profile versions; effective-range exclusivity moved to the project_financial_profile_versions_no_overlap exclusion constraint';

CREATE TRIGGER field_ticket_policy_integrity BEFORE INSERT OR UPDATE ON public.field_ticket_policies FOR EACH ROW EXECUTE FUNCTION public.field_ticket_policy_guard();
CREATE TRIGGER ownership_interest_guard BEFORE INSERT OR UPDATE ON public.subsidiary_ownership_interests FOR EACH ROW EXECUTE FUNCTION public.ownership_interest_guard();
CREATE TRIGGER project_financial_profile_version_guard BEFORE INSERT OR DELETE OR UPDATE ON public.project_financial_profile_versions FOR EACH ROW EXECUTE FUNCTION public.project_financial_profile_version_guard();

--
-- 2. Repair rows only a lost race could have produced. Every step logs its
--    counts through NOTICE for audit evidence, mirroring 0002.
--

DO $fair_value_prices_repair$
DECLARE
  v_shadows_deactivated integer := 0;
  v_ranges_closed integer := 0;
BEGIN
  WITH marked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY org_id, item_id, currency,
                          coalesce(effective_from, '-infinity'::date)
             ORDER BY id DESC
           ) AS shadow_rank
      FROM public.fair_value_prices
     WHERE is_active
  ), deactivated AS (
    UPDATE public.fair_value_prices r
       SET is_active = false, updated_at = now()
      FROM marked s
     WHERE s.id = r.id
       AND s.shadow_rank > 1
     RETURNING r.id
  )
  SELECT count(*) INTO v_shadows_deactivated FROM deactivated;

  WITH ordered AS (
    SELECT id,
           lead(coalesce(effective_from, '-infinity'::date)) OVER (
             PARTITION BY org_id, item_id, currency
             ORDER BY coalesce(effective_from, '-infinity'::date), id
           ) AS next_from
      FROM public.fair_value_prices
     WHERE is_active
  ), closed AS (
    UPDATE public.fair_value_prices r
       SET effective_to = o.next_from - 1, updated_at = now()
      FROM ordered o
     WHERE o.id = r.id
       AND o.next_from IS NOT NULL
       AND o.next_from > coalesce(r.effective_from, '-infinity'::date)
       AND (r.effective_to IS NULL OR r.effective_to >= o.next_from)
     RETURNING r.id
  )
  SELECT count(*) INTO v_ranges_closed FROM closed;

  RAISE NOTICE 'fair_value_prices repair: % shadow duplicate(s) deactivated, % range(s) closed before successor',
    v_shadows_deactivated, v_ranges_closed;
END
$fair_value_prices_repair$;

DO $field_ticket_policies_repair$
DECLARE
  v_shadows_deactivated integer := 0;
  v_ranges_closed integer := 0;
BEGIN
  WITH marked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY org_id, scope,
                          coalesce(customer_party_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          effective_from
             ORDER BY id DESC
           ) AS shadow_rank
      FROM public.field_ticket_policies
     WHERE is_active
  ), deactivated AS (
    UPDATE public.field_ticket_policies r
       SET is_active = false, updated_at = now()
      FROM marked s
     WHERE s.id = r.id
       AND s.shadow_rank > 1
     RETURNING r.id
  )
  SELECT count(*) INTO v_shadows_deactivated FROM deactivated;

  WITH ordered AS (
    SELECT id,
           lead(effective_from) OVER (
             PARTITION BY org_id, scope,
                          coalesce(customer_party_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
             ORDER BY effective_from, id
           ) AS next_from
      FROM public.field_ticket_policies
     WHERE is_active
  ), closed AS (
    UPDATE public.field_ticket_policies r
       SET effective_to = o.next_from - 1, updated_at = now()
      FROM ordered o
     WHERE o.id = r.id
       AND o.next_from IS NOT NULL
       AND o.next_from > r.effective_from
       AND (r.effective_to IS NULL OR r.effective_to >= o.next_from)
     RETURNING r.id
  )
  SELECT count(*) INTO v_ranges_closed FROM closed;

  RAISE NOTICE 'field_ticket_policies repair: % shadow duplicate(s) deactivated, % range(s) closed before successor',
    v_shadows_deactivated, v_ranges_closed;
END
$field_ticket_policies_repair$;

DO $item_rate_book_assignments_repair$
DECLARE
  v_shadows_deactivated integer := 0;
  v_ranges_closed integer := 0;
BEGIN
  WITH marked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY org_id, rate_book_id,
                          coalesce(rate_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(class_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          date_basis,
                          coalesce(effective_from, '-infinity'::date)
             ORDER BY id DESC
           ) AS shadow_rank
      FROM public.item_rate_book_assignments
     WHERE is_active
  ), deactivated AS (
    UPDATE public.item_rate_book_assignments r
       SET is_active = false, updated_at = now()
      FROM marked s
     WHERE s.id = r.id
       AND s.shadow_rank > 1
     RETURNING r.id
  )
  SELECT count(*) INTO v_shadows_deactivated FROM deactivated;

  WITH ordered AS (
    SELECT id,
           lead(coalesce(effective_from, '-infinity'::date)) OVER (
             PARTITION BY org_id, rate_book_id,
                          coalesce(rate_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(class_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          date_basis
             ORDER BY coalesce(effective_from, '-infinity'::date), id
           ) AS next_from
      FROM public.item_rate_book_assignments
     WHERE is_active
  ), closed AS (
    UPDATE public.item_rate_book_assignments r
       SET effective_to = o.next_from - 1, updated_at = now()
      FROM ordered o
     WHERE o.id = r.id
       AND o.next_from IS NOT NULL
       AND o.next_from > coalesce(r.effective_from, '-infinity'::date)
       AND (r.effective_to IS NULL OR r.effective_to >= o.next_from)
     RETURNING r.id
  )
  SELECT count(*) INTO v_ranges_closed FROM closed;

  RAISE NOTICE 'item_rate_book_assignments repair: % shadow duplicate(s) deactivated, % range(s) closed before successor',
    v_shadows_deactivated, v_ranges_closed;
END
$item_rate_book_assignments_repair$;

DO $item_rate_versions_repair$
DECLARE
  v_ranges_closed integer := 0;
BEGIN
  -- Same-start duplicates cannot exist (item_rate_versions_book_from unique
  -- index); only overlapping active windows need closing.
  WITH ordered AS (
    SELECT id,
           lead(effective_from) OVER (
             PARTITION BY org_id, rate_book_id
             ORDER BY effective_from, id
           ) AS next_from
      FROM public.item_rate_versions
     WHERE status = 'active'
  ), closed AS (
    UPDATE public.item_rate_versions r
       SET effective_to = o.next_from - 1, updated_at = now()
      FROM ordered o
     WHERE o.id = r.id
       AND o.next_from IS NOT NULL
       AND o.next_from > r.effective_from
       AND (r.effective_to IS NULL OR r.effective_to >= o.next_from)
     RETURNING r.id
  )
  SELECT count(*) INTO v_ranges_closed FROM closed;

  RAISE NOTICE 'item_rate_versions repair: % active range(s) closed before successor', v_ranges_closed;
END
$item_rate_versions_repair$;

DO $labor_cost_rates_repair$
DECLARE
  v_ranges_closed integer := 0;
BEGIN
  -- Same-start duplicates cannot exist (labor_cost_rates_scope_from unique
  -- index); only overlapping active windows need closing.
  WITH ordered AS (
    SELECT id,
           lead(effective_from) OVER (
             PARTITION BY org_id,
                          coalesce(employee_party_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(lower(job_title), ''),
                          coalesce(trade_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)
             ORDER BY effective_from, id
           ) AS next_from
      FROM public.labor_cost_rates
     WHERE is_active
  ), closed AS (
    UPDATE public.labor_cost_rates r
       SET effective_to = o.next_from - 1, updated_at = now()
      FROM ordered o
     WHERE o.id = r.id
       AND o.next_from IS NOT NULL
       AND o.next_from > r.effective_from
       AND (r.effective_to IS NULL OR r.effective_to >= o.next_from)
     RETURNING r.id
  )
  SELECT count(*) INTO v_ranges_closed FROM closed;

  RAISE NOTICE 'labor_cost_rates repair: % active range(s) closed before successor', v_ranges_closed;
END
$labor_cost_rates_repair$;

DO $overhead_rates_repair$
DECLARE
  v_shadows_deleted integer := 0;
  v_ranges_closed integer := 0;
BEGIN
  -- No is_active flag and no dependent rows: shadow duplicates at the same
  -- start are deleted (0002 precedent), keeping the newest row.
  WITH marked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY org_id,
                          coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(lower(category), ''),
                          method, rate_kind, effective_from
             ORDER BY id DESC
           ) AS shadow_rank
      FROM public.overhead_rates
  ), deleted AS (
    DELETE FROM public.overhead_rates r
     USING marked s
     WHERE s.id = r.id
       AND s.shadow_rank > 1
     RETURNING r.id
  )
  SELECT count(*) INTO v_shadows_deleted FROM deleted;

  WITH ordered AS (
    SELECT id,
           lead(effective_from) OVER (
             PARTITION BY org_id,
                          coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          coalesce(lower(category), ''),
                          method, rate_kind
             ORDER BY effective_from, id
           ) AS next_from
      FROM public.overhead_rates
  ), closed AS (
    UPDATE public.overhead_rates r
       SET effective_to = o.next_from - 1, updated_at = now()
      FROM ordered o
     WHERE o.id = r.id
       AND o.next_from IS NOT NULL
       AND o.next_from > r.effective_from
       AND (r.effective_to IS NULL OR r.effective_to >= o.next_from)
     RETURNING r.id
  )
  SELECT count(*) INTO v_ranges_closed FROM closed;

  RAISE NOTICE 'overhead_rates repair: % shadow duplicate(s) deleted, % range(s) closed before successor',
    v_shadows_deleted, v_ranges_closed;
END
$overhead_rates_repair$;

DO $subsidiary_ownership_interests_repair$
DECLARE
  v_shadows_deactivated integer := 0;
  v_ranges_closed integer := 0;
  v_successors_deactivated integer := 0;
  v_conflict record;
BEGIN
  -- Same subsidiary + same start can coexist only through different parents
  -- under the old racy guard. Keep exactly one active policy per start: the
  -- consolidation-referenced one when present, else the newest. Two
  -- referenced policies at one start is double-counted consolidation — refuse.
  WITH marked AS (
    SELECT r.id,
           exists (SELECT 1 FROM public.ownership_consolidation_entries e
                    WHERE e.interest_id = r.id) AS is_used,
           row_number() OVER (
             PARTITION BY r.org_id, r.subsidiary_id, r.effective_from
             ORDER BY exists (SELECT 1 FROM public.ownership_consolidation_entries e
                               WHERE e.interest_id = r.id) DESC, r.id DESC
           ) AS keep_rank,
           count(*) FILTER (WHERE exists (SELECT 1 FROM public.ownership_consolidation_entries e
                                           WHERE e.interest_id = r.id)) OVER (
             PARTITION BY r.org_id, r.subsidiary_id, r.effective_from
           ) AS used_count
      FROM public.subsidiary_ownership_interests r
     WHERE r.is_active
  )
  SELECT count(*) INTO v_shadows_deactivated
    FROM marked
   WHERE used_count > 1;

  IF v_shadows_deactivated > 0 THEN
    RAISE EXCEPTION 'subsidiary_ownership_interests repair: % start date(s) have multiple consolidation-used policies — resolve them manually before migrating',
      v_shadows_deactivated;
  END IF;

  WITH marked AS (
    SELECT r.id,
           exists (SELECT 1 FROM public.ownership_consolidation_entries e
                    WHERE e.interest_id = r.id) AS is_used,
           row_number() OVER (
             PARTITION BY r.org_id, r.subsidiary_id, r.effective_from
             ORDER BY exists (SELECT 1 FROM public.ownership_consolidation_entries e
                               WHERE e.interest_id = r.id) DESC, r.id DESC
           ) AS keep_rank
      FROM public.subsidiary_ownership_interests r
     WHERE r.is_active
  ), deactivated AS (
    UPDATE public.subsidiary_ownership_interests interest
       SET is_active = false, updated_at = now()
      FROM marked s
     WHERE s.id = interest.id
       AND s.keep_rank > 1
     RETURNING interest.id
  )
  SELECT count(*) INTO v_shadows_deactivated FROM deactivated;

  -- Close or retire remaining cross-start overlaps one conflict at a time so
  -- every decision sees the state the previous one produced. A referenced
  -- (used) policy is never rewritten: its successor is deactivated instead;
  -- a conflict between two used policies aborts loudly.
  LOOP
    WITH ordered AS (
      SELECT r.id, r.effective_from, r.effective_to,
             exists (SELECT 1 FROM public.ownership_consolidation_entries e
                      WHERE e.interest_id = r.id) AS is_used,
             lead(r.effective_from) OVER (
               PARTITION BY r.org_id, r.subsidiary_id
               ORDER BY r.effective_from, r.id
             ) AS next_from,
             lead(r.id) OVER (
               PARTITION BY r.org_id, r.subsidiary_id
               ORDER BY r.effective_from, r.id
             ) AS next_id
        FROM public.subsidiary_ownership_interests r
       WHERE r.is_active
    ), conflict AS (
      SELECT o.id, o.is_used, o.next_id, o.next_from,
             exists (SELECT 1 FROM public.ownership_consolidation_entries e2
                      WHERE e2.interest_id = o.next_id) AS next_is_used
        FROM ordered o
       WHERE o.next_from IS NOT NULL
         AND o.next_from > o.effective_from
         AND (o.effective_to IS NULL OR o.effective_to >= o.next_from)
       ORDER BY o.id
       LIMIT 1
    )
    SELECT * FROM conflict INTO v_conflict;
    EXIT WHEN NOT FOUND;

    IF v_conflict.is_used AND v_conflict.next_is_used THEN
      RAISE EXCEPTION 'subsidiary_ownership_interests repair: consolidation-used policies % and % overlap — resolve them manually before migrating',
        v_conflict.id, v_conflict.next_id;
    END IF;

    IF NOT v_conflict.is_used THEN
      UPDATE public.subsidiary_ownership_interests
         SET effective_to = v_conflict.next_from - 1, updated_at = now()
       WHERE id = v_conflict.id;
      v_ranges_closed := v_ranges_closed + 1;
    ELSE
      UPDATE public.subsidiary_ownership_interests
         SET is_active = false, updated_at = now()
       WHERE id = v_conflict.next_id;
      v_successors_deactivated := v_successors_deactivated + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'subsidiary_ownership_interests repair: % shadow duplicate(s) deactivated, % range(s) closed, % consolidation-shadowed successor(s) deactivated',
    v_shadows_deactivated, v_ranges_closed, v_successors_deactivated;
END
$subsidiary_ownership_interests_repair$;

DO $tax_registrations_repair$
DECLARE
  v_shadows_deactivated integer := 0;
  v_ranges_closed integer := 0;
BEGIN
  WITH marked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY org_id, jurisdiction_id, coalesce(return_form_code, ''),
                          coalesce(effective_from, '-infinity'::date)
             ORDER BY id DESC
           ) AS shadow_rank
      FROM public.tax_registrations
     WHERE is_active
  ), deactivated AS (
    UPDATE public.tax_registrations r
       SET is_active = false, updated_at = now()
      FROM marked s
     WHERE s.id = r.id
       AND s.shadow_rank > 1
     RETURNING r.id
  )
  SELECT count(*) INTO v_shadows_deactivated FROM deactivated;

  WITH ordered AS (
    SELECT id,
           lead(coalesce(effective_from, '-infinity'::date)) OVER (
             PARTITION BY org_id, jurisdiction_id, coalesce(return_form_code, '')
             ORDER BY coalesce(effective_from, '-infinity'::date), id
           ) AS next_from
      FROM public.tax_registrations
     WHERE is_active
  ), closed AS (
    UPDATE public.tax_registrations r
       SET effective_to = o.next_from - 1, updated_at = now()
      FROM ordered o
     WHERE o.id = r.id
       AND o.next_from IS NOT NULL
       AND o.next_from > coalesce(r.effective_from, '-infinity'::date)
       AND (r.effective_to IS NULL OR r.effective_to >= o.next_from)
     RETURNING r.id
  )
  SELECT count(*) INTO v_ranges_closed FROM closed;

  RAISE NOTICE 'tax_registrations repair: % shadow duplicate(s) deactivated, % range(s) closed before successor',
    v_shadows_deactivated, v_ranges_closed;
END
$tax_registrations_repair$;

DO $project_financial_profile_versions_repair$
DECLARE
  v_ranges_closed integer := 0;
BEGIN
  -- Closing an effective window is the product's own publish-mode supersede
  -- operation, so the repair runs under the same governed switch.
  PERFORM set_config('openbooks.publish_project_profile', 'on', true);

  -- Same-start duplicates cannot exist (project_financial_profile_versions_
  -- identity unique index); only overlapping ranges need closing.
  WITH ordered AS (
    SELECT id,
           lead(effective_from) OVER (
             PARTITION BY org_id, project_type_id
             ORDER BY effective_from, id
           ) AS next_from
      FROM public.project_financial_profile_versions
  ), closed AS (
    UPDATE public.project_financial_profile_versions r
       SET effective_to = o.next_from - 1, updated_at = now()
      FROM ordered o
     WHERE o.id = r.id
       AND o.next_from IS NOT NULL
       AND o.next_from > r.effective_from
       AND (r.effective_to IS NULL OR r.effective_to >= o.next_from)
     RETURNING r.id
  )
  SELECT count(*) INTO v_ranges_closed FROM closed;

  RAISE NOTICE 'project_financial_profile_versions repair: % range(s) closed before successor', v_ranges_closed;
END
$project_financial_profile_versions_repair$;

--
-- 3. Storage-side enforcement: one exclusion constraint per former guard.
--    Active-flagged tables scope the constraint to rows that resolve; the
--    two tables without an activity flag (overhead_rates, project financial
--    profile versions) enforce every row, exactly as their triggers did.
--

ALTER TABLE public.fair_value_prices
  ADD CONSTRAINT fair_value_prices_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    item_id WITH =,
    currency WITH =,
    (daterange(coalesce(effective_from, '-infinity'::date), effective_to, '[]')) WITH &&
  )
  WHERE (is_active);

COMMENT ON CONSTRAINT fair_value_prices_no_active_overlap
  ON public.fair_value_prices IS
  'openbooks:fair_value_prices_no_active_overlap:v1 - one active fair-value window per item and currency; NULL effective_from means -infinity and windows are inclusive';

ALTER TABLE public.field_ticket_policies
  ADD CONSTRAINT field_ticket_policies_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    scope WITH =,
    (coalesce(customer_party_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (daterange(effective_from, effective_to, '[]')) WITH &&
  )
  WHERE (is_active);

COMMENT ON CONSTRAINT field_ticket_policies_no_active_overlap
  ON public.field_ticket_policies IS
  'openbooks:field_ticket_policies_no_active_overlap:v1 - one active Field Ticket policy window per organization scope (scope, customer, project)';

ALTER TABLE public.item_rate_book_assignments
  ADD CONSTRAINT item_rate_book_assignments_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    rate_book_id WITH =,
    (coalesce(rate_version_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(class_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    date_basis WITH =,
    (daterange(coalesce(effective_from, '-infinity'::date), effective_to, '[]')) WITH &&
  )
  WHERE (is_active);

COMMENT ON CONSTRAINT item_rate_book_assignments_no_active_overlap
  ON public.item_rate_book_assignments IS
  'openbooks:item_rate_book_assignments_no_active_overlap:v1 - one active rate-book assignment window per full assignment scope and date basis; NULL effective_from means -infinity';

ALTER TABLE public.item_rate_versions
  ADD CONSTRAINT item_rate_versions_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    rate_book_id WITH =,
    (daterange(effective_from, effective_to, '[]')) WITH &&
  )
  WHERE (status = 'active');

COMMENT ON CONSTRAINT item_rate_versions_no_active_overlap
  ON public.item_rate_versions IS
  'openbooks:item_rate_versions_no_active_overlap:v1 - one active rate version window per rate book; draft and retired versions never resolve and may overlap';

ALTER TABLE public.labor_cost_rates
  ADD CONSTRAINT labor_cost_rates_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    (coalesce(employee_party_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(lower(job_title), '')) WITH =,
    (coalesce(trade_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (daterange(effective_from, effective_to, '[]')) WITH &&
  )
  WHERE (is_active);

COMMENT ON CONSTRAINT labor_cost_rates_no_active_overlap
  ON public.labor_cost_rates IS
  'openbooks:labor_cost_rates_no_active_overlap:v1 - one active wage-rate window per labor scope (employee, job title, trade, department, subsidiary), case-insensitive job titles';

ALTER TABLE public.overhead_rates
  ADD CONSTRAINT overhead_rates_no_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(lower(category), '')) WITH =,
    method WITH =,
    rate_kind WITH =,
    (daterange(effective_from, effective_to, '[]')) WITH &&
  );

COMMENT ON CONSTRAINT overhead_rates_no_overlap
  ON public.overhead_rates IS
  'openbooks:overhead_rates_no_overlap:v1 - one overhead-rate window per department, category, method, and rate kind; case-insensitive categories';

ALTER TABLE public.subsidiary_ownership_interests
  ADD CONSTRAINT subsidiary_ownership_interests_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    subsidiary_id WITH =,
    (daterange(effective_from, effective_to, '[]')) WITH &&
  )
  WHERE (is_active);

COMMENT ON CONSTRAINT subsidiary_ownership_interests_no_active_overlap
  ON public.subsidiary_ownership_interests IS
  'openbooks:subsidiary_ownership_interests_no_active_overlap:v1 - one active ownership policy window per consolidated subsidiary';

ALTER TABLE public.tax_registrations
  ADD CONSTRAINT tax_registrations_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    jurisdiction_id WITH =,
    (coalesce(return_form_code, '')) WITH =,
    (daterange(coalesce(effective_from, '-infinity'::date), effective_to, '[]')) WITH &&
  )
  WHERE (is_active);

COMMENT ON CONSTRAINT tax_registrations_no_active_overlap
  ON public.tax_registrations IS
  'openbooks:tax_registrations_no_active_overlap:v1 - one active registration window per jurisdiction and return form; NULL effective_from means -infinity';

ALTER TABLE public.project_financial_profile_versions
  ADD CONSTRAINT project_financial_profile_versions_no_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    project_type_id WITH =,
    (daterange(effective_from, effective_to, '[]')) WITH &&
  );

COMMENT ON CONSTRAINT project_financial_profile_versions_no_overlap
  ON public.project_financial_profile_versions IS
  'openbooks:project_financial_profile_versions_no_overlap:v1 - one financial profile window per project type; publish-mode closing and correction-mode immutability remain in the trigger';
