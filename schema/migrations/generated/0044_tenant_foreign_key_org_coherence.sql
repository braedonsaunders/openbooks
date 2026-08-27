-- OpenBooks forward migration 0044_tenant_foreign_key_org_coherence.
--
-- The canonical schema has a large graph of tenant-owned anchors (accounts,
-- parties, documents, ledger rows, dimensions, inventory items, and tax
-- setup).  A single-column foreign key into one of those anchors only proves
-- that the id exists; it does not prove that the child and parent belong to
-- the same organization.  RLS cannot supply that invariant because it is
-- evaluated in the current session, not while the FK is maintained.
--
-- This migration is deliberately catalog-driven.  That keeps the forward
-- repair self-maintaining when a reviewed baseline adds another child edge:
-- every effective single-column FK into the explicit tenant-anchor set is
-- preflighted and replaced with an (org_id, id) FK.  Existing FK actions,
-- match mode, and deferrability are retained.  SET NULL/DEFAULT actions name
-- only the original reference column so deleting a parent never clears the
-- child's tenant identity.
--
-- The only explicit exception is tax_group_members.  It is an org-less join
-- row intentionally reached through its two tenant-owned parents.  A
-- deferrable constraint trigger pins both parents to one organization and
-- parent-org updates are fenced with the same semantics as a composite FK.
-- No data is rewritten, deleted, or silently repaired: any legacy mismatch
-- aborts the migration before DDL changes begin.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $preflight$
DECLARE
  reference record;
  violation record;
  tenant_anchors constant text[] := ARRAY[
    'accounts',
    'parties',
    'documents',
    'journal_entries',
    'journal_lines',
    'subsidiaries',
    'projects',
    'departments',
    'locations',
    'classes',
    'items',
    'tax_codes',
    'tax_groups'
  ];
  child_ctid text;
  child_org_id text;
  reference_id text;
  referenced_org_id text;
BEGIN
  -- The org-less bridge has no column onto which PostgreSQL can place a
  -- composite FK.  Fail closed on either a cross-tenant pair or a missing
  -- parent before the guard is installed.
  SELECT m.ctid::text AS child_ctid,
         m.tax_group_id::text AS tax_group_id,
         m.tax_code_id::text AS tax_code_id,
         g.org_id::text AS group_org_id,
         c.org_id::text AS code_org_id
    INTO violation
    FROM public.tax_group_members m
    LEFT JOIN public.tax_groups g ON g.id = m.tax_group_id
    LEFT JOIN public.tax_codes c ON c.id = m.tax_code_id
   WHERE m.tax_group_id IS NOT NULL
     AND m.tax_code_id IS NOT NULL
     AND (g.id IS NULL OR c.id IS NULL OR g.org_id IS DISTINCT FROM c.org_id)
   ORDER BY m.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.tax_group_members',
      DETAIL = jsonb_build_object(
        'table', 'tax_group_members',
        'row', violation.child_ctid,
        'tax_group_id', violation.tax_group_id,
        'tax_code_id', violation.tax_code_id,
        'tax_group_org_id', violation.group_org_id,
        'tax_code_org_id', violation.code_org_id
      )::text,
      HINT = 'Reconcile the tax-group membership to parents in one organization, then retry migration 0044; this migration will not rewrite financial history.';
  END IF;

  -- Every child table in the effective graph carries org_id.  The catalog
  -- query intentionally ignores already-composite edges from migrations
  -- 0038/0039 and any FK into a non-anchor table.
  FOR reference IN
    SELECT constraint_row.oid,
           constraint_row.conname,
           source.relname AS child_table,
           source_column.attname AS child_column,
           target.relname AS parent_table,
           target_column.attname AS parent_column
      FROM pg_catalog.pg_constraint constraint_row
      JOIN pg_catalog.pg_class source
        ON source.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace source_namespace
        ON source_namespace.oid = source.relnamespace
      JOIN pg_catalog.pg_class target
        ON target.oid = constraint_row.confrelid
      JOIN pg_catalog.pg_namespace target_namespace
        ON target_namespace.oid = target.relnamespace
      JOIN LATERAL pg_catalog.unnest(constraint_row.conkey)
        WITH ORDINALITY AS child_key(attnum, position)
        ON child_key.position = 1
      JOIN pg_catalog.pg_attribute source_column
        ON source_column.attrelid = source.oid
       AND source_column.attnum = child_key.attnum
      JOIN LATERAL pg_catalog.unnest(constraint_row.confkey)
        WITH ORDINALITY AS parent_key(attnum, position)
        ON parent_key.position = 1
      JOIN pg_catalog.pg_attribute target_column
        ON target_column.attrelid = target.oid
       AND target_column.attnum = parent_key.attnum
      JOIN pg_catalog.pg_attribute child_org_column
        ON child_org_column.attrelid = source.oid
       AND child_org_column.attname = 'org_id'
      JOIN pg_catalog.pg_attribute parent_org_column
        ON parent_org_column.attrelid = target.oid
       AND parent_org_column.attname = 'org_id'
     WHERE constraint_row.contype = 'f'
       AND pg_catalog.cardinality(constraint_row.conkey) = 1
       AND pg_catalog.cardinality(constraint_row.confkey) = 1
       AND source_namespace.nspname = 'public'
       AND target_namespace.nspname = 'public'
       AND target.relname = ANY (tenant_anchors)
       AND target_column.attname = 'id'
     ORDER BY source.relname, constraint_row.conname
  LOOP
    child_ctid := null;
    child_org_id := null;
    reference_id := null;
    referenced_org_id := null;

    EXECUTE format(
      'SELECT c.ctid::text, c.org_id::text, c.%1$I::text, p.org_id::text
         FROM public.%2$I c
         LEFT JOIN public.%3$I p ON p.id = c.%1$I
        WHERE c.%1$I IS NOT NULL
          AND p.org_id IS DISTINCT FROM c.org_id
        ORDER BY c.ctid
        LIMIT 1',
      reference.child_column,
      reference.child_table,
      reference.parent_table
    )
      INTO child_ctid, child_org_id, reference_id, referenced_org_id;

    IF child_ctid IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'legacy data violates tenant coherence: public.%I.%I',
          reference.child_table,
          reference.child_column
        ),
        DETAIL = jsonb_build_object(
          'table', reference.child_table,
          'row', child_ctid,
          'org_id', child_org_id,
          'column', reference.child_column,
          'reference_id', reference_id,
          'referenced_table', reference.parent_table,
          'referenced_org_id', referenced_org_id
        )::text,
        HINT = 'Reconcile the source evidence to a reference owned by the same organization, then retry migration 0044. This migration will not rewrite financial history.';
    END IF;
  END LOOP;
END
$preflight$;

-- PostgreSQL requires an exact unique key for each composite FK.  The
-- conventional names are stable across fresh and upgraded installations;
-- IF NOT EXISTS also tolerates the keys installed by migrations 0038/0039.
DO $keys$
DECLARE
  anchor text;
  tenant_anchors constant text[] := ARRAY[
    'accounts', 'parties', 'documents', 'journal_entries', 'journal_lines',
    'subsidiaries', 'projects', 'departments', 'locations', 'classes',
    'items', 'tax_codes', 'tax_groups'
  ];
BEGIN
  FOREACH anchor IN ARRAY tenant_anchors LOOP
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (org_id, id)',
      anchor || '_org_id_id_unique',
      anchor
    );
  END LOOP;
END
$keys$;

-- Replace every remaining single-column edge while retaining the original
-- constraint name and all FK actions.  NOT VALID keeps the DDL phase safe for
-- long-lived installations; the explicit VALIDATE runs only after all edges
-- have been replaced and the preflight has passed.
DO $constraints$
DECLARE
  reference record;
  tenant_anchors constant text[] := ARRAY[
    'accounts', 'parties', 'documents', 'journal_entries', 'journal_lines',
    'subsidiaries', 'projects', 'departments', 'locations', 'classes',
    'items', 'tax_codes', 'tax_groups'
  ];
  actions text;
BEGIN
  FOR reference IN
    SELECT constraint_row.conname,
           constraint_row.confdeltype,
           constraint_row.confupdtype,
           constraint_row.confmatchtype,
           constraint_row.condeferrable,
           constraint_row.condeferred,
           source.relname AS child_table,
           source_column.attname AS child_column,
           target.relname AS parent_table,
           target_column.attname AS parent_column
      FROM pg_catalog.pg_constraint constraint_row
      JOIN pg_catalog.pg_class source
        ON source.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace source_namespace
        ON source_namespace.oid = source.relnamespace
      JOIN pg_catalog.pg_class target
        ON target.oid = constraint_row.confrelid
      JOIN pg_catalog.pg_namespace target_namespace
        ON target_namespace.oid = target.relnamespace
      JOIN LATERAL pg_catalog.unnest(constraint_row.conkey)
        WITH ORDINALITY AS child_key(attnum, position)
        ON child_key.position = 1
      JOIN pg_catalog.pg_attribute source_column
        ON source_column.attrelid = source.oid
       AND source_column.attnum = child_key.attnum
      JOIN LATERAL pg_catalog.unnest(constraint_row.confkey)
        WITH ORDINALITY AS parent_key(attnum, position)
        ON parent_key.position = 1
      JOIN pg_catalog.pg_attribute target_column
        ON target_column.attrelid = target.oid
       AND target_column.attnum = parent_key.attnum
      JOIN pg_catalog.pg_attribute child_org_column
        ON child_org_column.attrelid = source.oid
       AND child_org_column.attname = 'org_id'
     WHERE constraint_row.contype = 'f'
       AND pg_catalog.cardinality(constraint_row.conkey) = 1
       AND pg_catalog.cardinality(constraint_row.confkey) = 1
       AND source_namespace.nspname = 'public'
       AND target_namespace.nspname = 'public'
       AND target.relname = ANY (tenant_anchors)
       AND target_column.attname = 'id'
     ORDER BY source.relname, constraint_row.conname
  LOOP
    actions := '';

    CASE reference.confmatchtype
      WHEN 'f' THEN actions := actions || ' MATCH FULL';
      WHEN 'p' THEN actions := actions || ' MATCH PARTIAL';
      ELSE NULL; -- MATCH SIMPLE is PostgreSQL's default.
    END CASE;

    CASE reference.confupdtype
      WHEN 'r' THEN actions := actions || ' ON UPDATE RESTRICT';
      WHEN 'c' THEN actions := actions || ' ON UPDATE CASCADE';
      WHEN 'n' THEN actions := actions || format(' ON UPDATE SET NULL (%I)', reference.child_column);
      WHEN 'd' THEN actions := actions || format(' ON UPDATE SET DEFAULT (%I)', reference.child_column);
      ELSE NULL; -- NO ACTION is PostgreSQL's default.
    END CASE;

    CASE reference.confdeltype
      WHEN 'r' THEN actions := actions || ' ON DELETE RESTRICT';
      WHEN 'c' THEN actions := actions || ' ON DELETE CASCADE';
      WHEN 'n' THEN actions := actions || format(' ON DELETE SET NULL (%I)', reference.child_column);
      WHEN 'd' THEN actions := actions || format(' ON DELETE SET DEFAULT (%I)', reference.child_column);
      ELSE NULL; -- NO ACTION is PostgreSQL's default.
    END CASE;

    IF reference.condeferrable THEN
      actions := actions || ' DEFERRABLE';
      IF reference.condeferred THEN
        actions := actions || ' INITIALLY DEFERRED';
      END IF;
    ELSE
      actions := actions || ' NOT DEFERRABLE';
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%1$I DROP CONSTRAINT %2$I',
      reference.child_table,
      reference.conname
    );
    EXECUTE format(
      'ALTER TABLE public.%1$I ADD CONSTRAINT %2$I
         FOREIGN KEY (org_id, %3$I)
         REFERENCES public.%4$I (org_id, %5$I)%6$s NOT VALID',
      reference.child_table,
      reference.conname,
      reference.child_column,
      reference.parent_table,
      reference.parent_column,
      actions
    );
    EXECUTE format(
      'ALTER TABLE public.%1$I VALIDATE CONSTRAINT %2$I',
      reference.child_table,
      reference.conname
    );
  END LOOP;
END
$constraints$;

-- tax_group_members is the one intentional org-less edge in the effective
-- graph.  Constraint triggers retain the existing DEFERRABLE/NO ACTION FK
-- behavior while making the pair's organization a storage invariant.
CREATE OR REPLACE FUNCTION public.tax_group_members_tenant_coherence_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $function$
DECLARE
  group_org uuid;
  code_org uuid;
BEGIN
  SELECT org_id INTO group_org
    FROM public.tax_groups
   WHERE id = NEW.tax_group_id;
  SELECT org_id INTO code_org
    FROM public.tax_codes
   WHERE id = NEW.tax_code_id;

  -- Missing parents remain the responsibility of the original FKs.  This is
  -- important for deferred insertion order and preserves their error/action
  -- semantics exactly.
  IF group_org IS NULL OR code_org IS NULL THEN
    RETURN NEW;
  END IF;
  IF group_org IS DISTINCT FROM code_org THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'tax_group_members references parents from different organizations',
      DETAIL = jsonb_build_object(
        'tax_group_id', NEW.tax_group_id,
        'tax_code_id', NEW.tax_code_id,
        'tax_group_org_id', group_org,
        'tax_code_org_id', code_org
      )::text;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.tax_group_members_parent_org_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $function$
BEGIN
  IF NEW.org_id IS NOT DISTINCT FROM OLD.org_id THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tax_groups'
     AND EXISTS (
       SELECT 1
         FROM public.tax_group_members member
         JOIN public.tax_codes code ON code.id = member.tax_code_id
        WHERE member.tax_group_id = OLD.id
          AND code.org_id IS DISTINCT FROM NEW.org_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'tax_group_members organization would diverge from tax_group';
  END IF;

  IF TG_TABLE_NAME = 'tax_codes'
     AND EXISTS (
       SELECT 1
         FROM public.tax_group_members member
         JOIN public.tax_groups group_row ON group_row.id = member.tax_group_id
        WHERE member.tax_code_id = OLD.id
          AND group_row.org_id IS DISTINCT FROM NEW.org_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'tax_group_members organization would diverge from tax_code';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tax_group_members_tenant_coherence_trigger
  ON public.tax_group_members;
CREATE CONSTRAINT TRIGGER tax_group_members_tenant_coherence_trigger
AFTER INSERT OR UPDATE ON public.tax_group_members
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION public.tax_group_members_tenant_coherence_guard();

DROP TRIGGER IF EXISTS tax_groups_tax_group_members_org_guard
  ON public.tax_groups;
CREATE CONSTRAINT TRIGGER tax_groups_tax_group_members_org_guard
AFTER UPDATE OF org_id ON public.tax_groups
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION public.tax_group_members_parent_org_guard();

DROP TRIGGER IF EXISTS tax_codes_tax_group_members_org_guard
  ON public.tax_codes;
CREATE CONSTRAINT TRIGGER tax_codes_tax_group_members_org_guard
AFTER UPDATE OF org_id ON public.tax_codes
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION public.tax_group_members_parent_org_guard();

COMMENT ON FUNCTION public.tax_group_members_tenant_coherence_guard() IS
  'openbooks:tax_group_members_tenant_coherence_guard:v1 - explicit org-less bridge exception; both tenant-owned parents must share one organization';
COMMENT ON FUNCTION public.tax_group_members_parent_org_guard() IS
  'openbooks:tax_group_members_parent_org_guard:v1 - parent organization updates cannot strand an org-less tax-group membership';
