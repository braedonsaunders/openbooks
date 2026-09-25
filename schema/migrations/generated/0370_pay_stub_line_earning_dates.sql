-- OpenBooks forward migration 0370_pay_stub_line_earning_dates.
-- Preserve the civil dates supported by each pay-stub earning amount.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.pay_stub_lines
  ADD COLUMN earned_from date,
  ADD COLUMN earned_to date,
  ADD CONSTRAINT pay_stub_lines_earning_dates_pair CHECK (
    (earned_from IS NULL AND earned_to IS NULL) OR
    (earned_from IS NOT NULL AND earned_to IS NOT NULL AND earned_from <= earned_to)
  );
