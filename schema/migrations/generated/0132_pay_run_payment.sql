-- 0132_pay_run_payment.sql — paid state on pay runs.
-- recordPayRunPayment posts DR net-pay payable (applying the run's per-
-- employee open items) / CR bank, and stamps the run paid.

ALTER TABLE public.pay_runs
    ADD COLUMN paid_at timestamp with time zone,
    ADD COLUMN paid_entry_id uuid;

ALTER TABLE public.pay_runs
    ADD CONSTRAINT pay_runs_paid_entry_id_fkey FOREIGN KEY (paid_entry_id)
        REFERENCES public.journal_entries(id) ON DELETE SET NULL DEFERRABLE;

DROP VIEW IF EXISTS openbooks_query.pay_runs;
CREATE VIEW openbooks_query.pay_runs WITH (security_barrier='true') AS
  SELECT * FROM public.pay_runs;
GRANT SELECT ON TABLE openbooks_query.pay_runs TO openbooks_read;
