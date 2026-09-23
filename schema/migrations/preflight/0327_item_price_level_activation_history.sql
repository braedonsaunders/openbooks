-- OpenBooks upgrade preflight for 0327_item_price_level_activation_history.
--
-- Read-only NOTICE (migration bytes carry the fix; the upgrade proceeds
-- either way). 0327 versions level activation as history and end-dates
-- membership, and touches two pre-existing shapes while doing it:
--
-- (a) assignment_open_window_end_dated: a deactivated assignment whose
-- window is still open (effective_to NULL or covering today), started before
-- today. The old model flipped only the flag, so the resolver's new window
-- read would resurrect it for current dates; 0327 end-dates it to the day
-- before its last touch (deactivation is the only write such rows receive),
-- floored at effective_from. Predicate owned by m74 plus the PRC15c same-day
-- carve-out: NOT is_active AND effective_from <> current_date AND
-- (effective_to IS NULL OR effective_to >= current_date) — exactly the
-- migration's own backfill predicate, so the pre-upgrade count IS the number
-- of rows the upgrade will end-date. Zero rows means no window moves.
--
-- (c) assignment_same_day_revoked_removed: a deactivated assignment starting
-- today with an open window (PRC15c). End-dating it would violate the dates
-- CHECK and any storable window would still price today, so 0327 removes the
-- never-effective row to match the post-upgrade trigger. Zero rows means no
-- removal.
--
-- (b) inactive_level_historical_active: a level deactivated before
-- versioned activation existed. Its deactivation instant was never
-- recorded, so 0327 opens its history as a standing offer and past
-- transaction dates resolve it as offered; today and the future keep
-- reading the inactive flag. Predicate owned by m74: NOT is_active.
-- Zero rows means no level carries that residual.
SELECT '0327.assignment_open_window_end_dated' AS code,
       'notice' AS severity,
       format('customer_price_level_assignments %s (org %s) for customer %s on level %s, window %s to %s',
              a.id, a.org_id, a.customer_id, a.price_level_id,
              a.effective_from, coalesce(a.effective_to::text, 'open')) AS subject,
       format('deactivated assignment %s still covers today; 0327 end-dates its window to the day before its last touch so historical pricing keeps the window while current dates stop matching it',
              a.id) AS detail,
       'No action required: the upgrade end-dates the window deterministically. If the assignment should be live instead, reactivate it and set its window explicitly after the upgrade.' AS remedy
  FROM public.customer_price_level_assignments a
 WHERE NOT a.is_active
   AND a.effective_from <> current_date
   AND (a.effective_to IS NULL OR a.effective_to >= current_date)
UNION ALL
SELECT '0327.assignment_same_day_revoked_removed' AS code,
       'notice' AS severity,
       format('customer_price_level_assignments %s (org %s) for customer %s on level %s starts today with an open window',
              a.id, a.org_id, a.customer_id, a.price_level_id) AS subject,
       format('deactivated assignment %s starts today and never covered any date; 0327 removes the never-effective row so the post-upgrade trigger and the backfill agree',
              a.id) AS detail,
       'No action required: nothing could have priced off this row. If the customer should hold the level, create a new assignment after the upgrade.' AS remedy
  FROM public.customer_price_level_assignments a
 WHERE NOT a.is_active
   AND a.effective_from = current_date
   AND (a.effective_to IS NULL OR a.effective_to >= current_date)
UNION ALL
SELECT '0327.inactive_level_historical_active' AS code,
       'notice' AS severity,
       format('price_levels %s (org %s, code %s) is inactive with no recorded deactivation instant',
              l.id, l.org_id, l.code) AS subject,
       format('level %s (%s) was deactivated before versioned activation existed; 0327 opens its history as a standing offer, so past transaction dates resolve it as offered while today and the future read the inactive flag',
              l.id, l.code) AS detail,
       'No action required: current and future dates already price off the inactive flag. Verify past pricing against the schedule windows, which carry the real dating.' AS remedy
  FROM public.price_levels l
 WHERE NOT l.is_active
 ORDER BY 1, 3
 LIMIT 50;
