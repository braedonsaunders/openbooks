-- OpenBooks forward migration 0048_rate_book_currency_serialization.
--
-- rate_book_currency_guard rejected a currency change only when a committed
-- item_rate_versions row was visible. The first version's INSERT held no lock
-- on the book, so a concurrent currency UPDATE could pass that existence
-- check while first-version creation was still in flight; both committed and
-- the freshly-authored cost/bill rates were relabeled as another currency.
--
-- Version creation now takes a FOR SHARE lock on the tenant-owned book row
-- before the insert, mirroring the account classification contract (0046).
-- FOR SHARE conflicts with every row update, so the inserting transaction
-- pins the book through commit: a racing currency UPDATE wakes only after the
-- first version is visible to the guard's existence check and is then
-- rejected. API, import, and direct writers share the contract because the
-- lock lives in the trigger, not the route; the Setup writer's
-- item-rate-books:<org> advisory fence continues to order whole transactions
-- at the API boundary.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.rate_version_book_lock_guard() RETURNS trigger
    LANGUAGE plpgsql VOLATILE
    AS $$
BEGIN
  PERFORM 1
    FROM public.item_rate_books book
   WHERE book.id = NEW.rate_book_id
     AND book.org_id = NEW.org_id
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rate version must reference a tenant-owned rate book'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS item_rate_versions_book_lock ON public.item_rate_versions;
CREATE TRIGGER item_rate_versions_book_lock
  BEFORE INSERT ON public.item_rate_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.rate_version_book_lock_guard();

COMMENT ON FUNCTION public.rate_version_book_lock_guard() IS
  'openbooks:rate_version_book_lock_guard:v1 - holds a FOR SHARE lock on the tenant-owned rate book from before a version insert until commit, so a concurrent currency change cannot pass the history check while first-version creation is in flight';
