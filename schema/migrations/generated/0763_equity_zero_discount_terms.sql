-- A SAFE or convertible note may state a 0% discount. A stated 0% discount
-- converts at the round price exactly as an absent one does, but it is a term
-- the instrument records as written, so it stays distinct from no discount.
-- An MFN election or its reversal carries the terms it adopts or restores,
-- which may include such a discount. Only the lower bound of each discount
-- check widens; every existing row satisfies the new checks.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.equity_securities DROP CONSTRAINT equity_securities_discount;
ALTER TABLE public.equity_securities ADD CONSTRAINT equity_securities_discount
  CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent < 100));

ALTER TABLE public.equity_security_amendments DROP CONSTRAINT equity_security_amendments_discount;
ALTER TABLE public.equity_security_amendments ADD CONSTRAINT equity_security_amendments_discount
  CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent < 100));

SELECT public.openbooks_refresh_query_catalog();
