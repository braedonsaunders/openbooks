-- 0134_payroll_employer_taxes.sql — WCB/WSIB and EHT employer-tax support.
-- WCB premiums come from worker_comp_groups (rate % of assessable earnings);
-- the annual assessable maximum per worker is class/province data, so it
-- joins the group. New statutory system keys 'wcb' and 'eht' extend the
-- pay_components check; both are employer-only accruals whose accounts ride
-- the CA pack slots.

ALTER TABLE public.worker_comp_groups
    ADD COLUMN max_assessable numeric(19,4);

ALTER TABLE public.pay_components
    DROP CONSTRAINT IF EXISTS pay_components_system_key;
ALTER TABLE public.pay_components
    ADD CONSTRAINT pay_components_system_key CHECK (system_key IS NULL OR system_key IN
      ('base_pay','overtime','bonus','vacation_accrual','vacation_payout',
       'cpp','cpp2','ei','qpip','income_tax',
       'fit','ss','medicare','medicare_addl','futa','suta',
       'wcb','eht'));

DROP VIEW IF EXISTS openbooks_query.worker_comp_groups;
CREATE VIEW openbooks_query.worker_comp_groups WITH (security_barrier='true') AS
  SELECT * FROM public.worker_comp_groups;
GRANT SELECT ON TABLE openbooks_query.worker_comp_groups TO openbooks_read;
