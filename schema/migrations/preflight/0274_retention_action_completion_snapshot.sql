-- OpenBooks upgrade preflight for 0274_retention_action_completion_snapshot.
--
-- Read-only notice: migration 0274 freezes each completed document's
-- governing retention action from the schedule's LIVE value. Where a
-- schedule's action was edited after documents completed under it, the
-- freeze certifies the new action as the old one — invented history of the
-- same class as U8. The notice is unconditional for every document that
-- will inherit a live action, and the detail carries the last audited schedule
-- edit where one exists (engine retention writes are not all audited, so an
-- absent edit time proves nothing). Zero rows means no document inherits.
SELECT '0274.inherited_live_action' AS code,
       'notice' AS severity,
       format('hrm_document %s (org %s) completed under rule %s will inherit live action %s',
              d.id, d.org_id, s.id, s.action) AS subject,
       format('document %s carries retention_rule_id %s whose current action is %s. Last audited schedule edit: %s',
              d.id, s.id, s.action,
              coalesce((SELECT max(a.at)::text FROM public.audit_log a
                         WHERE a.table_name = 'hrm_retention_schedules' AND a.row_id = s.id),
                       '(no audited edit — engine writes are not all audited)')) AS detail,
       'Verify each listed document completed under the action it now carries. Where the schedule was edited after completion, reconcile the document under its upgrade_legacy_provenance note once migration 0326 backfills it.' AS remedy
  FROM public.hrm_documents d
  JOIN public.hrm_retention_schedules s ON s.id = d.retention_rule_id
 WHERE d.retention_rule_id IS NOT NULL
 ORDER BY d.org_id, d.id
 LIMIT 20;
