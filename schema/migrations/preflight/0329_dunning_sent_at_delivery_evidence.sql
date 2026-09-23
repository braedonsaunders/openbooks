-- OpenBooks upgrade preflight for 0329_dunning_sent_at_delivery_evidence.
--
-- Read-only notice naming the staged/suppressed/failed claims whose
-- claim-time sent_at migration 0329 will clear to NULL: only rows with no
-- delivery evidence in email_log under any occurrence key the claim ever
-- used (the migration's own predicate, mirrored here). Sent/skipped history
-- and rows with accepted or unresolved delivery evidence are preserved, so
-- zero rows means the upgrade clears nothing.
WITH candidates AS (
  SELECT dl.id, dl.org_id, dl.status, dl.sent_at, dl.document_id
    FROM public.dunning_log dl
   WHERE dl.sent_at IS NOT NULL
     AND dl.status IN ('staged', 'suppressed', 'failed')
     AND NOT EXISTS (
       SELECT 1
         FROM public.email_log e
        WHERE e.org_id = dl.org_id
          AND e.meta ->> 'dunningLogId' = dl.id::text
          AND (e.status = 'sent'
               OR e.provider_message_id IS NOT NULL
               OR e.sent_at IS NOT NULL
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.meta -> 'attempts') = 'array' THEN e.meta -> 'attempts' ELSE '[]'::jsonb END) a
                  WHERE a ->> 'outcome' = 'sent'
               )
               OR e.status = 'uncertain'
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.meta -> 'attempts') = 'array' THEN e.meta -> 'attempts' ELSE '[]'::jsonb END) a
                  WHERE a ->> 'outcome' = 'uncertain'
               )
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.meta -> 'attempts') = 'array' THEN e.meta -> 'attempts' ELSE '[]'::jsonb END) s
                  WHERE s ->> 'outcome' = 'started'
                    AND (s ->> 'attempt') ~ '^-?[0-9]+$'
                    AND NOT EXISTS (
                      SELECT 1
                        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.meta -> 'attempts') = 'array' THEN e.meta -> 'attempts' ELSE '[]'::jsonb END) d
                       WHERE (d ->> 'attempt') ~ '^-?[0-9]+$'
                         AND (d ->> 'attempt')::integer = (s ->> 'attempt')::integer
                         AND d ->> 'outcome' IN ('sent', 'notSent', 'uncertain')
                    )
               ))
     )
)
SELECT * FROM (
  SELECT '0329.claim_time_sent_at' AS code,
         'notice' AS severity,
         format('dunning_log %s (org %s, status %s) carries claim-time sent_at %s with no delivery evidence - migration 0329 clears it to NULL',
                c.id, c.org_id, c.status, c.sent_at) AS subject,
         format('claim on document %s settled %s without a provider verdict: no sent email_log row, provider message id, sent stamp, or sent/uncertain lineage outcome under any occurrence key for this claim',
                c.document_id, c.status) AS detail,
         'No action is required: migration 0329 clears the claim-time stamp to NULL and writes one audit_log row carrying the before image per cleared row. When a cleared claim later shows provider acceptance, the dunning runner reconciles it to sent from the email evidence.' AS remedy
    FROM candidates c
   ORDER BY c.sent_at
   LIMIT 50
) samples
UNION ALL
SELECT '0329.claim_time_sent_at' AS code,
       'notice' AS severity,
       format('%s dunning_log row(s) will have claim-time sent_at cleared to NULL by migration 0329', count(*)) AS subject,
       'Total across all organizations; the per-row findings above name the first 50 by claim time.' AS detail,
       'No action is required: migration 0329 clears the claim-time stamp to NULL and writes one audit_log row carrying the before image per cleared row. When a cleared claim later shows provider acceptance, the dunning runner reconciles it to sent from the email evidence.' AS remedy
  FROM candidates
HAVING count(*) > 0;
