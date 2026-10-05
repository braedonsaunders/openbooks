-- Every CRA payroll program (RP) account prices its own employer EI
-- multiple: 1.4 unless the CRA approved a reduced rate for the account's
-- wage-loss plan. Accounts created before the multiple was tracked carry
-- no row, and the calculation prices an unconfigured account at the
-- statutory 1.4 — so without a backfill the standard rate would live only
-- as an implicit fallback, invisible in setup and indistinguishable from a
-- reduced rate nobody recorded.
--
-- This backfill records the explicit standard multiple (1.4000) for every
-- active Canadian RP account that has none, effective from the account's
-- creation. Reduced rates stay an operator entry in Payroll Setup →
-- Employer facts. Replay inserts only where no row for the account and key
-- exists, so a later operator edit is never rewritten by a second run.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

INSERT INTO public.payroll_employer_facts
  (org_id, subsidiary_id, filing_account_id, country, fact_key, effective_from,
   value_kind, fact_value, value_scale, change_reason)
SELECT fa.org_id, NULL, fa.id, 'CA', 'ei_employer_multiplier',
       fa.created_at::date, 'decimal', '1.4000', 4,
       'Standard employer EI multiple for accounts created before reduced-rate tracking.'
  FROM public.payroll_filing_accounts fa
 WHERE fa.country = 'CA'
   AND fa.program_type = 'ca_rp'
   AND fa.is_active
   AND NOT EXISTS (
     SELECT 1 FROM public.payroll_employer_facts existing
      WHERE existing.org_id = fa.org_id
        AND existing.filing_account_id = fa.id
        AND existing.country = 'CA'
        AND existing.fact_key = 'ei_employer_multiplier'
   );

SELECT public.openbooks_refresh_query_catalog();
