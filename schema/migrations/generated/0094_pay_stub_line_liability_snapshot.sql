-- OpenBooks forward migration 0094_pay_stub_line_liability_snapshot.
-- The liability account a committed deduction/employer contribution was
-- credited to is history: the remittance that later debits it must debit
-- THAT account, not whatever the pay component's setup names today. New
-- commits stamp the resolved account on each stub line. Committed legacy
-- lines are stamped from the component's current account and marked as such
-- (that is exactly the account every remittance summary reported for them
-- until now, so no historical figure changes); lines whose component names
-- no account keep resolving through the pack's legacy slot fallback.
ALTER TABLE public.pay_stub_lines ADD COLUMN liability_account_id uuid;
ALTER TABLE public.pay_stub_lines ADD COLUMN liability_account_source text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_liability_account_tenant_fkey
  FOREIGN KEY (org_id, liability_account_id) REFERENCES public.accounts(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_liability_account_evidence CHECK (
  (liability_account_source = 'unknown' AND liability_account_id IS NULL) OR
  (liability_account_source IN ('commit', 'legacy_component') AND liability_account_id IS NOT NULL)
);
CREATE INDEX pay_stub_lines_liability_account ON public.pay_stub_lines(org_id, liability_account_id);

UPDATE public.pay_stub_lines l
   SET liability_account_id = c.liability_account_id,
       liability_account_source = 'legacy_component'
  FROM public.pay_stubs s
  JOIN public.pay_runs r ON r.document_id = s.pay_run_document_id AND r.org_id = s.org_id
  JOIN public.pay_components c ON c.org_id = s.org_id
 WHERE s.id = l.stub_id AND s.org_id = l.org_id
   AND c.id = l.component_id
   AND r.run_status = 'committed'
   AND l.kind IN ('deduction', 'employer_contribution')
   AND c.liability_account_id IS NOT NULL
   AND l.liability_account_source = 'unknown';

CREATE OR REPLACE FUNCTION public.pay_stub_line_liability_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.liability_account_source <> 'unknown'
     AND ROW(NEW.liability_account_id, NEW.liability_account_source)
         IS DISTINCT FROM ROW(OLD.liability_account_id, OLD.liability_account_source) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'pay_stub_line_liability_immutable',
      MESSAGE = 'The liability account a committed payroll line accrued to is immutable.';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pay_stub_line_liability_guard BEFORE UPDATE ON public.pay_stub_lines
FOR EACH ROW EXECUTE FUNCTION public.pay_stub_line_liability_guard();
COMMENT ON COLUMN public.pay_stub_lines.liability_account_id IS
  'Liability account this deduction/employer contribution was credited to at commit. Remittances debit this account, never the component''s current setup.';
COMMENT ON COLUMN public.pay_stub_lines.liability_account_source IS
  'commit = stamped by the committing engine; legacy_component = backfilled from the component''s account at migration 0094 (the figure reported until then); unknown = pre-0094 line whose component named no account (resolves through the pack''s legacy slot).';
SELECT public.openbooks_refresh_query_catalog();
