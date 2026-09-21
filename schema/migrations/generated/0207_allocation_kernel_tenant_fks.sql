-- OpenBooks forward migration 0207_allocation_kernel_tenant_fks.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- 0160's own comment says "Tenant-coherent foreign keys (composite where the
-- parent exposes (org_id, id))" and does that for department, location,
-- project, subsidiary, accounts, and journal_entries. In the same block it
-- installed three single-column edges: allocation_rule_targets.class_id →
-- classes(id), allocation_lineage.journal_line_id → journal_lines(id), and
-- allocation_runs.book_id → accounting_books(id). classes and journal_lines
-- are 0044 anchors with (org_id, id) unique indexes; accounting_books has
-- accounting_books_org_id_id_unique from 0038. A target, run, or lineage row
-- in org A could therefore reference another tenant's class, journal line,
-- or book. RLS cannot close that: it is evaluated in the current session,
-- not while the FK is maintained.
--
-- This forward repair replaces those three names with composite
-- (org_id, …) foreign keys and adds the missing source_journal_line_id
-- composite (0160 never declared one). 0160 is not rewritten. Existing
-- evidence is never rewritten or discarded. The preflight reports the
-- first cross-organization or orphaned reference and aborts before any
-- constraint or index changes. Clean installations and upgrades then
-- receive the same storage invariant, and replay is idempotent.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $allocation_kernel_tenant_fks_preflight$
DECLARE
  violation record;
BEGIN
  SELECT child.ctid::text AS child_ctid,
         child.org_id::text AS child_org_id,
         child.class_id::text AS class_id,
         parent.org_id::text AS referenced_org_id
    INTO violation
    FROM public.allocation_rule_targets child
    LEFT JOIN public.classes parent
      ON parent.id = child.class_id
   WHERE child.class_id IS NOT NULL
     AND (parent.id IS NULL OR parent.org_id IS DISTINCT FROM child.org_id)
   ORDER BY child.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.allocation_rule_targets.class_id',
      DETAIL = jsonb_build_object(
        'table', 'allocation_rule_targets',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'class_id', violation.class_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the class pointer to a class owned by the same organization, then retry migration 0207; this migration will not rewrite financial evidence.';
  END IF;

  SELECT child.ctid::text AS child_ctid,
         child.org_id::text AS child_org_id,
         child.journal_line_id::text AS journal_line_id,
         parent.org_id::text AS referenced_org_id
    INTO violation
    FROM public.allocation_lineage child
    LEFT JOIN public.journal_lines parent
      ON parent.id = child.journal_line_id
   WHERE child.journal_line_id IS NOT NULL
     AND (parent.id IS NULL OR parent.org_id IS DISTINCT FROM child.org_id)
   ORDER BY child.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.allocation_lineage.journal_line_id',
      DETAIL = jsonb_build_object(
        'table', 'allocation_lineage',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'journal_line_id', violation.journal_line_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the journal-line pointer to a line owned by the same organization, then retry migration 0207; this migration will not rewrite financial evidence.';
  END IF;

  SELECT child.ctid::text AS child_ctid,
         child.org_id::text AS child_org_id,
         child.source_journal_line_id::text AS source_journal_line_id,
         parent.org_id::text AS referenced_org_id
    INTO violation
    FROM public.allocation_lineage child
    LEFT JOIN public.journal_lines parent
      ON parent.id = child.source_journal_line_id
   WHERE child.source_journal_line_id IS NOT NULL
     AND (parent.id IS NULL OR parent.org_id IS DISTINCT FROM child.org_id)
   ORDER BY child.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.allocation_lineage.source_journal_line_id',
      DETAIL = jsonb_build_object(
        'table', 'allocation_lineage',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'source_journal_line_id', violation.source_journal_line_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the source journal-line pointer to a line owned by the same organization, then retry migration 0207; this migration will not rewrite financial evidence.';
  END IF;

  SELECT child.ctid::text AS child_ctid,
         child.org_id::text AS child_org_id,
         child.book_id::text AS book_id,
         parent.org_id::text AS referenced_org_id
    INTO violation
    FROM public.allocation_runs child
    LEFT JOIN public.accounting_books parent
      ON parent.id = child.book_id
   WHERE parent.id IS NULL
      OR parent.org_id IS DISTINCT FROM child.org_id
   ORDER BY child.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.allocation_runs.book_id',
      DETAIL = jsonb_build_object(
        'table', 'allocation_runs',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'book_id', violation.book_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the book pointer to an accounting book owned by the same organization, then retry migration 0207; this migration will not rewrite financial evidence.';
  END IF;
END
$allocation_kernel_tenant_fks_preflight$;

-- PostgreSQL requires an exact unique key for every composite foreign key.
-- 0038/0044 already install these names; IF NOT EXISTS keeps a replay or an
-- installation that already provisioned the key from failing needlessly.
CREATE UNIQUE INDEX IF NOT EXISTS classes_org_id_id_unique
  ON public.classes USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS journal_lines_org_id_id_unique
  ON public.journal_lines USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_books_org_id_id_unique
  ON public.accounting_books USING btree (org_id, id);

-- 0160's constraints have the same names but the wrong one-column shape.
-- Drop each before installing the tenant-coherent definition. The explicit
-- DROP also makes a replay converge from the already-correct shape.
ALTER TABLE public.allocation_rule_targets
  DROP CONSTRAINT IF EXISTS allocation_rule_targets_class_id_fkey;

ALTER TABLE public.allocation_rule_targets
  ADD CONSTRAINT allocation_rule_targets_class_id_fkey
  FOREIGN KEY (org_id, class_id)
  REFERENCES public.classes (org_id, id)
  DEFERRABLE NOT VALID;

ALTER TABLE public.allocation_rule_targets
  VALIDATE CONSTRAINT allocation_rule_targets_class_id_fkey;

ALTER TABLE public.allocation_lineage
  DROP CONSTRAINT IF EXISTS allocation_lineage_journal_line_id_fkey;

ALTER TABLE public.allocation_lineage
  ADD CONSTRAINT allocation_lineage_journal_line_id_fkey
  FOREIGN KEY (org_id, journal_line_id)
  REFERENCES public.journal_lines (org_id, id)
  DEFERRABLE NOT VALID;

ALTER TABLE public.allocation_lineage
  VALIDATE CONSTRAINT allocation_lineage_journal_line_id_fkey;

ALTER TABLE public.allocation_lineage
  DROP CONSTRAINT IF EXISTS allocation_lineage_source_journal_line_id_fkey;

ALTER TABLE public.allocation_lineage
  ADD CONSTRAINT allocation_lineage_source_journal_line_id_fkey
  FOREIGN KEY (org_id, source_journal_line_id)
  REFERENCES public.journal_lines (org_id, id)
  DEFERRABLE NOT VALID;

ALTER TABLE public.allocation_lineage
  VALIDATE CONSTRAINT allocation_lineage_source_journal_line_id_fkey;

ALTER TABLE public.allocation_runs
  DROP CONSTRAINT IF EXISTS allocation_runs_book_id_fkey;

ALTER TABLE public.allocation_runs
  ADD CONSTRAINT allocation_runs_book_id_fkey
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.accounting_books (org_id, id)
  DEFERRABLE NOT VALID;

ALTER TABLE public.allocation_runs
  VALIDATE CONSTRAINT allocation_runs_book_id_fkey;

COMMENT ON CONSTRAINT allocation_rule_targets_class_id_fkey
  ON public.allocation_rule_targets IS
  'openbooks:allocation_rule_targets.tenant_coherence:v1 - class references must remain within the target organization';

COMMENT ON CONSTRAINT allocation_lineage_journal_line_id_fkey
  ON public.allocation_lineage IS
  'openbooks:allocation_lineage.tenant_coherence:v1 - journal-line references must remain within the lineage organization';

COMMENT ON CONSTRAINT allocation_lineage_source_journal_line_id_fkey
  ON public.allocation_lineage IS
  'openbooks:allocation_lineage.tenant_coherence:v1 - source journal-line references must remain within the lineage organization';

COMMENT ON CONSTRAINT allocation_runs_book_id_fkey
  ON public.allocation_runs IS
  'openbooks:allocation_runs.tenant_coherence:v1 - book references must remain within the run organization';
