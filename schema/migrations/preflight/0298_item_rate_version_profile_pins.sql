-- OpenBooks upgrade preflight for 0298_item_rate_version_profile_pins (U9).
--
-- Read-only notice naming the (version, item) pairs whose backfilled pin
-- may certify the wrong policy: policy changes were never recorded, so a
-- version saved before its item's profile was last edited is pinned to the
-- CURRENT profile values — exactly how it resolves today, but unverifiable
-- as history. This file deliberately does NOT reference the
-- item_rate_version_profiles table the migration creates: preflights run
-- before their migration. Zero rows means every version postdates its
-- profile's last edit.
SELECT '0298.stale_pin' AS code,
       'notice' AS severity,
       format('rate version %s item %s (org %s) saved %s before its profile last changed %s',
              v.id, l.item_id, l.org_id, v.created_at, p.updated_at) AS subject,
       format('version %s predates the last edit of item %s profile (policy %s, base unit %s, presentation %s); the backfill pins these current values as the version-time policy',
              v.id, l.item_id, p.pricing_policy, p.base_unit, p.invoice_presentation) AS detail,
       'Confirm each listed pin matches the policy in force when the version was saved. After the upgrade these pins are marked unverified legacy in upgrade_legacy_provenance (the governing policy at version time was never recorded); versions saved after this migration pin correctly going forward.' AS remedy
  FROM (SELECT DISTINCT l.org_id, l.version_id, l.item_id
          FROM public.item_rate_lines l
          JOIN public.item_rate_profiles p
            ON p.org_id = l.org_id AND p.item_id = l.item_id) l
  JOIN public.item_rate_versions v
    ON v.org_id = l.org_id AND v.id = l.version_id
  JOIN public.item_rate_profiles p
    ON p.org_id = l.org_id AND p.item_id = l.item_id
 WHERE v.created_at < p.updated_at
 ORDER BY l.org_id, v.id, l.item_id
 LIMIT 20;
