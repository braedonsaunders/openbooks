-- OpenBooks forward migration 0201_pay_run_bank_file_sepa_cemtex.
--
-- The pay_run_bank_files format gate admitted exactly two formats
-- (cpa005, nacha), so a sepa artifact insert fails the format CHECK
-- outright with PG 23514 — and widening only that CHECK would still leave
-- the row refused, because the numbering twin is an OR of exactly two arms,
-- each REQUIRING a format-specific shape (cpa005 carries a 1–9999 file
-- creation number and no modifier; nacha carries a single-character file ID
-- modifier and no number). A third format satisfies NEITHER arm no matter
-- what it writes, so both constraints move together here.
--
-- The new arms state the exact shapes the artifact writer produces
-- (engine/src/payroll/bank-file-artifact.ts: the derivation writes a file
-- creation number ONLY for cpa005 and a file ID modifier ONLY for nacha, so
-- every other format stores NULL in both — its traceable identity is the
-- sequence_value allocation, which SEPA carries as the message id). One
-- honest arm per format: no catch-all, so the cpa005 and nacha arms keep
-- checking exactly what they checked before.
--
-- No preflight is needed: every row the old constraints admit satisfies the
-- unchanged cpa005/nacha arms of the new numbering predicate, and the old
-- format predicate's two values are a subset of the new four — so no legacy
-- row can violate either replacement. The drop and re-add happen in this
-- transaction, so replaying the reviewed migration is safe and no external
-- writer can observe an enforcement gap.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The baseline constraint has the same name but admits only cpa005/nacha.
-- Drop and recreate it in this transaction so replaying the reviewed
-- migration is safe and no external writer can observe an enforcement gap.
ALTER TABLE public.pay_run_bank_files
  DROP CONSTRAINT IF EXISTS pay_run_bank_files_format;

ALTER TABLE public.pay_run_bank_files
  ADD CONSTRAINT pay_run_bank_files_format
  CHECK (format = ANY (ARRAY['cpa005'::text, 'nacha'::text, 'sepa'::text, 'cemtex'::text]))
  NOT VALID;

ALTER TABLE public.pay_run_bank_files
  VALIDATE CONSTRAINT pay_run_bank_files_format;

COMMENT ON CONSTRAINT pay_run_bank_files_format
  ON public.pay_run_bank_files IS
  'openbooks:payroll_bank_file_format_sepa_cemtex:v1 - payroll bank files move on cpa005, nacha, sepa and cemtex rails only';

-- The baseline numbering twin is an OR of exactly two arms, each requiring
-- a format-specific shape, so sepa and cemtex satisfy neither. The two new
-- arms state their exact writer-produced shape (both numbering columns
-- NULL; traceability lives in sequence_value), leaving the cpa005 and nacha
-- arms byte-for-byte as they were.
ALTER TABLE public.pay_run_bank_files
  DROP CONSTRAINT IF EXISTS pay_run_bank_files_format_numbering;

ALTER TABLE public.pay_run_bank_files
  ADD CONSTRAINT pay_run_bank_files_format_numbering
  CHECK (
    ((format = 'cpa005'::text) AND (file_creation_number BETWEEN 1 AND 9999) AND (file_id_modifier IS NULL))
    OR ((format = 'nacha'::text) AND (file_id_modifier ~ '^[A-Z0-9]$'::text) AND (file_creation_number IS NULL))
    OR ((format = 'sepa'::text) AND (file_creation_number IS NULL) AND (file_id_modifier IS NULL))
    OR ((format = 'cemtex'::text) AND (file_creation_number IS NULL) AND (file_id_modifier IS NULL))
  ) NOT VALID;

ALTER TABLE public.pay_run_bank_files
  VALIDATE CONSTRAINT pay_run_bank_files_format_numbering;

COMMENT ON CONSTRAINT pay_run_bank_files_format_numbering
  ON public.pay_run_bank_files IS
  'openbooks:payroll_bank_file_format_numbering_sepa_cemtex:v1 - cpa005 carries a 1-9999 file creation number, nacha carries a single-character file ID modifier, sepa and cemtex carry neither (their traceable identity is sequence_value)';
