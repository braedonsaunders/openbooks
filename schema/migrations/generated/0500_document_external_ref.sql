-- Carry the originating external reference on every document for storefront and integrator dedupe.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The channel or integrator's own identity for the document (their order,
-- invoice, or payment id), plus which external system minted it. Nullable:
-- native documents carry no external reference. Opaque provider-assigned
-- tokens, never customer contact data.
ALTER TABLE public.documents ADD COLUMN external_ref text;
ALTER TABLE public.documents ADD COLUMN external_source text;
-- The reference is meaningless without its source and vice versa: a lone
-- ref would slip the dedupe index (NULL sources never collide), so storage
-- refuses the half-filled pair and blank strings outright.
ALTER TABLE public.documents ADD CONSTRAINT documents_external_ref_source_pair
  CHECK ((external_ref IS NULL) = (external_source IS NULL));
ALTER TABLE public.documents ADD CONSTRAINT documents_external_ref_nonblank
  CHECK (external_ref IS NULL OR length(btrim(external_ref)) > 0);
ALTER TABLE public.documents ADD CONSTRAINT documents_external_source_nonblank
  CHECK (external_source IS NULL OR length(btrim(external_source)) > 0);
-- Dedupe key for inbound storefront and integrator writes: one external
-- reference names at most one document per org and source. Partial, so the
-- NULL reference on every native document is unconstrained. The pair check
-- above keeps NULL sources out of the indexed rows, so NULLS NOT DISTINCT
-- handling is unnecessary.
CREATE UNIQUE INDEX documents_org_external_ref
  ON public.documents(org_id, external_source, external_ref)
  WHERE external_ref IS NOT NULL;
