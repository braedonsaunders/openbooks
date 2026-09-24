-- OpenBooks forward migration 0336_document_line_price_basis.
--
-- A priced line used to keep only its unit price: the lineage behind the
-- price (which level, assignment and schedule resolved it, and at which
-- instant) lived nowhere, so any later replay or same-date recompute
-- re-resolved from live configuration. Revoke the assignment at 11am and a
-- 10am line replays to the base price while its audit still claims Gold —
-- priced lineage destroyed. document_lines.price_basis records the
-- provenance the resolver returned at pricing time (kind, schedule/level/
-- assignment ids, resolved instant and price); replay and audit read the
-- recorded basis, never a re-resolution, and the referenced rows still
-- exist because revocations keep them (0327 never deletes a started row).
-- Lines priced by hand carry no basis (null): replay then reads the stored
-- unit price, as before. Converted lines (quote to order to invoice) copy
-- the basis with the price, so lineage survives conversion.
--
-- The column is nullable with no default: a metadata-only change that
-- rewrites no rows.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.document_lines ADD COLUMN IF NOT EXISTS price_basis jsonb;

COMMENT ON COLUMN public.document_lines.price_basis IS
  'Pricing provenance stamped at pricing time: {kind, scheduleId, levelId, assignmentId, unitPrice, resolvedAt}. Null for hand-priced lines.';
