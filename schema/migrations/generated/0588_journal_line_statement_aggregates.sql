-- Maintain monthly ledger summaries once per inserted account group rather
-- than once per journal line. Row guards and amendment/delete maintenance stay
-- unchanged; the statement aggregate participates in the same transaction.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE FUNCTION public.openbooks_gl_activity_insert_statement() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_catalog AS $function$
BEGIN
  INSERT INTO public.gl_month_activity AS g
    (org_id,account_id,book_id,month,subsidiary_id,debit_total,credit_total,line_count)
  SELECT e.org_id,l.account_id,e.book_id,date_trunc('month',e.posting_date)::date,l.subsidiary_id,
    sum(greatest(l.amount,0)),sum(greatest(-l.amount,0)),count(*)
  FROM inserted_journal_lines l
  JOIN public.journal_entries e ON e.id=l.entry_id AND e.org_id=l.org_id
  WHERE e.status IN ('posted','reversed')
  GROUP BY e.org_id,l.account_id,e.book_id,date_trunc('month',e.posting_date)::date,l.subsidiary_id
  -- Acquire grouped summary keys in a deterministic order.
  ORDER BY e.org_id,l.account_id,e.book_id,date_trunc('month',e.posting_date)::date,l.subsidiary_id
  ON CONFLICT (org_id,account_id,book_id,month,subsidiary_id) DO UPDATE
    SET debit_total=g.debit_total+excluded.debit_total,
        credit_total=g.credit_total+excluded.credit_total,
        line_count=g.line_count+excluded.line_count;
  RETURN NULL;
END $function$;

-- Keep the existing tenant-aware UPDATE and authorized DELETE behavior. Only
-- INSERT summary maintenance moves to the transition-table statement trigger.
DROP TRIGGER gl_activity_line ON public.journal_lines;
CREATE TRIGGER gl_activity_line AFTER UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.openbooks_gl_activity_line();
CREATE TRIGGER gl_activity_insert_statement AFTER INSERT ON public.journal_lines
  REFERENCING NEW TABLE AS inserted_journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.openbooks_gl_activity_insert_statement();
