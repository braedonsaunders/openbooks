-- OpenBooks upgrade preflight for 0292_lien_waiver_executed_snapshot (U6).
--
-- Read-only notice: executed waivers predate frozen execution images, so
-- their prints regenerate from live rows — renaming a vendor or rewording
-- a project silently rewrites an already-executed legal release. The
-- predicate equals m72's derived legacy predicate (signed, or void with a
-- signing instant). This file deliberately does NOT reference the
-- executed_snapshot column the migration adds: preflights run before their
-- migration, so on every install where 0292 is pending the column does not
-- exist yet (and where 0292 already applied, this preflight never runs).
-- Zero rows means no executed waiver needs legacy handling.
SELECT '0292.unsnapshotted_waiver' AS code,
       'notice' AS severity,
       format('lien waiver %s (org %s project %s party %s) is %s with no frozen execution image',
              w.id, w.org_id, w.project_id, w.party_id, w.status) AS subject,
       format('waiver %s was executed before execution snapshots existed; its print regenerates from live parties/projects/documents rows',
              w.id) AS detail,
       'No pre-upgrade action. After the upgrade these waivers are recorded as unverified legacy in upgrade_legacy_provenance and their prints are frozen-or-refused as legacy; re-execute any release a counterparty must rely on.' AS remedy
  FROM public.lien_waivers w
 WHERE w.status = 'signed'
    OR (w.status = 'void' AND w.signed_at IS NOT NULL)
 ORDER BY w.org_id, w.id
 LIMIT 20;
