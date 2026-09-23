-- OpenBooks upgrade preflight for 0277_pdf_template_default_and_revision.
--
-- Read-only notice naming the duplicate defaults migration 0277 will
-- demote: the keep is deterministic (the resolver's pick — lowest-named
-- active default, else lowest-named default), everything else is demoted
-- with one audit_log row each. Zero rows means no org prints change.
WITH dup_groups AS (
  SELECT org_id, record_type
    FROM public.pdf_templates
   WHERE is_default
   GROUP BY org_id, record_type
  HAVING count(*) > 1
),
keepers AS (
  SELECT DISTINCT ON (t.org_id, t.record_type)
         t.org_id, t.record_type, t.id AS keep_id, t.name AS keep_name
    FROM public.pdf_templates t
   WHERE t.is_default
   ORDER BY t.org_id, t.record_type,
            (CASE WHEN t.is_active THEN 0 ELSE 1 END), t.name
)
SELECT '0277.duplicate_default' AS code,
       'notice' AS severity,
       format('template "%s" (%s) for %s in org %s will be demoted from default',
              t.name, t.id, t.record_type, t.org_id) AS subject,
       format('duplicate default for (%s, %s). Migration 0277 keeps "%s" (%s) — the design records already print with — and demotes this one with audit evidence',
              t.org_id, t.record_type, k.keep_name, k.keep_id) AS detail,
       'Confirm the kept default is the intended print design. To elect another template, set it as default explicitly after the upgrade.' AS remedy
  FROM public.pdf_templates t
  JOIN dup_groups g ON g.org_id = t.org_id AND g.record_type = t.record_type
  JOIN keepers k ON k.org_id = t.org_id AND k.record_type = t.record_type
 WHERE t.is_default AND t.id <> k.keep_id
 ORDER BY t.org_id, t.record_type, t.name
 LIMIT 20;
