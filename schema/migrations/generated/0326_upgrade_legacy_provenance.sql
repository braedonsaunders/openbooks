-- OpenBooks forward migration 0326_upgrade_legacy_provenance.
--
-- Upgrades 0274, 0292, 0293, 0297, 0298 and 0299 each backfilled history the
-- old code never recorded: rules stamped version 1 after in-place edits,
-- rate pins copied from the live profile, executed waivers without a frozen
-- print image, retention actions inherited from the live schedule, posted
-- duplicate subjects, posted negative counts. That history cannot be
-- re-derived — inventing it (calling a backfilled row authoritative) is the
-- defect class these rows fix. This migration therefore creates the ONE
-- shared legacy-provenance registry every lane reads (convention agreed with
-- the release lane P1B): upgrade_legacy_provenance records, per tenant, the
-- exact rows whose past is unverified or grandfathered, keyed by the
-- migration that introduced the uncertainty and the subject table and row.
-- Readers refuse or label by membership (engine helper
-- engine/src/platform/legacy-provenance.ts), never by note text, so notes
-- stay rewordable without breaking reads.
--
-- Retrospective criteria (fail closed: an unrecorded ledger timestamp marks
-- every existing row rather than none, via COALESCE to now()):
--   0297 recognition_rules pre-versioning rows: created at or before 0297
--     applied and referenced by any performance obligation. Referenced-only:
--     an unreferenced rule's current row IS the policy new obligations are
--     built under (post-upgrade edits version properly), so there is no
--     invented history to mark. Timestamps compare with <= because the
--     runner applies each migration in one transaction and now() is frozen
--     across the body and its ledger insert.
--   0298 item_rate_version_profiles backfilled pins: pinned at or before
--     0298 applied. Writer pins for post-upgrade versions carry later
--     timestamps and stay unmarked.
--   0292 lien_waivers executed without a snapshot: executed_snapshot IS NULL
--     with status signed, or void with signed_at set. State-based (no time
--     bound): post-upgrade signings stamp the snapshot, so a snapshot-less
--     executed waiver is legacy whenever it was created.
--   0274 hrm_documents inherited retention actions: retention_action and
--     retention_rule_id present, completed before 0274 applied, and untouched
--     since (updated_at at or before 0274 applied, which excludes clocks the
--     post-upgrade tick started honestly). Residual, stated: a backfilled
--     document touched after the upgrade no longer matches and is missed.
--   0293 stock_count_lines duplicate subjects in posted counts, and 0299
--     lines with a negative counted_quantity in posted counts.
--     State-based on the posted predicate (stock_counts.status = 'posted',
--     the engine immutability gate): posted history is immutable, so these
--     rows stand grandfathered and are recorded whenever they exist.
--
-- Re-runnable: every INSERT collides on the primary key when replayed, and
-- a conflict means the row is already recorded — expected and benign, so
-- ON CONFLICT DO NOTHING carries that justification and no other.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS public.upgrade_legacy_provenance (
  org_id uuid NOT NULL,
  migration text NOT NULL,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  note text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT upgrade_legacy_provenance_pkey PRIMARY KEY (org_id, migration, table_name, row_id),
  CONSTRAINT upgrade_legacy_provenance_migration_present CHECK (char_length(btrim(migration)) > 0),
  CONSTRAINT upgrade_legacy_provenance_table_present CHECK (char_length(btrim(table_name)) > 0),
  CONSTRAINT upgrade_legacy_provenance_note_present CHECK (char_length(btrim(note)) > 0)
);

COMMENT ON TABLE public.upgrade_legacy_provenance IS 'Shared registry of rows whose pre-upgrade history was backfilled, not recorded (0326). Readers refuse or label by (org, migration, table, row) membership; notes are human evidence, never read keys.';
COMMENT ON COLUMN public.upgrade_legacy_provenance.migration IS 'The migration whose backfill introduced the uncertainty (e.g. 0297_recognition_rule_versions). Part of the read key.';
COMMENT ON COLUMN public.upgrade_legacy_provenance.table_name IS 'Subject table of the legacy row (e.g. recognition_rules). No row FK by design: one registry points at many tables; integrity comes from the 0326 backfill and release-lane assertions.';
COMMENT ON COLUMN public.upgrade_legacy_provenance.note IS 'Why this row is legacy and what it means. Matched verbatim by release-lane assertions; readers must not key off it.';

ALTER TABLE ONLY public.upgrade_legacy_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.upgrade_legacy_provenance FORCE ROW LEVEL SECURITY;
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'upgrade_legacy_provenance' AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.upgrade_legacy_provenance
      USING ((current_setting('app.bypass_rls', true) = 'on') OR (org_id::text = current_setting('app.current_org', true)))
      WITH CHECK ((current_setting('app.bypass_rls', true) = 'on') OR (org_id::text = current_setting('app.current_org', true)));
  END IF;
END;
$policy$;

-- 0297: rules that predate versioning and are pinned by any obligation. Their
-- pinned row may be a later in-place edit, not the policy the obligation was
-- built under.
INSERT INTO public.upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
SELECT r.org_id,
       '0297_recognition_rule_versions',
       'recognition_rules',
       r.id,
       'rule predates versioning; pre-upgrade policy edits were made in place so the pinned row may not be the policy its obligations were built under — unverified legacy'
  FROM public.recognition_rules r
 WHERE r.created_at <= COALESCE(
         (SELECT applied_at FROM public._applied_migrations WHERE filename = 'generated/0297_recognition_rule_versions.sql'),
         now())
   AND EXISTS (
         SELECT 1 FROM public.performance_obligations o
          WHERE o.org_id = r.org_id AND o.recognition_rule_id = r.id
       )
ON CONFLICT DO NOTHING;

-- 0298: pins the backfill copied from the live profile; the governing policy
-- at version time was never recorded.
INSERT INTO public.upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
SELECT p.org_id,
       '0298_item_rate_version_profile_pins',
       'item_rate_version_profiles',
       p.id,
       'rate pin backfilled from the live profile; governing policy at version time unrecorded — unverified legacy'
  FROM public.item_rate_version_profiles p
 WHERE p.created_at <= COALESCE(
         (SELECT applied_at FROM public._applied_migrations WHERE filename = 'generated/0298_item_rate_version_profile_pins.sql'),
         now())
ON CONFLICT DO NOTHING;

-- 0292: waivers executed before the frozen print image existed.
INSERT INTO public.upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
SELECT w.org_id,
       '0292_lien_waiver_executed_snapshot',
       'lien_waivers',
       w.id,
       'executed before execution snapshots existed; print image not frozen at signing — unverified legacy'
  FROM public.lien_waivers w
 WHERE w.executed_snapshot IS NULL
   AND (w.status = 'signed' OR (w.status = 'void' AND w.signed_at IS NOT NULL))
ON CONFLICT DO NOTHING;

-- 0274: completions whose frozen action was inherited from the live
-- schedule, not captured at completion.
INSERT INTO public.upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
SELECT d.org_id,
       '0274_retention_action_completion_snapshot',
       'hrm_documents',
       d.id,
       'retention action inherited from the live schedule; governing action at completion unrecorded — unverified legacy'
  FROM public.hrm_documents d
 WHERE d.retention_action IS NOT NULL
   AND d.retention_rule_id IS NOT NULL
   AND d.completed_at IS NOT NULL
   AND d.completed_at <= COALESCE(
         (SELECT applied_at FROM public._applied_migrations WHERE filename = 'generated/0274_retention_action_completion_snapshot.sql'),
         now())
   AND d.updated_at <= COALESCE(
         (SELECT applied_at FROM public._applied_migrations WHERE filename = 'generated/0274_retention_action_completion_snapshot.sql'),
         now())
ON CONFLICT DO NOTHING;

-- 0293: duplicate subjects that already posted stand; posted history is
-- corrected by reversal, never rewritten.
INSERT INTO public.upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
SELECT l.org_id,
       '0293_stock_count_line_subject_unique',
       'stock_count_lines',
       l.id,
       'duplicate subject posted before the 0293 guard; double-posted variance stands — grandfathered legacy'
  FROM public.stock_count_lines l
  JOIN public.stock_counts c ON c.id = l.stock_count_id AND c.org_id = l.org_id
 WHERE c.status = 'posted'
   AND EXISTS (
         SELECT 1 FROM public.stock_count_lines s
          WHERE s.org_id = l.org_id
            AND s.stock_count_id = l.stock_count_id
            AND s.item_id = l.item_id
            AND s.stock_location_id = l.stock_location_id
            AND s.lot_id IS NOT DISTINCT FROM l.lot_id
            AND s.id <> l.id
       )
ON CONFLICT DO NOTHING;

-- 0299: negative counts that already posted stand for the same reason.
INSERT INTO public.upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
SELECT l.org_id,
       '0299_stock_count_line_counted_nonnegative',
       'stock_count_lines',
       l.id,
       'negative count posted before the 0299 guard; phantom variance stands — grandfathered legacy'
  FROM public.stock_count_lines l
  JOIN public.stock_counts c ON c.id = l.stock_count_id AND c.org_id = l.org_id
 WHERE c.status = 'posted'
   AND l.counted_quantity IS NOT NULL
   AND l.counted_quantity < 0
ON CONFLICT DO NOTHING;
