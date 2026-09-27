-- OpenBooks forward migration 0438: pledge and gift records.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.pledges (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  subsidiary_id uuid NOT NULL,
  pledge_number text NOT NULL,
  donor_party_id uuid NOT NULL,
  fund_id uuid NOT NULL,
  total_amount numeric(19, 4) NOT NULL,
  discount_rate numeric(19, 10) NOT NULL DEFAULT 0,
  present_value numeric(19, 4),
  allowance_amount numeric(19, 4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  booked_on date,
  booking_entry_id uuid,
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT pledges_pkey PRIMARY KEY (id),
  CONSTRAINT pledges_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT pledges_org_number_unique UNIQUE (org_id, pledge_number),
  CONSTRAINT pledges_status_check
    CHECK (status IN ('draft', 'booked', 'collecting', 'fulfilled', 'written_off', 'cancelled')),
  CONSTRAINT pledges_amounts_check
    CHECK (total_amount > 0 AND discount_rate >= 0 AND allowance_amount >= 0
      AND allowance_amount <= total_amount
      AND (present_value IS NULL OR (present_value > 0 AND present_value <= total_amount))),
  CONSTRAINT pledges_booking_state_check
    CHECK (
      (status = 'draft' AND booked_on IS NULL AND booking_entry_id IS NULL AND present_value IS NULL)
      OR
      (status <> 'draft' AND booked_on IS NOT NULL AND booking_entry_id IS NOT NULL AND present_value IS NOT NULL)
    ),
  CONSTRAINT pledges_donor_fkey
    FOREIGN KEY (org_id, donor_party_id) REFERENCES public.parties (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT pledges_fund_fkey
    FOREIGN KEY (org_id, fund_id) REFERENCES public.funds (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT pledges_subsidiary_fkey
    FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT pledges_booking_entry_fkey
    FOREIGN KEY (org_id, booking_entry_id) REFERENCES public.journal_entries (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT pledges_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users (id) DEFERRABLE,
  CONSTRAINT pledges_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users (id) DEFERRABLE
);

COMMENT ON COLUMN public.pledges.discount_rate IS
  'Annual percentage discounted with exact monthly compounding.';

CREATE INDEX pledges_org_status_due ON public.pledges (org_id, status, booked_on);
CREATE INDEX pledges_org_donor ON public.pledges (org_id, donor_party_id);
ALTER TABLE public.pledges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pledges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.pledges
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.pledge_installments (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  pledge_id uuid NOT NULL,
  installment_number integer NOT NULL,
  due_on date NOT NULL,
  amount numeric(19, 4) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT pledge_installments_pkey PRIMARY KEY (id),
  CONSTRAINT pledge_installments_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT pledge_installments_org_number_unique
    UNIQUE (org_id, pledge_id, installment_number),
  CONSTRAINT pledge_installments_positive_check CHECK (installment_number > 0 AND amount > 0),
  CONSTRAINT pledge_installments_pledge_fkey
    FOREIGN KEY (org_id, pledge_id) REFERENCES public.pledges (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT pledge_installments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users (id) DEFERRABLE
);

CREATE INDEX pledge_installments_org_due ON public.pledge_installments (org_id, due_on, pledge_id);
ALTER TABLE public.pledge_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pledge_installments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.pledge_installments
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.gifts (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  subsidiary_id uuid NOT NULL,
  gift_number text NOT NULL,
  donor_party_id uuid,
  fund_id uuid NOT NULL,
  amount numeric(19, 4) NOT NULL,
  kind text NOT NULL,
  fair_value_basis text,
  tribute_kind text NOT NULL DEFAULT 'none',
  tribute_name text,
  tribute_notify_party_id uuid,
  receipt_number text,
  received_on date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  posted_entry_id uuid,
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT gifts_pkey PRIMARY KEY (id),
  CONSTRAINT gifts_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT gifts_org_number_unique UNIQUE (org_id, gift_number),
  CONSTRAINT gifts_org_receipt_number_unique UNIQUE (org_id, receipt_number),
  CONSTRAINT gifts_kind_check
    CHECK (kind IN ('cash', 'check', 'card', 'stock', 'in_kind_goods', 'in_kind_services', 'other')),
  CONSTRAINT gifts_fair_value_basis_check
    CHECK (fair_value_basis IS NULL OR fair_value_basis IN ('appraisal', 'donor_stated', 'market')),
  CONSTRAINT gifts_in_kind_basis_check
    CHECK (kind NOT IN ('in_kind_goods', 'in_kind_services') OR fair_value_basis IS NOT NULL),
  CONSTRAINT gifts_tribute_kind_check
    CHECK (tribute_kind IN ('none', 'in_honor_of', 'in_memory_of')),
  CONSTRAINT gifts_tribute_fields_check
    CHECK (
      (tribute_kind = 'none' AND tribute_name IS NULL AND tribute_notify_party_id IS NULL)
      OR
      (tribute_kind <> 'none' AND tribute_name IS NOT NULL AND btrim(tribute_name) <> '')
    ),
  CONSTRAINT gifts_status_check CHECK (status IN ('draft', 'receipted', 'posted', 'void')),
  CONSTRAINT gifts_receipt_state_check
    CHECK (status NOT IN ('receipted', 'posted') OR receipt_number IS NOT NULL),
  CONSTRAINT gifts_amount_check CHECK (amount > 0),
  CONSTRAINT gifts_donor_fkey
    FOREIGN KEY (org_id, donor_party_id) REFERENCES public.parties (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT gifts_tribute_notify_party_fkey
    FOREIGN KEY (org_id, tribute_notify_party_id) REFERENCES public.parties (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT gifts_fund_fkey
    FOREIGN KEY (org_id, fund_id) REFERENCES public.funds (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT gifts_subsidiary_fkey
    FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT gifts_posted_entry_fkey
    FOREIGN KEY (org_id, posted_entry_id) REFERENCES public.journal_entries (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT gifts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users (id) DEFERRABLE,
  CONSTRAINT gifts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users (id) DEFERRABLE
);

CREATE INDEX gifts_org_status_received ON public.gifts (org_id, status, received_on);
CREATE INDEX gifts_org_donor ON public.gifts (org_id, donor_party_id);
ALTER TABLE public.gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gifts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.gifts
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
  VALUES ('pledges', '0438'), ('pledge_installments', '0438'), ('gifts', '0438')
  ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
