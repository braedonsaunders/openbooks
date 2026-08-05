-- 0128_union_payroll.sql — union construction payroll layer.
-- Agreements + classifications + fringes (employer burdens / employee dues).
-- Wage scale deliberately excluded: wages have one home (labor_cost_rates).

CREATE TABLE public.union_agreements (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    union_name text,
    local_number text,
    remittance_party_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT union_agreements_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX union_agreements_org_name ON public.union_agreements (org_id, name);

CREATE TABLE public.union_classifications (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    agreement_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT union_classifications_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX union_classifications_agreement_code ON public.union_classifications (agreement_id, code);

CREATE TABLE public.union_fringes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    agreement_id uuid NOT NULL,
    classification_id uuid,
    code text NOT NULL,
    name text NOT NULL,
    calc text NOT NULL,
    value numeric(19,4) NOT NULL,
    paid_by text NOT NULL,
    job_costed boolean DEFAULT true NOT NULL,
    component_id uuid,
    sequence integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT union_fringes_pkey PRIMARY KEY (id),
    CONSTRAINT union_fringes_calc CHECK (calc IN ('per_hour_worked','percent_of_gross')),
    CONSTRAINT union_fringes_paid_by CHECK (paid_by IN ('employer','employee')),
    CONSTRAINT union_fringes_value_nonnegative CHECK (value >= 0)
);
CREATE UNIQUE INDEX union_fringes_agreement_code ON public.union_fringes (agreement_id, code);
CREATE INDEX union_fringes_agreement ON public.union_fringes (org_id, agreement_id);

ALTER TABLE public.employee_payroll_profiles
    ADD COLUMN union_agreement_id uuid,
    ADD COLUMN union_classification_id uuid;

ALTER TABLE public.union_agreements
    ADD CONSTRAINT union_agreements_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT union_agreements_remittance_party_id_fkey FOREIGN KEY (remittance_party_id) REFERENCES public.parties(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT union_agreements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT union_agreements_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

ALTER TABLE public.union_classifications
    ADD CONSTRAINT union_classifications_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT union_classifications_agreement_id_fkey FOREIGN KEY (agreement_id) REFERENCES public.union_agreements(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT union_classifications_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT union_classifications_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

ALTER TABLE public.union_fringes
    ADD CONSTRAINT union_fringes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT union_fringes_agreement_id_fkey FOREIGN KEY (agreement_id) REFERENCES public.union_agreements(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT union_fringes_classification_id_fkey FOREIGN KEY (classification_id) REFERENCES public.union_classifications(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT union_fringes_component_id_fkey FOREIGN KEY (component_id) REFERENCES public.pay_components(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT union_fringes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT union_fringes_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

ALTER TABLE public.employee_payroll_profiles
    ADD CONSTRAINT employee_payroll_profiles_union_agreement_id_fkey FOREIGN KEY (union_agreement_id) REFERENCES public.union_agreements(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT employee_payroll_profiles_union_classification_id_fkey FOREIGN KEY (union_classification_id) REFERENCES public.union_classifications(id) ON DELETE SET NULL DEFERRABLE;

CREATE VIEW openbooks_query.union_agreements WITH (security_barrier='true') AS
  SELECT * FROM public.union_agreements;
GRANT SELECT ON TABLE openbooks_query.union_agreements TO openbooks_read;

CREATE VIEW openbooks_query.union_classifications WITH (security_barrier='true') AS
  SELECT * FROM public.union_classifications;
GRANT SELECT ON TABLE openbooks_query.union_classifications TO openbooks_read;

CREATE VIEW openbooks_query.union_fringes WITH (security_barrier='true') AS
  SELECT * FROM public.union_fringes;
GRANT SELECT ON TABLE openbooks_query.union_fringes TO openbooks_read;

DROP VIEW IF EXISTS openbooks_query.employee_payroll_profiles;
CREATE VIEW openbooks_query.employee_payroll_profiles WITH (security_barrier='true') AS
  SELECT * FROM public.employee_payroll_profiles;
GRANT SELECT ON TABLE openbooks_query.employee_payroll_profiles TO openbooks_read;
