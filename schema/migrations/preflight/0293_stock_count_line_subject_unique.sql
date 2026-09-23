-- OpenBooks upgrade preflight for 0293_stock_count_line_subject_unique.
--
-- Two branches on the stock-count lifecycle (U13, restaged bytes fb31914e6).
-- Posted and cancelled counts are immutable in the engine ("correct with a
-- new count"), so no operator can merge their lines: duplicates on counts
-- still open for correction REFUSE with a remediable merge remedy, while
-- duplicate subjects on posted or cancelled counts are a NOTICE naming
-- grandfathered legacy (marked is_pre_guard_legacy by the migration,
-- recorded in upgrade_legacy_provenance by 0326). Zero rows means ready
-- for 0293.
WITH dups AS (
  SELECT l.org_id, l.stock_count_id, l.item_id, l.stock_location_id, l.lot_id,
         count(*) AS n, max(c.status) AS status
    FROM public.stock_count_lines l
    JOIN public.stock_counts c
      ON c.id = l.stock_count_id AND c.org_id = l.org_id
   GROUP BY l.org_id, l.stock_count_id, l.item_id, l.stock_location_id, l.lot_id
  HAVING count(*) > 1
)
SELECT * FROM (
  SELECT '0293.duplicate_subject' AS code,
         'refuse' AS severity,
         format('count %s (%s) holds %s lines for item %s at stock location %s lot %s',
                d.stock_count_id, d.status, d.n, d.item_id, d.stock_location_id,
                coalesce(d.lot_id::text, '(none)')) AS subject,
         format('%s lines share one (count, item, stock location, lot) subject in org %s on a %s count. Each posted the full variance',
                d.n, d.org_id, d.status) AS detail,
         'Merge each group into one line per count before applying 0293: keep one line per subject and remove the rest (a recount re-snapshots the one line, it does not add a second). The mechanized remedy keeps the lowest-id line per subject, see schema/migrations/preflight/remedies/0293.duplicate_subject.sql.' AS remedy
    FROM dups d
   WHERE d.status NOT IN ('posted', 'cancelled')
   ORDER BY d.stock_count_id, d.item_id, d.stock_location_id
   LIMIT 20
) refuse_rows
UNION ALL
SELECT * FROM (
  SELECT '0293.duplicate_subject_grandfathered' AS code,
         'notice' AS severity,
         format('immutable count %s (%s) holds %s lines for item %s at stock location %s lot %s',
                d.stock_count_id, d.status, d.n, d.item_id, d.stock_location_id,
                coalesce(d.lot_id::text, '(none)')) AS subject,
         format('%s lines share one subject in org %s on a %s count. The double-posted variance stands as history, marked is_pre_guard_legacy and recorded as grandfathered legacy provenance',
                d.n, d.org_id, d.status) AS detail,
         'No merge is possible or needed: posted and cancelled counts are immutable — correct variances with a new count. These rows are recorded as grandfathered legacy.' AS remedy
    FROM dups d
   WHERE d.status IN ('posted', 'cancelled')
   ORDER BY d.stock_count_id, d.item_id, d.stock_location_id
   LIMIT 20
) notice_rows;
