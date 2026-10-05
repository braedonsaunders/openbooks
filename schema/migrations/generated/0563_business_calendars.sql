-- OpenBooks forward migration 0563_business_calendars.
-- Organization business calendars: which weekday starts the week, which days
-- are the weekend, and which statutory holidays apply, effective-dated per
-- organization with an optional per-subsidiary override. A subsidiary reads
-- its own calendar where one covers the date, otherwise the org-wide row.
-- Statutory days resolve from the payroll packs at read time through the one
-- pack reader, never as copied rows; company closures live in
-- payroll_holidays, which already expresses one-off and recurring closures.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- GiST operator classes for the uuid scope columns behind the overlap guard.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- Storage sanity bound for the weekend set: a one-dimensional list of at
-- most six distinct ISO weekdays. Seven would leave no business day at all
-- and is refused here, not averaged away downstream; an empty list states
-- explicitly that no weekday is a weekend day.
CREATE FUNCTION public.business_calendar_weekend_valid(days smallint[]) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $$
  SELECT days IS NOT NULL
     AND (cardinality(days) = 0 OR array_ndims(days) = 1)
     AND cardinality(days) < 7
     AND NOT EXISTS (
       SELECT 1 FROM unnest(days) AS day
        WHERE day IS NULL OR day < 1 OR day > 7
     )
     AND (SELECT count(*) FROM unnest(days) AS day)
       = (SELECT count(DISTINCT day) FROM unnest(days) AS day);
$$;

CREATE TABLE public.org_business_calendars (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid,
 week_starts_on smallint NOT NULL,
 weekend_days smallint[] NOT NULL,
 holiday_country char(2),
 holiday_region text,
 effective_from date NOT NULL,
 effective_to date,
 is_active boolean DEFAULT true NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE(org_id,id),
 CONSTRAINT org_business_calendars_subsidiary_tenant_fk
   FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT org_business_calendars_week_start_check CHECK (week_starts_on BETWEEN 1 AND 7),
 CONSTRAINT org_business_calendars_weekend_days_check CHECK (public.business_calendar_weekend_valid(weekend_days)),
 CONSTRAINT org_business_calendars_country_check CHECK (holiday_country IS NULL OR holiday_country ~ '^[A-Z]{2}$'),
 CONSTRAINT org_business_calendars_region_check CHECK (holiday_region IS NULL OR (holiday_region <> '' AND length(holiday_region) BETWEEN 1 AND 16)),
 CONSTRAINT org_business_calendars_region_needs_country CHECK (holiday_region IS NULL OR holiday_country IS NOT NULL),
 CONSTRAINT org_business_calendars_effective_from_range CHECK (effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 CONSTRAINT org_business_calendars_window_valid CHECK (effective_to IS NULL OR (effective_to >= effective_from AND effective_to <= DATE '9999-12-31'))
);

-- One active window per scope (organization, or one subsidiary): inclusive
-- date windows may not overlap and a null end is open-ended. The null
-- subsidiary (the org-wide calendar) is its own scope, so an entity override
-- never collides with the fallback it overrides.
ALTER TABLE public.org_business_calendars
  ADD CONSTRAINT org_business_calendars_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    (coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]')) WITH &&
  )
  WHERE (is_active);

COMMENT ON CONSTRAINT org_business_calendars_no_active_overlap
  ON public.org_business_calendars IS
  'openbooks:org_business_calendars_no_active_overlap:v1 - one active business calendar window per organization or subsidiary; NULL effective_to is open-ended';

CREATE INDEX org_business_calendars_scope ON public.org_business_calendars USING btree (org_id, subsidiary_id, is_active, effective_from);

ALTER TABLE public.org_business_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_business_calendars FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.org_business_calendars
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.org_business_calendars IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.org_business_calendars IS
 'Effective-dated business calendar per organization or subsidiary: ISO week start (1=Monday..7=Sunday), weekend days as ISO weekdays, and the country plus optional region whose statutory holidays apply. The row with the latest effective_from on or before a date governs that date.';

-- A calendar version is retained exactly as entered. Closing its window or
-- deactivating it stays possible; rewriting its facts does not — that takes
-- a new effective-dated version.
CREATE FUNCTION public.org_business_calendars_history_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Business calendar history is preserved; deactivate the version instead of deleting it in Setup → Company → Business calendars'
   USING ERRCODE = '23514';
 END IF;
 IF ROW(OLD.org_id, OLD.id, OLD.subsidiary_id, OLD.week_starts_on, OLD.weekend_days,
         OLD.holiday_country, OLD.holiday_region, OLD.effective_from,
         OLD.created_at, OLD.created_by)
    IS DISTINCT FROM
    ROW(NEW.org_id, NEW.id, NEW.subsidiary_id, NEW.week_starts_on, NEW.weekend_days,
        NEW.holiday_country, NEW.holiday_region, NEW.effective_from,
        NEW.created_at, NEW.created_by) THEN
   RAISE EXCEPTION 'Business calendar versions are immutable; close the window (set its effective-to) and create a new version in Setup → Company → Business calendars'
   USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER org_business_calendars_history_guard
 BEFORE UPDATE OR DELETE ON public.org_business_calendars
 FOR EACH ROW EXECUTE FUNCTION public.org_business_calendars_history_guard();

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('org_business_calendars', '0563_business_calendars')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
