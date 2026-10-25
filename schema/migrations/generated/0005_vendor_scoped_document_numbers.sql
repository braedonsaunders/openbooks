-- Make vendor bill and vendor credit numbers unique per vendor instead of per organization.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- A vendor bill or vendor credit may carry the number its vendor issued, and
-- vendors number independently: two vendors may each issue invoice "764".
-- Those kinds become unique per (org, kind, vendor party, number). Every other
-- kind, and a vendor document without a party, stays unique per
-- (org, kind, number). Each new index is implied by the one it replaces, so
-- every existing row already satisfies both.
CREATE UNIQUE INDEX documents_org_kind_party_number
  ON public.documents USING btree (org_id, kind, party_id, document_number)
  WHERE kind IN ('vendor_bill', 'vendor_credit') AND party_id IS NOT NULL;

DROP INDEX public.documents_org_kind_number;

CREATE UNIQUE INDEX documents_org_kind_number
  ON public.documents USING btree (org_id, kind, document_number)
  WHERE kind NOT IN ('vendor_bill', 'vendor_credit') OR party_id IS NULL;
