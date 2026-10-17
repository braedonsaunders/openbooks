-- Explainable automatic bank matches.
--
-- An automatic match records the structured reasons behind its confidence
-- (exact amount, signed date lag, shared reference, shared counterparty
-- words, same party as an earlier confirmed match) so reviewers see why a
-- statement line was paired and the explanation stays with the match. The
-- column holds a JSON array of reason objects; null means no reasons were
-- recorded: manual and rule matches, and automatic matches made earlier.
-- Backfill: none. Existing matches keep their confidence unchanged.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.reconciliation_matches ADD COLUMN match_reasons jsonb;
ALTER TABLE public.reconciliation_matches ADD CONSTRAINT reconciliation_matches_reasons_shape
 CHECK (match_reasons IS NULL OR jsonb_typeof(match_reasons) = 'array');
COMMENT ON COLUMN public.reconciliation_matches.match_reasons IS
 'Structured reasons behind an automatic match''s confidence: an array of {code, ...parameters} objects rendered by the review screen. Null when none were recorded (manual and rule matches, earlier automatic matches).';

SELECT public.openbooks_refresh_query_catalog();
