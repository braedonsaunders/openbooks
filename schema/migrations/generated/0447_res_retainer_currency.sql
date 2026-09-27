-- OpenBooks forward migration 0447_res_retainer_currency.
-- Preserve each retainer's transaction currency before making it a required term.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

LOCK TABLE public.res_retainers IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.customer_roles, public.orgs IN SHARE MODE;

ALTER TABLE public.res_retainers ADD COLUMN currency text;

UPDATE public.res_retainers r
   SET currency = cr.currency
  FROM public.customer_roles cr
 WHERE cr.org_id = r.org_id
   AND cr.party_id = r.customer_party_id
   AND nullif(btrim(cr.currency), '') IS NOT NULL;

UPDATE public.res_retainers r
   SET currency = o.base_currency
  FROM public.orgs o
 WHERE o.id = r.org_id
   AND r.currency IS NULL
   AND nullif(btrim(o.base_currency), '') IS NOT NULL;

ALTER TABLE public.res_retainers ALTER COLUMN currency SET NOT NULL;

SELECT public.openbooks_refresh_query_catalog();
