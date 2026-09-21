-- OpenBooks forward migration 0211_pay_run_bank_file_zengin_cnab240.
--
-- Builds on 0206 (which admitted bacs on top of 0201's cpa005, nacha, sepa,
-- cemtex). Two formats queue behind this one ordinal — zengin (Japan) and
-- cnab240 (Brazil) — so both move together here rather than occupying an
-- ordinal each. After 0206 the format gate admits five formats and the
-- numbering twin is an OR of exactly five arms, each REQUIRING a
-- format-specific shape: a zengin or cnab240 artifact insert still fails
-- outright with PG 23514 no matter what it writes, because the new formats
-- satisfy NONE of the five arms — and widening only the format CHECK would
-- still leave every such row refused. Both constraints move together here,
-- under their existing names.
--
-- The two new arms state the exact shapes the artifact writers produce.
-- engine/src/payroll/bank-file-artifact.ts derives a file creation number
-- ONLY for cpa005 and a file ID modifier ONLY for nacha, so zengin and
-- cnab240 both store NULL in BOTH numbering columns, with traceability in
-- sequence_value. Verified against both implementations, not inferred:
-- zengin's bank-facing identity (like the Bacs VOL1 serial and UHL1 file
-- number, the Cemtex precedent) is a renderer local derived from that same
-- sequenceValue allocation and lives in the FILE BYTES, and cnab240's NSA
-- arquivo sequence likewise reuses the stored sequence_value with no new
-- column. The zengin writer lives on its own branch (the composer resolves
-- the PayRunBankFileFormat union widening); its derivation is quoted above
-- and matches the null-null shape, so this arm honours a writer that
-- exists rather than speculating one. One honest arm per format: no
-- catch-all, so the cpa005, nacha, sepa, cemtex and bacs arms keep checking
-- exactly what they checked before.
--
-- No preflight is needed: every row the old constraints admit satisfies the
-- unchanged five arms of the new numbering predicate, and the old format
-- predicate's five values are a subset of the new seven — so no legacy row
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

-- The 0206 constraint has the same name but admits only
-- cpa005/nacha/sepa/cemtex/bacs. Drop and recreate it in this transaction so
-- replaying the reviewed migration is safe and no external writer can
-- observe an enforcement gap.
ALTER TABLE public.pay_run_bank_files
  DROP CONSTRAINT IF EXISTS pay_run_bank_files_format;

ALTER TABLE public.pay_run_bank_files
  ADD CONSTRAINT pay_run_bank_files_format
  CHECK (format = ANY (ARRAY['cpa005'::text, 'nacha'::text, 'sepa'::text, 'cemtex'::text, 'bacs'::text, 'zengin'::text, 'cnab240'::text]))
  NOT VALID;

ALTER TABLE public.pay_run_bank_files
  VALIDATE CONSTRAINT pay_run_bank_files_format;

COMMENT ON CONSTRAINT pay_run_bank_files_format
  ON public.pay_run_bank_files IS
  'openbooks:payroll_bank_file_format_zengin_cnab240:v1 - payroll bank files move on cpa005, nacha, sepa, cemtex, bacs, zengin and cnab240 rails only';

-- The 0206 numbering twin is an OR of exactly five arms, each requiring a
-- format-specific shape, so zengin and cnab240 satisfy none. The two new
-- arms state their exact writer-produced shape (both numbering columns
-- NULL; traceability lives in sequence_value), leaving the cpa005, nacha,
-- sepa, cemtex and bacs arms byte-for-byte as they were.
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
    OR ((format = 'zengin'::text) AND (file_creation_number IS NULL) AND (file_id_modifier IS NULL))
    OR ((format = 'cnab240'::text) AND (file_creation_number IS NULL) AND (file_id_modifier IS NULL))
  ) NOT VALID;

ALTER TABLE public.pay_run_bank_files
  VALIDATE CONSTRAINT pay_run_bank_files_format_numbering;

COMMENT ON CONSTRAINT pay_run_bank_files_format_numbering
  ON public.pay_run_bank_files IS
  'openbooks:payroll_bank_file_format_numbering_zengin_cnab240:v1 - cpa005 carries a 1-9999 file creation number, nacha carries a single-character file ID modifier, sepa, cemtex, bacs, zengin and cnab240 carry neither (their traceable identity is sequence_value)';
