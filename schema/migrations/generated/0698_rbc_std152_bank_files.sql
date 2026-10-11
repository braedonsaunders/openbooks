-- Admit RBC STD152 artifacts with allocated bank-facing creation numbers.
ALTER TABLE public.pay_run_bank_files DROP CONSTRAINT pay_run_bank_files_format;
ALTER TABLE public.pay_run_bank_files ADD CONSTRAINT pay_run_bank_files_format
  CHECK (format IN ('cpa005','nacha','sepa','cemtex','bacs','zengin','cnab240','rbc_std152')) NOT VALID;
ALTER TABLE public.pay_run_bank_files VALIDATE CONSTRAINT pay_run_bank_files_format;

ALTER TABLE public.pay_run_bank_files DROP CONSTRAINT pay_run_bank_files_format_numbering;
ALTER TABLE public.pay_run_bank_files ADD CONSTRAINT pay_run_bank_files_format_numbering
  CHECK (
    (format='cpa005' AND file_creation_number BETWEEN 1 AND 9999 AND file_id_modifier IS NULL)
    OR (format='nacha' AND file_id_modifier ~ '^[A-Z0-9]$' AND file_creation_number IS NULL)
    OR (format IN ('sepa','cemtex','bacs','zengin','cnab240') AND file_creation_number IS NULL AND file_id_modifier IS NULL)
    OR (format='rbc_std152' AND file_creation_number IS NOT NULL AND file_creation_number BETWEEN 1 AND 9999 AND file_id_modifier IS NULL)
  ) NOT VALID;
ALTER TABLE public.pay_run_bank_files VALIDATE CONSTRAINT pay_run_bank_files_format_numbering;

COMMENT ON CONSTRAINT pay_run_bank_files_format ON public.pay_run_bank_files IS
  'Supported payroll bank-file formats, including RBC STD152 Canadian-bank credits.';
COMMENT ON CONSTRAINT pay_run_bank_files_format_numbering ON public.pay_run_bank_files IS
  'RBC STD152 and CPA005 use creation numbers; NACHA uses a file modifier; other formats retain their native identifiers.';
