-- OpenBooks forward migration 0524_family_price_schedules.
-- Family-level price schedules: item_price_schedules gains a nullable
-- family_id so one schedule can price every variant of a product family.
-- Exactly one of item_id / family_id is set; the level-or-customer scope
-- shape, effective dating, revisioning and quantity breaks are unchanged, and
-- a variant's own schedule keeps precedence over its family's. Overlap
-- protection mirrors the item-scoped exclusion guards at family scope. The
-- existing item guards are untouched: a NULL subject key never collides in
-- the exclusion, so family rows cannot disturb item windows and vice versa.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.item_price_schedules ADD COLUMN IF NOT EXISTS family_id uuid;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.item_price_schedules'::regclass
       AND attname = 'item_id' AND attnotnull
  ) THEN
    ALTER TABLE public.item_price_schedules ALTER COLUMN item_id DROP NOT NULL;
  END IF;
END
$$;

-- Staged guards (U12): each new CHECK and foreign key arrives NOT VALID (a
-- short lock that still enforces every new write — safe here because no
-- existing row can violate: every schedule written before this migration is
-- item-scoped) and a later statement VALIDATEs it under a lock that blocks
-- neither reads nor writes. Each step is replay-safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_subject'
  ) THEN
    ALTER TABLE public.item_price_schedules
      ADD CONSTRAINT item_price_schedule_subject
      CHECK ((item_id IS NULL) <> (family_id IS NULL))
      NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_subject'
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.item_price_schedules
      VALIDATE CONSTRAINT item_price_schedule_subject;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_family_fk'
  ) THEN
    ALTER TABLE public.item_price_schedules
      ADD CONSTRAINT item_price_schedule_family_fk
      FOREIGN KEY (org_id, family_id) REFERENCES public.item_families (org_id, id)
      NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_family_fk'
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.item_price_schedules
      VALIDATE CONSTRAINT item_price_schedule_family_fk;
  END IF;
END
$$;
-- Exclusion constraints cannot be marked NOT VALID, so these two arrive
-- validated in one step. The scan is trivial: no row carries a family_id
-- before this migration, so no existing row can violate either guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_family_general_no_overlap'
  ) THEN
    ALTER TABLE public.item_price_schedules
      ADD CONSTRAINT item_price_schedule_family_general_no_overlap
      EXCLUDE USING gist (
        org_id WITH =,
        family_id WITH =,
        currency WITH =,
        price_level_id WITH =,
        daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
      ) WHERE (is_active AND customer_id IS NULL AND family_id IS NOT NULL);
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_family_customer_no_overlap'
  ) THEN
    ALTER TABLE public.item_price_schedules
      ADD CONSTRAINT item_price_schedule_family_customer_no_overlap
      EXCLUDE USING gist (
        org_id WITH =,
        family_id WITH =,
        currency WITH =,
        customer_id WITH =,
        daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
      ) WHERE (is_active AND customer_id IS NOT NULL AND family_id IS NOT NULL);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS item_price_schedule_family_lookup
  ON public.item_price_schedules (org_id, family_id, currency, effective_from DESC)
  WHERE is_active AND family_id IS NOT NULL;
