-- Let payment terms fall due on a fixed day of the month ("Net 30, 1st following").
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- A nullable day of month (1-31). Null keeps the existing meaning: due
-- net_days after the document date. When set, the terms fall due on that day
-- of the first month in which it lands more than net_days after the document
-- date; a day past a short month's end falls on its last day. Every existing
-- row is null, so no stored terms change meaning.
ALTER TABLE public.payment_terms ADD COLUMN due_day_of_month smallint;

ALTER TABLE public.payment_terms
  ADD CONSTRAINT payment_terms_due_day_of_month_range CHECK (due_day_of_month BETWEEN 1 AND 31);

COMMENT ON COLUMN public.payment_terms.due_day_of_month IS 'Day of the month the terms fall due (31 = month end): the first such day more than net_days after the document date. Null when the terms are due net_days after the document date.';

-- Expose the new column through the governed query views.
SELECT public.openbooks_refresh_query_catalog();
