-- A document-number sequence stores the number it issued most recently; the
-- allocator issues next_number + 1. A sequence that has issued nothing yet
-- stores 0, so an operator who sets the next number to 1 receives 1.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.number_sequences
  DROP CONSTRAINT number_sequences_next_number_positive;

ALTER TABLE public.number_sequences
  ADD CONSTRAINT number_sequences_next_number_nonnegative CHECK (next_number >= 0);

COMMENT ON COLUMN public.number_sequences.next_number IS
  'openbooks:document_number_position:v1 - the number this sequence issued most recently (0 before the first); the next allocation issues next_number + 1';
