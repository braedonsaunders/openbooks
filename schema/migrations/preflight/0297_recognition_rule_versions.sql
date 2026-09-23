-- OpenBooks upgrade preflight for 0297_recognition_rule_versions (U8).
--
-- Read-only notice naming the rules most likely to carry invented history:
-- a rule whose row was updated after an obligation referencing it was
-- created was edited in place, so stamping it version 1 certifies the new
-- policy as the old one. (Migration 0326 conservatively marks EVERY
-- referenced pre-0297 rule as unverified legacy; this preflight is the
-- actionable subset with positive edit evidence.) Zero rows means no rule
-- shows an in-place edit after obligations were created.
SELECT '0297.edited_rule' AS code,
       'notice' AS severity,
       format('recognition rule %s (org %s) updated %s after obligation %s was created %s',
              r.code, r.org_id, r.updated_at, o.id, o.created_at) AS subject,
       format('rule %s was edited in place after obligation %s (created %s) was built under it; version 1 will certify the edited policy as the original',
              r.id, o.id, o.created_at) AS detail,
       'Confirm each listed rule still states the policy its obligations were built under. After the upgrade every referenced pre-0297 rule is marked unverified legacy in upgrade_legacy_provenance (pre-upgrade edits were made in place, so the pinned row may not be the original policy); rebuild any schedule that must re-price under verified policy.' AS remedy
  FROM public.recognition_rules r
  JOIN LATERAL (SELECT o.id, o.created_at
                  FROM public.performance_obligations o
                 WHERE o.org_id = r.org_id
                   AND o.recognition_rule_id = r.id
                   AND o.created_at < r.updated_at
                 ORDER BY o.created_at
                 LIMIT 1) o ON true
 ORDER BY r.org_id, r.code
 LIMIT 20;
