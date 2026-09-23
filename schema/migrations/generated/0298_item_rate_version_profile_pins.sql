-- OpenBooks forward migration 0298_item_rate_version_profile_pins.
--
-- Item-rate pricing read the LIVE item_rate_profiles row before choosing the
-- historical version, so switching a policy (or base unit, or invoice
-- presentation) for next month silently repriced late entries dated in the
-- old month: the old tier version resolved, but the new policy priced it
-- (8 units on tiers 1/$10, 4/$30, 6/$50 priced $70 under capped_ladder,
-- then $60 as two 4-packs after a later switch to lowest_cost).
--
-- Pricing policy, base unit and invoice presentation become properties of
-- each immutable rate version instead. item_rate_version_profiles pins one
-- row per (version, item) at save time, and resolution reads the SELECTED
-- version's pin, never the live profile. The profile row remains as the
-- defaults for NEW versions only. A per-(version, item) pin table (rather
-- than columns on item_rate_versions) is required because one version is a
-- whole-book snapshot carrying lines for many items, each with its own
-- policy: the book-replacement writer stores several items per version, and
-- the single-item writer carries every other item's lines forward.
--
-- Backfill assumption, stated: policy changes were never recorded, so no
-- stored history can reconstruct which policy governed an old version. Every
-- existing (version, item) with lines is pinned to the item's CURRENT
-- profile values, which is exactly how those versions resolve today — the
-- backfill changes nothing observable, and the fix takes effect for versions
-- saved after this migration. (Version, item) pairs with lines but no
-- profile row are left unpinned; resolution falls back to the live profile
-- there, preserving today's behavior.
--
-- PRC10 note: no adjustment-target CHECK change ships here. The target-type
-- CHECK admits 'labor' and 'material' since the baseline (verified at
-- 0001_baseline.sql:10477 and against the live constraint), which is the
-- only CHECK the adjustments shard reported needing — and it is already
-- satisfied, so a restating migration would enforce nothing new. (The
-- price-schedule revision token for the schedule-versioning fence lives with
-- that shard's own ordinal, not here.)

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

CREATE TABLE public.item_rate_version_profiles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  version_id uuid NOT NULL,
  item_id uuid NOT NULL,
  base_unit text NOT NULL,
  pricing_policy text NOT NULL,
  invoice_presentation text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT item_rate_version_profiles_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT item_rate_version_profiles_version_item_unique UNIQUE (version_id, item_id),
  CONSTRAINT item_rate_version_profiles_base_unit_present CHECK (char_length(btrim(base_unit)) > 0),
  CONSTRAINT item_rate_version_profiles_pricing_policy CHECK (pricing_policy IN ('explicit', 'capped_ladder', 'lowest_cost')),
  CONSTRAINT item_rate_version_profiles_invoice_presentation CHECK (invoice_presentation IN ('summary', 'rate_components')),
  CONSTRAINT item_rate_version_profiles_version_fk FOREIGN KEY (org_id, version_id)
    REFERENCES public.item_rate_versions (org_id, id),
  CONSTRAINT item_rate_version_profiles_item_fk FOREIGN KEY (org_id, item_id)
    REFERENCES public.items (org_id, id)
);
CREATE INDEX item_rate_version_profiles_item_lookup
  ON public.item_rate_version_profiles (org_id, item_id, version_id);

ALTER TABLE ONLY public.item_rate_version_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.item_rate_version_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.item_rate_version_profiles
  USING ((current_setting('app.bypass_rls', true) = 'on') OR (org_id::text = current_setting('app.current_org', true)))
  WITH CHECK ((current_setting('app.bypass_rls', true) = 'on') OR (org_id::text = current_setting('app.current_org', true)));

COMMENT ON TABLE public.item_rate_version_profiles IS 'Per-(version, item) pin of the pricing policy, base unit and invoice presentation in force when that rate version was saved (0298). Resolution reads the selected version''s pin; item_rate_profiles keeps only the defaults for new versions.';
COMMENT ON COLUMN public.item_rate_version_profiles.pricing_policy IS 'Pinned at version save; later profile edits must never rewrite it.';
COMMENT ON COLUMN public.item_rate_version_profiles.base_unit IS 'Pinned at version save; later profile edits must never rewrite it.';
COMMENT ON COLUMN public.item_rate_version_profiles.invoice_presentation IS 'Pinned at version save; later profile edits must never rewrite it.';

CREATE VIEW openbooks_query.item_rate_version_profiles WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    version_id,
    item_id,
    base_unit,
    pricing_policy,
    invoice_presentation,
    created_at,
    created_by,
    updated_at,
    updated_by
   FROM public.item_rate_version_profiles
  WHERE (org_id = public.openbooks_query_org_id());

GRANT SELECT ON TABLE openbooks_query.item_rate_version_profiles TO openbooks_read;

-- Backfill: pin every existing (version, item) with lines to the item's
-- current profile values (see assumption above).
INSERT INTO public.item_rate_version_profiles (org_id, version_id, item_id, base_unit, pricing_policy, invoice_presentation)
SELECT l.org_id, l.version_id, l.item_id, p.base_unit, p.pricing_policy, p.invoice_presentation
  FROM public.item_rate_lines l
  JOIN public.item_rate_profiles p ON p.org_id = l.org_id AND p.item_id = l.item_id
 GROUP BY l.org_id, l.version_id, l.item_id, p.base_unit, p.pricing_policy, p.invoice_presentation;
