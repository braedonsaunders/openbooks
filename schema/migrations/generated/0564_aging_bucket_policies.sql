-- OpenBooks forward migration 0564_aging_bucket_policies.
-- Effective-dated, org-scoped aging bucket policies: the ascending day
-- boundaries that turn days-past-due into bucket indexes. The row with the
-- latest effective_from on or before a date governs that date. With no policy
-- configured, readers use the single declared default (30/60/90, the buckets
-- the product has always rendered) rather than inventing buckets per screen.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- GiST operator classes for the uuid scope column behind the overlap guard.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- Storage sanity bound for a bucket ladder: a one-dimensional, one-based,
-- non-empty list of strictly ascending positive day counts. This guards the
-- column against garbage; bucket COUNT policy stays with the reader, which
-- resolves any conforming ladder deterministically.
CREATE FUNCTION public.aging_boundaries_valid(boundaries integer[]) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $$
  SELECT coalesce(array_length(boundaries, 1), 0) >= 1
     AND array_ndims(boundaries) = 1
     AND array_lower(boundaries, 1) = 1
     AND NOT EXISTS (
       SELECT 1 FROM unnest(boundaries) WITH ORDINALITY AS b(day, ord)
        WHERE b.day IS NULL OR b.day < 1 OR b.day > 36500
           OR (b.ord > 1 AND b.day <= boundaries[(b.ord - 1)::int])
     );
$$;

CREATE TABLE public.aging_bucket_policies (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 boundaries integer[] NOT NULL,
 effective_from date NOT NULL,
 effective_to date,
 is_active boolean DEFAULT true NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE(org_id,id),
 CONSTRAINT aging_bucket_policies_boundaries_check CHECK (public.aging_boundaries_valid(boundaries)),
 CONSTRAINT aging_bucket_policies_effective_from_range CHECK (effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 CONSTRAINT aging_bucket_policies_window_valid CHECK (effective_to IS NULL OR (effective_to >= effective_from AND effective_to <= DATE '9999-12-31'))
);

-- One active policy window per organization: inclusive date windows may not
-- overlap and a null end is open-ended, so a boundary change never
-- reinterprets history aged under the previous ladder.
ALTER TABLE public.aging_bucket_policies
  ADD CONSTRAINT aging_bucket_policies_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    (daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]')) WITH &&
  )
  WHERE (is_active);

COMMENT ON CONSTRAINT aging_bucket_policies_no_active_overlap
  ON public.aging_bucket_policies IS
  'openbooks:aging_bucket_policies_no_active_overlap:v1 - one active aging bucket policy window per organization; NULL effective_to is open-ended';

CREATE INDEX aging_bucket_policies_scope ON public.aging_bucket_policies USING btree (org_id, is_active, effective_from);

ALTER TABLE public.aging_bucket_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aging_bucket_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.aging_bucket_policies
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.aging_bucket_policies IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.aging_bucket_policies IS
 'Effective-dated aging bucket policy per organization: ascending day boundaries turning days-past-due into bucket indexes. The row with the latest effective_from on or before a date governs that date.';

-- A policy version is retained exactly as entered. Closing its window or
-- deactivating it stays possible; rewriting its ladder does not — that takes
-- a new effective-dated version.
CREATE FUNCTION public.aging_bucket_policies_history_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Aging bucket policy history is preserved; deactivate the version instead of deleting it in Setup → Company → Aging bucket policies'
   USING ERRCODE = '23514';
 END IF;
 IF ROW(OLD.org_id, OLD.id, OLD.boundaries, OLD.effective_from, OLD.created_at, OLD.created_by)
    IS DISTINCT FROM
    ROW(NEW.org_id, NEW.id, NEW.boundaries, NEW.effective_from, NEW.created_at, NEW.created_by) THEN
   RAISE EXCEPTION 'Aging bucket policy versions are immutable; close the window (set its effective-to) and create a new version in Setup → Company → Aging bucket policies'
   USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aging_bucket_policies_history_guard
 BEFORE UPDATE OR DELETE ON public.aging_bucket_policies
 FOR EACH ROW EXECUTE FUNCTION public.aging_bucket_policies_history_guard();

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('aging_bucket_policies', '0564_aging_bucket_policies')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
