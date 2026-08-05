-- 0130_payroll_subsidiary_schedules.sql — subsidiary-scoped pay schedules.
-- Each legal entity runs its own payroll calendar: a scoped schedule pins its
-- runs to that subsidiary (document entity + currency) and only includes
-- employees belonging to it. Null = org-wide (root subsidiary), the previous
-- behaviour. This is also the multi-country-pack enabler: a US subsidiary's
-- schedule pays its Pub 15-T employees in USD beside a Canadian T4127 CAD
-- schedule in the same org.

ALTER TABLE public.pay_schedules
    ADD COLUMN subsidiary_id uuid;

ALTER TABLE public.pay_schedules
    ADD CONSTRAINT pay_schedules_subsidiary_id_fkey FOREIGN KEY (subsidiary_id)
        REFERENCES public.subsidiaries(id) ON DELETE SET NULL DEFERRABLE;

CREATE INDEX pay_schedules_subsidiary ON public.pay_schedules (org_id, subsidiary_id);

DROP VIEW IF EXISTS openbooks_query.pay_schedules;
CREATE VIEW openbooks_query.pay_schedules WITH (security_barrier='true') AS
  SELECT * FROM public.pay_schedules;
GRANT SELECT ON TABLE openbooks_query.pay_schedules TO openbooks_read;
