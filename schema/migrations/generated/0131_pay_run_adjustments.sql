-- 0131_pay_run_adjustments.sql — run-level payroll input adjustments.
-- One-off earnings/deductions, component replacements, and per-run employee
-- exclusions. Adjustments are INPUTS: calculate merges them into the stub's
-- line set and recomputes the statutory math — calculated amounts are never
-- edited directly (auditability + penny-exact CRA/IRS numbers preserved).

CREATE TABLE public.pay_run_adjustments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    pay_run_document_id uuid NOT NULL,
    employee_party_id uuid NOT NULL,
    adjustment_type text NOT NULL,
    component_id uuid,
    amount numeric(19,4),
    hours numeric(12,2),
    replace_component boolean DEFAULT false NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT pay_run_adjustments_pkey PRIMARY KEY (id),
    CONSTRAINT pay_run_adjustments_type CHECK (adjustment_type IN ('line','exclude')),
    CONSTRAINT pay_run_adjustments_line_shape CHECK (
      adjustment_type <> 'line' OR (component_id IS NOT NULL AND amount IS NOT NULL)
    )
);
CREATE INDEX pay_run_adjustments_run ON public.pay_run_adjustments (org_id, pay_run_document_id, employee_party_id);
CREATE UNIQUE INDEX pay_run_adjustments_exclude_once
  ON public.pay_run_adjustments (pay_run_document_id, employee_party_id)
  WHERE adjustment_type = 'exclude';

ALTER TABLE public.pay_run_adjustments
    ADD CONSTRAINT pay_run_adjustments_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_run_adjustments_run_fkey FOREIGN KEY (pay_run_document_id) REFERENCES public.pay_runs(document_id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_run_adjustments_employee_fkey FOREIGN KEY (employee_party_id) REFERENCES public.parties(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_run_adjustments_component_fkey FOREIGN KEY (component_id) REFERENCES public.pay_components(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_run_adjustments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_run_adjustments_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

CREATE VIEW openbooks_query.pay_run_adjustments WITH (security_barrier='true') AS
  SELECT * FROM public.pay_run_adjustments;
GRANT SELECT ON TABLE openbooks_query.pay_run_adjustments TO openbooks_read;
