-- Field tickets record the superintendent who supervised the work beside the
-- foreman. Transaction incentive programs can resolve recipients from the
-- roles recorded on each source document (field ticket foreman or
-- superintendent, falling back to the project's foreman or manager), measure
-- lines by their work date, forfeit a share whose role holder is not a program
-- member, round once per recipient, and cap a project's incentive at a
-- percentage of the program items on its awarded quote's original budget for
-- projects of a chosen type. Every option defaults to the existing behaviour.
ALTER TABLE public.field_tickets ADD COLUMN IF NOT EXISTS superintendent_party_id uuid;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_tickets_superintendent_fk') THEN
  ALTER TABLE ONLY public.field_tickets ADD CONSTRAINT field_tickets_superintendent_fk
    FOREIGN KEY (superintendent_party_id) REFERENCES public.parties(id) DEFERRABLE; END IF; END $$;
CREATE INDEX IF NOT EXISTS field_tickets_superintendent ON public.field_tickets (org_id, superintendent_party_id);

ALTER TABLE public.hrm_benefit_transaction_policies DROP CONSTRAINT IF EXISTS hrm_benefit_transaction_policies_date_basis_check;
ALTER TABLE public.hrm_benefit_transaction_policies ADD CONSTRAINT hrm_benefit_transaction_policies_date_basis_check
  CHECK (date_basis IN ('document_date','work_date'));
ALTER TABLE public.hrm_benefit_transaction_policies
  ADD COLUMN IF NOT EXISTS unassigned_share text DEFAULT 'refuse' NOT NULL,
  ADD COLUMN IF NOT EXISTS rounding text DEFAULT 'per_group' NOT NULL,
  ADD COLUMN IF NOT EXISTS cap_percent numeric(19,4),
  ADD COLUMN IF NOT EXISTS cap_project_type_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_transaction_policies_unassigned_share') THEN
    ALTER TABLE public.hrm_benefit_transaction_policies ADD CONSTRAINT hrm_benefit_transaction_policies_unassigned_share
      CHECK (unassigned_share IN ('refuse','forfeit')); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_transaction_policies_rounding') THEN
    ALTER TABLE public.hrm_benefit_transaction_policies ADD CONSTRAINT hrm_benefit_transaction_policies_rounding
      CHECK (rounding IN ('per_group','per_recipient')); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_transaction_policies_cap') THEN
    ALTER TABLE public.hrm_benefit_transaction_policies ADD CONSTRAINT hrm_benefit_transaction_policies_cap
      CHECK ((cap_percent IS NULL AND cap_project_type_id IS NULL) OR (cap_percent IS NOT NULL AND cap_percent >= 0 AND cap_percent <= 100)); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_transaction_policies_cap_project_type_fk') THEN
    ALTER TABLE ONLY public.hrm_benefit_transaction_policies ADD CONSTRAINT hrm_benefit_transaction_policies_cap_project_type_fk
      FOREIGN KEY (cap_project_type_id) REFERENCES public.project_types(id) DEFERRABLE; END IF;
END $$;

ALTER TABLE public.hrm_benefit_transaction_positions
  ADD COLUMN IF NOT EXISTS recipient_source text DEFAULT 'assignment' NOT NULL,
  ADD COLUMN IF NOT EXISTS fallback_source text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_transaction_positions_recipient_source') THEN
    ALTER TABLE public.hrm_benefit_transaction_positions ADD CONSTRAINT hrm_benefit_transaction_positions_recipient_source
      CHECK (recipient_source IN ('assignment','field_ticket_foreman','field_ticket_superintendent','project_foreman','project_manager')
        AND (fallback_source IS NULL OR (recipient_source <> 'assignment'
          AND fallback_source IN ('field_ticket_foreman','field_ticket_superintendent','project_foreman','project_manager')
          AND fallback_source <> recipient_source))); END IF;
END $$;

COMMENT ON COLUMN public.field_tickets.superintendent_party_id IS 'Superintendent who supervised the ticketed work.';
COMMENT ON COLUMN public.hrm_benefit_transaction_policies.unassigned_share IS 'A position whose role holder is missing or not a program member: refuse settlement, or forfeit that share.';
COMMENT ON COLUMN public.hrm_benefit_transaction_policies.rounding IS 'per_group rounds each group pool; per_recipient sums exact shares and rounds once per recipient.';
COMMENT ON COLUMN public.hrm_benefit_transaction_policies.cap_percent IS 'Ceiling as a percent of program items on the project''s original budget baseline; consumed by the program rate on all earlier source lines.';
COMMENT ON COLUMN public.hrm_benefit_transaction_positions.recipient_source IS 'Where the position''s recipient comes from: dated assignments, or a role recorded on the source document or its project.';
