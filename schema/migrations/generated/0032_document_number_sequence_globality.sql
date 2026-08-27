-- OpenBooks forward migration 0032_document_number_sequence_globality.
--
-- `documents` enforces UNIQUE (org_id, kind, document_number) without any
-- subsidiary column: a document number is an organization-wide identity. The
-- numbering configuration, however, allowed one independent `number_sequences`
-- row PER SUBSIDIARY per kind, and several generators picked the row by
-- subsidiary. Two subsidiaries configured for the same prefix therefore both
-- allocated the same number and the second document died on the documents
-- unique index mid-close — an otherwise-valid transaction lost to numbering.
-- The script journal path compounded it by always using the org-wide row while
-- the UI used subsidiary rows for the same kind.
--
-- THE POLICY (one canonical invariant): document numbers are organization-wide,
-- so the sequence configuration guarantees organization-wide disjoint output.
-- Exactly ONE number_sequences row exists per (org_id, document_kind), always
-- the org-wide row (subsidiary_id IS NULL). Storage enforces it for every
-- writer — setup, API, import, pack, and direct SQL alike:
--   * sequences_org_kind_sub becomes UNIQUE (org_id, document_kind);
--   * number_sequences_org_wide_sequence CHECKs subsidiary_id IS NULL;
--   * the allocator engine module is the single allocation path.
--
-- MONOTONIC SAFETY: allocated_through records the highest number ever issued
-- (watermark trigger). Once a sequence has issued anything, its counter cannot
-- move backward and its output format (prefix/padding/kind) is frozen — an
-- admin reset from 500 back to 1 would otherwise reproduce existing numbers
-- and fail every subsequent document transactionally. Advancing forward stays
-- legal (the controlled "skip ahead" operation); a never-used sequence remains
-- fully configurable, and an unused one can be deleted and recreated.
--
-- TENANT DATA IS PRESERVED by an explicit deterministic upgrade: every legacy
-- per-subsidiary counter is merged into the org-wide row, moving the counter
-- past both every configured counter and every document number ever issued
-- under the surviving prefix, so the merge can never reissue an existing
-- number. The repair ships as a rerunnable function (this migration calls it
-- once) so the same deterministic upgrade remains available to operators.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- 1. Allocation watermark: the highest number this row has ever issued.
-- ---------------------------------------------------------------------------

ALTER TABLE public.number_sequences
  ADD COLUMN IF NOT EXISTS allocated_through integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.number_sequences.allocated_through IS
  'openbooks:document_number_watermark:v1 - highest document number this sequence has issued; counters are monotonic once used';

-- ---------------------------------------------------------------------------
-- 2. Deterministic legacy repair: coalesce per-subsidiary counters into the
-- org-wide row. Rerunnable; after enforcement lands it is a no-op on healthy
-- data and remains the documented upgrade for operators restoring legacy rows.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.openbooks_repair_document_sequences() RETURNS void
LANGUAGE plpgsql AS $repair$
DECLARE
  rec record;
  repair_prefix text;
  merged_next integer;
  issued_max bigint;
BEGIN
  -- Kinds that already have a single org-wide row only need their watermark
  -- raised: treat the stored counter as consumed so the repair never lowers
  -- what any tenant has already reached. Only never-watermarked rows (the
  -- pre-0032 state) are touched, so a rerun never reinterprets a counter the
  -- repair itself normalized.
  UPDATE public.number_sequences seq
     SET allocated_through = seq.next_number
   WHERE seq.allocated_through = 0
     AND seq.subsidiary_id IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.number_sequences other
        WHERE other.org_id = seq.org_id
          AND other.document_kind = seq.document_kind
          AND other.subsidiary_id IS NOT NULL);

  -- Kinds that still carry per-subsidiary rows collapse into ONE org-wide
  -- row. Output continuity: the org-wide prefix wins when present (otherwise
  -- the lexicographically greatest per-subsidiary prefix), gapless survives
  -- if any row requested it, and the counter moves past BOTH every configured
  -- counter AND every document number ever issued under the surviving prefix
  -- — so the merged row can never reproduce an existing document number.
  -- The merge is an explicit update-then-insert (this runs before the new
  -- unique constraint exists, so conflict targets are not yet available);
  -- it is migration/maintenance-time code with no concurrent writers.
  FOR rec IN
    SELECT org_id,
           document_kind,
           bool_or(gapless) AS gapless,
           max(prefix) FILTER (WHERE subsidiary_id IS NULL) AS org_prefix,
           max(next_number) FILTER (WHERE subsidiary_id IS NULL) AS org_next,
           max(prefix) AS any_prefix
      FROM public.number_sequences
     GROUP BY org_id, document_kind
     HAVING count(*) FILTER (WHERE subsidiary_id IS NOT NULL) > 0
  LOOP
    repair_prefix := COALESCE(rec.org_prefix, rec.any_prefix);
    -- The highest numeric suffix already issued under the surviving prefix.
    -- A prefix containing LIKE metacharacters can only over-match into a
    -- strictly larger floor — gaps, never collisions. The stored counter is
    -- last-issued semantics, so the merge floors it at this value and the
    -- next allocation hands out exactly the number after the last one issued.
    SELECT max(substring(d.document_number FROM length(repair_prefix) + 1)::bigint)
      INTO issued_max
      FROM public.documents d
     WHERE d.org_id = rec.org_id
       AND d.kind = rec.document_kind
       AND d.document_number LIKE repair_prefix || '%'
       AND substring(d.document_number FROM length(repair_prefix) + 1) ~ '^[0-9]+$';
    merged_next := GREATEST(COALESCE(rec.org_next, 1), COALESCE(issued_max, 0));

    UPDATE public.number_sequences seq
       SET prefix = repair_prefix,
           next_number = GREATEST(seq.next_number, merged_next),
           allocated_through = GREATEST(seq.allocated_through, merged_next),
           gapless = rec.gapless
     WHERE seq.org_id = rec.org_id
       AND seq.document_kind = rec.document_kind
       AND seq.subsidiary_id IS NULL;
    IF NOT FOUND THEN
      INSERT INTO public.number_sequences
        (org_id, document_kind, subsidiary_id, prefix, next_number, allocated_through)
      VALUES
        (rec.org_id, rec.document_kind, NULL, repair_prefix, merged_next, merged_next);
    END IF;
  END LOOP;

  -- The merged org-wide rows now own every counter; the per-subsidiary rows
  -- are configuration, not history, and nothing else references them.
  DELETE FROM public.number_sequences WHERE subsidiary_id IS NOT NULL;
END
$repair$;

COMMENT ON FUNCTION public.openbooks_repair_document_sequences() IS
  'openbooks:document_sequence_global_repair:v1 - deterministic merge of legacy per-subsidiary number_sequences rows into the org-wide row; rerunnable';

SELECT public.openbooks_repair_document_sequences();

-- ---------------------------------------------------------------------------
-- 3. Storage enforcement: one org-wide sequence per (organization, kind).
-- ---------------------------------------------------------------------------

ALTER TABLE public.number_sequences
  DROP CONSTRAINT IF EXISTS sequences_org_kind_sub;

ALTER TABLE public.number_sequences
  ADD CONSTRAINT sequences_org_kind_sub UNIQUE (org_id, document_kind);

ALTER TABLE public.number_sequences
  ADD CONSTRAINT number_sequences_org_wide_sequence CHECK (subsidiary_id IS NULL);

ALTER TABLE public.number_sequences
  ADD CONSTRAINT number_sequences_next_number_positive CHECK (next_number >= 1);

ALTER TABLE public.number_sequences
  ADD CONSTRAINT number_sequences_allocated_through_nonnegative
  CHECK (allocated_through >= 0);

COMMENT ON CONSTRAINT number_sequences_org_wide_sequence
  ON public.number_sequences IS
  'openbooks:document_number_sequence_globality:v1 - document numbers are organization-wide identities (documents UNIQUE org/kind/number), so sequences allocate from one org-wide row; per-subsidiary sequences cannot produce disjoint output and are refused';

COMMENT ON CONSTRAINT sequences_org_kind_sub
  ON public.number_sequences IS
  'openbooks:document_number_sequence_globality:v1 - exactly one numbering sequence per organization and document kind';

-- ---------------------------------------------------------------------------
-- 4. Monotonic safety: counters only move forward once used, and a used
-- sequence cannot change the output it promised (prefix/padding/kind).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.number_sequences_allocation_watermark() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.allocated_through := GREATEST(NEW.allocated_through, NEW.next_number);
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.number_sequences_allocation_watermark() IS
  'openbooks:document_number_watermark:v1 - every counter advance raises the allocation watermark';

-- UPDATE-only: an allocation either inserts a fresh row (next_number 1,
-- nothing issued before it) or advances an existing counter, so the watermark
-- tracks exactly the consumed range while a freshly created, never-allocated
-- sequence (allocated_through 0) remains fully configurable.
CREATE TRIGGER number_sequences_allocation_watermark
  BEFORE UPDATE OF next_number, allocated_through
  ON public.number_sequences
  FOR EACH ROW EXECUTE FUNCTION public.number_sequences_allocation_watermark();

CREATE OR REPLACE FUNCTION public.number_sequences_monotonic_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.allocated_through > 0 THEN
    IF NEW.next_number < OLD.allocated_through THEN
      RAISE EXCEPTION
        'document sequence % for kind % has already allocated through %; a used counter cannot move backward — advance it forward instead',
        OLD.prefix, OLD.document_kind, OLD.allocated_through;
    END IF;
    IF NEW.prefix IS DISTINCT FROM OLD.prefix
       OR NEW.padding IS DISTINCT FROM OLD.padding
       OR NEW.document_kind IS DISTINCT FROM OLD.document_kind THEN
      RAISE EXCEPTION
        'document sequence % for kind % has already issued numbers; its prefix, padding and kind are frozen once used',
        OLD.prefix, OLD.document_kind;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.number_sequences_monotonic_guard() IS
  'openbooks:document_number_monotonic_guard:v1 - a used sequence cannot decrease into an occupied output range or change the format it issued; applies to setup edits, imports and direct writes alike';

CREATE TRIGGER number_sequences_monotonic_guard
  BEFORE UPDATE
  ON public.number_sequences
  FOR EACH ROW EXECUTE FUNCTION public.number_sequences_monotonic_guard();
