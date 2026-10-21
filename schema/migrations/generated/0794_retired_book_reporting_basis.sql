-- Retiring an accounting book preserves its historical reporting basis.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.reporting_book_ids(p_org uuid,p_book uuid) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
DECLARE selected accounting_books%ROWTYPE;
BEGIN
 SELECT * INTO selected FROM accounting_books WHERE org_id=p_org AND id=p_book;
 IF NOT FOUND THEN RAISE EXCEPTION 'The selected reporting book is unavailable.' USING ERRCODE='23514'; END IF;
 IF NOT selected.is_primary AND selected.posts_gl AND selected.replication_mode='adjustment_only' THEN
  IF EXISTS(SELECT 1 FROM subsidiaries s WHERE s.org_id=p_org AND s.is_active
    AND public.accounting_book_currency(p_org,p_book,s.id)<>s.base_currency) THEN
   RAISE EXCEPTION 'Primary plus adjustments requires the same measurement currency in both books. Use a full translated book for another currency.' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting_books WHERE org_id=p_org AND is_primary AND is_active AND posts_gl) THEN
   RAISE EXCEPTION 'Primary plus adjustments requires an active primary posting book.' USING ERRCODE='23514'; END IF;
  RETURN QUERY SELECT id FROM accounting_books WHERE org_id=p_org AND is_primary AND is_active AND posts_gl;
 END IF;
 RETURN NEXT selected.id;
END $$;
