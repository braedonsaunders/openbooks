-- Bank drawdown on ordinary runs: an entitlement plan names the component
-- whose lines fund its hours bank from a run (worked time banked instead of
-- paid) and whether payouts may drive the bank below zero. Both are pure
-- configuration: existing plans keep a null deposit component and refuse
-- overdraws, so no stored bank changes meaning.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.entitlement_plans
 ADD COLUMN deposit_component_id uuid,
 ADD COLUMN allow_negative_balance boolean NOT NULL DEFAULT false;
ALTER TABLE ONLY public.entitlement_plans
 ADD CONSTRAINT entitlement_plans_deposit_component_id_fkey FOREIGN KEY (deposit_component_id) REFERENCES public.pay_components(id) ON DELETE SET NULL DEFERRABLE;
