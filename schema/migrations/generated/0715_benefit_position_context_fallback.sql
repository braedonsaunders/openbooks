-- Distinguish missing source context from an empty recorded recipient role.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.hrm_benefit_transaction_positions
 ADD COLUMN fallback_only_when_context_absent boolean NOT NULL DEFAULT false;
ALTER TABLE public.hrm_benefit_transaction_positions
 ADD CONSTRAINT hrm_benefit_transaction_positions_context_fallback CHECK (
  NOT fallback_only_when_context_absent OR (recipient_source<>'assignment' AND fallback_source IS NOT NULL)
 );
COMMENT ON COLUMN public.hrm_benefit_transaction_positions.fallback_only_when_context_absent IS
 'Use a fallback only when the primary ticket or project context is absent; an empty role on a present source does not select a fallback.';
