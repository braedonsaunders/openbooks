-- OpenBooks forward migration 0545_grant_mtdc_and_cam_vacancy.
-- A grant whose indirect costs are measured on modified total direct costs
-- names the account group whose costs leave that base (equipment, capital
-- expenditures, rental costs, patient care, tuition remission, participant
-- support), and optionally the subaward account group together with the
-- amount of each subrecipient's subaward that stays in the base. Both are
-- grant configuration, so the excluded categories are never hard-coded.
--
-- A CAM pool names how vacant rentable area is treated when costs are shared
-- by rentable area: either the occupied leases share the whole pool (the
-- established behaviour, kept for every existing pool) or each lease pays its
-- area's share of the property's total rentable area and the vacant share
-- stays with the landlord.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.grants
  ADD COLUMN mtdc_exclusion_account_group_id uuid,
  ADD COLUMN mtdc_subaward_account_group_id uuid,
  ADD COLUMN mtdc_subaward_threshold numeric(19,4),
  ADD CONSTRAINT grants_mtdc_exclusion_group_fkey
    FOREIGN KEY (org_id, mtdc_exclusion_account_group_id) REFERENCES public.account_groups (org_id, id),
  ADD CONSTRAINT grants_mtdc_subaward_group_fkey
    FOREIGN KEY (org_id, mtdc_subaward_account_group_id) REFERENCES public.account_groups (org_id, id),
  ADD CONSTRAINT grants_mtdc_subaward_pair_check
    CHECK ((mtdc_subaward_account_group_id IS NULL) = (mtdc_subaward_threshold IS NULL)
      AND (mtdc_subaward_threshold IS NULL OR mtdc_subaward_threshold >= 0)),
  ADD CONSTRAINT grants_mtdc_config_base_check
    CHECK (indirect_base = 'modified_total_direct'
      OR (mtdc_exclusion_account_group_id IS NULL AND mtdc_subaward_account_group_id IS NULL));

CREATE INDEX grants_org_mtdc_exclusion_group
  ON public.grants (org_id, mtdc_exclusion_account_group_id)
  WHERE mtdc_exclusion_account_group_id IS NOT NULL;
CREATE INDEX grants_org_mtdc_subaward_group
  ON public.grants (org_id, mtdc_subaward_account_group_id)
  WHERE mtdc_subaward_account_group_id IS NOT NULL;

ALTER TABLE public.cam_pools
  ADD COLUMN vacancy_treatment text NOT NULL DEFAULT 'occupied_area',
  ADD CONSTRAINT cam_pools_vacancy_treatment_check
    CHECK (vacancy_treatment IN ('occupied_area', 'total_rentable_area'));
