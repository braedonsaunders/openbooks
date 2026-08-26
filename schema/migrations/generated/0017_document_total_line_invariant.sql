-- OpenBooks forward migration 0017_document_total_line_invariant.
--
-- documents.subtotal / tax_total / total are denormalized header copies of the
-- document's own lines ("fast lists"). Until now nothing in storage tied them
-- together: no trigger recomputed them and no constraint compared them to the
-- lines, so any writer (or import) that got the arithmetic wrong was silently
-- accepted -- and documents_posted_financial_guard then FROZE the wrong value
-- once the document posted. That exact violation shipped in real tenant data:
-- progress invoices carried total and subtotal overstated by the retained
-- holdback because their headers ignored the negative retainage line while the
-- ledger, which posts from the LINES, stayed penny-perfect.
--
-- This migration makes the invariant real at the storage boundary:
--
--   * Commercial kinds: subtotal = sum(line amounts), tax_total =
--     sum(line tax_amounts), total = subtotal + tax_total.
--   * Journal-shaped kinds ('journal', 'pay_run'): the lines are signed legs
--     that balance to zero, and the header is the debit-side view --
--     total = sum(positive amounts), tax_total = sum(tax_amounts),
--     subtotal = total - tax_total.
--
-- An immediate line trigger refreshes the denormalized header after every
-- financial line mutation. This preserves existing native writers that append
-- a line and refresh the list header in separate statements, while still
-- placing the invariant in storage. DEFERRED constraint triggers on BOTH
-- tables validate the finished shape at COMMIT, so a contradictory header
-- write is rejected and concurrent or reordered mutations cannot strand a
-- stale total. A document with no lines has no line evidence to contradict;
-- the posting kernel separately refuses to post that shape.
--
-- Rollout heals drifted legacy rows from their own lines under the governed
-- amend flag before installing the triggers. The ledger needs no repair: the
-- posting kernel always built entries from the lines, never from the header.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.assert_document_totals_match_lines(p_document_id uuid, p_org_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_kind             text;
    v_stored_subtotal  numeric;
    v_stored_tax       numeric;
    v_stored_total     numeric;
    v_line_count       integer;
    v_amount_sum       numeric;
    v_tax_sum          numeric;
    v_debit_sum        numeric;
    v_want_subtotal    numeric;
    v_want_tax         numeric;
    v_want_total       numeric;
BEGIN
    -- Teardown wipes may delete or rewrite anything. The raw flag matches the
    -- existing posted-document guard; the scoped helper covers sandbox rows.
    IF coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' THEN
        RETURN;
    END IF;
    IF public.openbooks_sandbox_wipe_allowed(p_org_id) THEN
        RETURN;
    END IF;

    SELECT kind, subtotal, tax_total, total
      INTO v_kind, v_stored_subtotal, v_stored_tax, v_stored_total
      FROM public.documents
     WHERE id = p_document_id AND org_id = p_org_id;
    IF NOT FOUND THEN
        RETURN; -- the document row was deleted later in this transaction
    END IF;

    SELECT count(*)::int,
           coalesce(sum(l.amount), 0),
           coalesce(sum(l.tax_amount), 0),
           coalesce(sum(l.amount) FILTER (WHERE l.amount > 0), 0)
      INTO v_line_count, v_amount_sum, v_tax_sum, v_debit_sum
      FROM public.document_lines l
     WHERE l.document_id = p_document_id AND l.org_id = p_org_id;

    -- Empty drafts may exist before their first line. Once a line mutation
    -- occurs, the refresh trigger writes zero when the last line is removed.
    IF v_line_count = 0 THEN
        RETURN;
    END IF;

    IF v_kind IN ('journal', 'pay_run') THEN
        v_want_tax := v_tax_sum;
        v_want_total := v_debit_sum;
        v_want_subtotal := v_debit_sum - v_tax_sum;
    ELSE
        v_want_subtotal := v_amount_sum;
        v_want_tax := v_tax_sum;
        v_want_total := v_amount_sum + v_tax_sum;
    END IF;

    IF v_stored_subtotal IS DISTINCT FROM v_want_subtotal
       OR v_stored_tax IS DISTINCT FROM v_want_tax
       OR v_stored_total IS DISTINCT FROM v_want_total THEN
        RAISE EXCEPTION
            'document % header totals do not tie to its lines: stored subtotal %, tax_total %, total % but its % line(s) sum to subtotal %, tax_total %, total %',
            p_document_id, v_stored_subtotal, v_stored_tax, v_stored_total,
            v_line_count, v_want_subtotal, v_want_tax, v_want_total
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_document_totals_match_lines(uuid, uuid) IS
  'openbooks:document_total_line_invariant:v1 - rejects committed document headers whose subtotal/tax_total/total disagree with their own lines (debit-side totals for journal-shaped kinds)';

CREATE OR REPLACE FUNCTION public.refresh_document_totals_from_lines(p_document_id uuid, p_org_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_kind          text;
    v_line_count    integer;
    v_amount_sum    numeric;
    v_tax_sum       numeric;
    v_debit_sum     numeric;
    v_want_subtotal numeric;
    v_want_total    numeric;
BEGIN
    IF coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' THEN
        RETURN;
    END IF;
    IF public.openbooks_sandbox_wipe_allowed(p_org_id) THEN
        RETURN;
    END IF;

    SELECT kind
      INTO v_kind
      FROM public.documents
     WHERE id = p_document_id AND org_id = p_org_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT count(*)::int,
           coalesce(sum(l.amount), 0),
           coalesce(sum(l.tax_amount), 0),
           coalesce(sum(l.amount) FILTER (WHERE l.amount > 0), 0)
      INTO v_line_count, v_amount_sum, v_tax_sum, v_debit_sum
      FROM public.document_lines l
     WHERE l.document_id = p_document_id AND l.org_id = p_org_id;

    IF v_kind IN ('journal', 'pay_run') THEN
        v_want_total := v_debit_sum;
        v_want_subtotal := v_debit_sum - v_tax_sum;
    ELSE
        v_want_subtotal := v_amount_sum;
        v_want_total := v_amount_sum + v_tax_sum;
    END IF;

    UPDATE public.documents d
       SET subtotal = v_want_subtotal,
           tax_total = v_tax_sum,
           total = v_want_total,
           updated_at = greatest(clock_timestamp(), d.updated_at + interval '1 microsecond')
     WHERE d.id = p_document_id
       AND d.org_id = p_org_id
       AND (d.subtotal, d.tax_total, d.total) IS DISTINCT FROM
           (v_want_subtotal, v_tax_sum, v_want_total);
END;
$$;

COMMENT ON FUNCTION public.refresh_document_totals_from_lines(uuid, uuid) IS
  'openbooks:document_total_line_refresh:v1 - refreshes denormalized document totals after a financial line mutation';

CREATE OR REPLACE FUNCTION public.document_lines_total_line_refresh() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF tg_op = 'DELETE' THEN
        PERFORM public.refresh_document_totals_from_lines(old.document_id, old.org_id);
    ELSIF tg_op = 'UPDATE' THEN
        IF (old.document_id, old.org_id) IS DISTINCT FROM (new.document_id, new.org_id) THEN
            PERFORM public.refresh_document_totals_from_lines(old.document_id, old.org_id);
        END IF;
        PERFORM public.refresh_document_totals_from_lines(new.document_id, new.org_id);
    ELSE
        PERFORM public.refresh_document_totals_from_lines(new.document_id, new.org_id);
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.documents_total_line_tieout() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM public.assert_document_totals_match_lines(new.id, new.org_id);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.document_lines_total_line_tieout() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF tg_op = 'DELETE' THEN
        PERFORM public.assert_document_totals_match_lines(old.document_id, old.org_id);
    ELSIF tg_op = 'UPDATE' THEN
        IF (old.document_id, old.org_id) IS DISTINCT FROM (new.document_id, new.org_id) THEN
            PERFORM public.assert_document_totals_match_lines(old.document_id, old.org_id);
        END IF;
        PERFORM public.assert_document_totals_match_lines(new.document_id, new.org_id);
    ELSE
        PERFORM public.assert_document_totals_match_lines(new.document_id, new.org_id);
    END IF;
    RETURN NULL;
END;
$$;

-- Heal drifted legacy headers from their own lines before enforcement lands.
-- Runs under the amend flag because posted financial identity is otherwise
-- frozen; deriving from the lines is the direction that cannot drift.
SELECT set_config('openbooks.amend', 'on', false);

WITH line_agg AS (
    SELECT d.id AS document_id,
           d.org_id,
           d.kind,
           count(l.id)::int AS line_count,
           coalesce(sum(l.amount), 0) AS amount_sum,
           coalesce(sum(l.tax_amount), 0) AS tax_sum,
           coalesce(sum(l.amount) FILTER (WHERE l.amount > 0), 0) AS debit_sum
      FROM public.documents d
      LEFT JOIN public.document_lines l ON l.document_id = d.id AND l.org_id = d.org_id
     GROUP BY d.id, d.org_id, d.kind
)
UPDATE public.documents d
   SET subtotal = CASE WHEN a.kind IN ('journal', 'pay_run')
                       THEN a.debit_sum - a.tax_sum
                       ELSE a.amount_sum END,
       tax_total = a.tax_sum,
       total = CASE WHEN a.kind IN ('journal', 'pay_run')
                    THEN a.debit_sum
                    ELSE a.amount_sum + a.tax_sum END,
       updated_at = greatest(clock_timestamp(), d.updated_at + interval '1 microsecond')
  FROM line_agg a
 WHERE a.document_id = d.id
   AND a.org_id = d.org_id
   AND a.line_count > 0
   AND (d.subtotal, d.tax_total, d.total) IS DISTINCT FROM
       ((CASE WHEN a.kind IN ('journal', 'pay_run')
              THEN a.debit_sum - a.tax_sum
              ELSE a.amount_sum END),
        a.tax_sum,
        (CASE WHEN a.kind IN ('journal', 'pay_run')
              THEN a.debit_sum
              ELSE a.amount_sum + a.tax_sum END));

SELECT set_config('openbooks.amend', 'off', false);

-- Install through catalog checks so a replay is idempotent.
DO $document_lines_total_line_refresh_install$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'document_lines'
           AND t.tgname = 'document_lines_total_line_refresh'
           AND NOT t.tgisinternal
    ) THEN
        CREATE TRIGGER document_lines_total_line_refresh
            AFTER INSERT OR DELETE OR UPDATE OF amount, tax_amount, document_id, org_id
            ON public.document_lines
            FOR EACH ROW EXECUTE FUNCTION public.document_lines_total_line_refresh();
    END IF;
END
$document_lines_total_line_refresh_install$;

DO $documents_total_line_tieout_install$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'documents'
           AND t.tgname = 'documents_total_line_tieout'
           AND NOT t.tgisinternal
    ) THEN
        CREATE CONSTRAINT TRIGGER documents_total_line_tieout
            AFTER INSERT OR UPDATE ON public.documents
            DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION public.documents_total_line_tieout();
    END IF;
END
$documents_total_line_tieout_install$;

DO $document_lines_total_line_tieout_install$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'document_lines'
           AND t.tgname = 'document_lines_total_line_tieout'
           AND NOT t.tgisinternal
    ) THEN
        CREATE CONSTRAINT TRIGGER document_lines_total_line_tieout
            AFTER INSERT OR UPDATE OR DELETE ON public.document_lines
            DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION public.document_lines_total_line_tieout();
    END IF;
END
$document_lines_total_line_tieout_install$;
