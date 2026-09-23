-- OpenBooks upgrade preflight for 0299_stock_count_line_counted_nonnegative.
--
-- Two branches on the stock-count lifecycle (U14). Posted counts are
-- immutable in the engine, so a negative observation on one can never be
-- re-recorded: negatives on draft/review counts REFUSE with a re-record
-- remedy, while negatives on posted counts are a NOTICE naming
-- grandfathered legacy (recorded in upgrade_legacy_provenance). Zero rows
-- means ready for 0299.
WITH flagged AS (
  SELECT l.id, l.org_id, l.stock_count_id, l.item_id, l.stock_location_id,
         l.counted_quantity, c.status
    FROM public.stock_count_lines l
    JOIN public.stock_counts c
      ON c.id = l.stock_count_id AND c.org_id = l.org_id
   WHERE l.counted_quantity IS NOT NULL
     AND l.counted_quantity < 0
)
SELECT * FROM (
  SELECT '0299.negative_counted_quantity' AS code,
         'refuse' AS severity,
         format('count %s (%s) line %s (item %s at stock location %s) counted %s',
                f.stock_count_id, f.status, f.id, f.item_id, f.stock_location_id,
                f.counted_quantity) AS subject,
         format('stock_count_lines row %s in org %s carries a negative counted_quantity %s on a %s count. An empty bin counts 0',
                f.id, f.org_id, f.counted_quantity, f.status) AS detail,
         'Re-record the true physical count (zero or more) on each listed line; if the observation is lost, delete the draft count and recount. The mechanized remedy takes the delete-and-recount branch for draft counts holding negatives, see schema/migrations/preflight/remedies/0299.negative_counted_quantity.sql. Nothing is auto-zeroed.' AS remedy
    FROM flagged f
   WHERE f.status IS DISTINCT FROM 'posted'
   ORDER BY f.stock_count_id, f.id
   LIMIT 20
) refuse_rows
UNION ALL
SELECT * FROM (
  SELECT '0299.negative_counted_quantity_grandfathered' AS code,
         'notice' AS severity,
         format('posted count %s line %s (item %s at stock location %s) counted %s',
                f.stock_count_id, f.id, f.item_id, f.stock_location_id,
                f.counted_quantity) AS subject,
         format('stock_count_lines row %s in org %s carries a negative counted_quantity %s on a posted count. The phantom variance stands as history and is recorded as grandfathered legacy provenance',
                f.id, f.org_id, f.counted_quantity) AS detail,
         'No re-record is possible: posted counts are immutable — correct variances with a new count. These rows are recorded as grandfathered legacy.' AS remedy
    FROM flagged f
   WHERE f.status IS NOT DISTINCT FROM 'posted'
   ORDER BY f.stock_count_id, f.id
   LIMIT 20
) notice_rows;
