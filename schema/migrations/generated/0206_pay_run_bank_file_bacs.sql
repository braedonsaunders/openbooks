-- OpenBooks forward migration 0206_pay_run_bank_file_bacs.
--
-- Builds on 0201 (which widened the format gate to cpa005, nacha, sepa,
-- cemtex and gave the numbering twin one honest arm per format). The Bacs
-- Standard 18 rail is the fifth format: a bacs artifact insert still fails
-- the format CHECK outright with PG 23514 — and widening only that CHECK
-- would still leave the row refused, because the numbering twin is an OR of
-- exactly four arms, each REQUIRING a format-specific shape. A fifth format
-- satisfies NONE of them no matter what it writes, so both constraints move
-- together here, under their existing names.
--
-- The new arm states the exact shape the artifact writer produces
-- (engine/src/payroll/bank-file-artifact.ts: the derivation writes a file
-- creation number ONLY for cpa005 and a file ID modifier ONLY for nacha, so
-- bacs stores NULL in BOTH numbering columns — verified against the Bacs
-- implementation, where bacsVolSerial (6-digit) and bacsFileNumber (3-digit)
-- are local variables passed to the renderer, both derived from the same
-- sequenceValue allocation, and live in the FILE BYTES, exactly the Cemtex
-- precedent where the reel sequence is likewise in the bytes). Traceability
-- lives in sequence_value. One honest arm per format: no catch-all, so the
-- cpa005, nacha, sepa and cemtex arms keep checking exactly what they
-- checked before.
--
-- No preflight is needed: every row the old constraints admit satisfies the
-- unchanged four arms of the new numbering predicate, and the old format
-- predicate's four values are a subset of the new five — so no legacy row
-- can violate either replacement. The drop and re-add happen in this
-- transaction, so replaying the reviewed migration is safe and no external
-- writer can observe an enforcement gap.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The 0201 constraint has the same name but admits only
-- cpa005/nacha/sepa/cemtex. Drop and recreate it in this transaction so
-- replaying the reviewed migration is safe and no external writer can
-- observe an enforcement gap.
ALTER TABLE public.pay_run_bank_files
  DROP CONSTRAINT IF EXISTS pay_run_bank_files_format;

ALTER TABLE public.pay_run_bank_files
  ADD CONSTRAINT pay_run_bank_files_format
  CHECK (format = ANY (ARRAY['cpa005'::text, 'nacha'::text, 'sepa'::text, 'cemtex'::text, 'bacs'::text]))
  NOT VALID;

ALTER TABLE public.pay_run_bank_files
  VALIDATE CONSTRAINT pay_run_bank_files_format;

COMMENT ON CONSTRAINT pay_run_bank_files_format
  ON public.pay_run_bank_files IS
  'openbooks:payroll_bank_file_format_bacs:v1 - payroll bank files move on cpa005, nacha, sepa, cemtex and bacs rails only';

-- The 0201 numbering twin is an OR of exactly four arms, each requiring a
-- format-specific shape, so bacs satisfies none. The new arm states its exact
-- writer-produced shape (both numbering columns NULL; traceability lives in
-- sequence_value), leaving the cpa005, nacha, sepa and cemtex arms
-- byte-for-byte as they were.
ALTER TABLE public.pay_run_bank_files
  DROP CONSTRAINT IF EXISTS pay_run_bank_files_format_numbering;

ALTER TABLE public.pay_run_bank_files
  ADD CONSTRAINT pay_run_bank_files_format_numbering
  CHECK (
    ((format = 'cpa005'::text) AND (file_creation_number BETWEEN 1 AND 9999) AND (file_id_modifier IS NULL))
    OR ((format = 'nacha'::text) AND (file_id_modifier ~ '^[A-Z0-9]$'::text) AND (file_creation_number IS NULL))
    OR ((format = 'sepa'::text) AND (file_creation_number IS NULL) AND (file_id_modifier IS NULL))
    OR ((format = 'cemtex'::text) AND (file_creation_number IS NULL) AND (file_id_modifier IS NULL))
    OR ((format = 'bacs'::text) AND (file_creation_number IS NULL) AND (file_id_modifier IS NULL))
  ) NOT VALID;

ALTER TABLE public.pay_run_bank_files
  VALIDATE CONSTRAINT pay_run_bank_files_format_numbering;

COMMENT ON CONSTRAINT pay_run_bank_files_format_numbering
  ON public.pay_run_bank_files IS
  'openbooks:payroll_bank_file_format_numbering_bacs:v1 - cpa005 carries a 1-9999 file creation number, nacha carries a single-character file ID modifier, sepa, cemtex and bacs carry neither (their traceable identity is sequence_value)';
