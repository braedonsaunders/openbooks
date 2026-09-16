-- OpenBooks forward migration 0150_applications_org_line_indexes.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Per-line open-balance probes (module-home customers/purchasing, cash
-- open-items, payments) correlate `applications` with
-- `x.org_id = $org AND (x.to_line_id = $line OR x.from_line_id = $line) AND
-- x.unapplied_at IS NULL`. The only line-leading indexes are app_from and
-- app_to, so on a database where one tenant owns the vast majority of
-- application rows every small tenant's probe BitmapOrs over that tenant's
-- index entries. Org-leading composites bind each OR arm to the probing
-- tenant's own slice.
--
-- Additive, ledger-tracked, no history reinterpretation: index-only, no row
-- or trigger changes. See engine/src/worker notes in the b03 wave-7 ledger
-- (bulk-aggregate aging rewrite) for the measurement context.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE INDEX IF NOT EXISTS applications_org_from_idx
  ON public.applications USING btree (org_id, from_line_id);
CREATE INDEX IF NOT EXISTS applications_org_to_idx
  ON public.applications USING btree (org_id, to_line_id);
