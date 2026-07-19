-- Rebrand "burden" → "overhead" (the more appropriate job-costing term).
--
--  • labor_burden_rates            → overhead_rates            (table)
--  • project_types.financial_profile jsonb: rename the `burden` measure config
--        to `overhead`, and rewrite `totalCost.components` + `layout[].measure`
--        occurrences of "burden" to "overhead" for existing rows.
--
-- NOTE: the journal_entries.origin value 'labor_burden' (which tags direct
-- labor-cost-to-WIP, a misnomer) is intentionally NOT renamed here — posted
-- journals are immutable, and bypassing that would require superuser on deploy.
-- It is addressed when overhead absorption introduces its own origin.
--
-- Idempotent: guarded so a re-run is a no-op.

-- 1) Rename the rate table (+ its primary key) if it still has the old name.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'labor_burden_rates') THEN
    ALTER TABLE labor_burden_rates RENAME TO overhead_rates;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'labor_burden_rates_pkey') THEN
    ALTER TABLE overhead_rates RENAME CONSTRAINT labor_burden_rates_pkey TO overhead_rates_pkey;
  END IF;
END $$;

-- 2) Backfill project-type financial profiles: burden → overhead.
--    (a) rename the measure config key
UPDATE project_types
   SET financial_profile = jsonb_set(
         financial_profile - 'burden',
         '{overhead}',
         COALESCE(financial_profile -> 'burden', '{"source":"none"}'::jsonb)
       )
 WHERE financial_profile ? 'burden';

--    (b) rewrite totalCost.components array elements
UPDATE project_types
   SET financial_profile = jsonb_set(
         financial_profile,
         '{totalCost,components}',
         (SELECT jsonb_agg(CASE WHEN x = 'burden' THEN 'overhead' ELSE x END)
            FROM jsonb_array_elements_text(financial_profile -> 'totalCost' -> 'components') x)
       )
 WHERE financial_profile -> 'totalCost' -> 'components' ? 'burden';

--    (c) rewrite layout[].measure occurrences
UPDATE project_types
   SET financial_profile = jsonb_set(
         financial_profile,
         '{layout}',
         (SELECT jsonb_agg(
                   CASE WHEN line ->> 'measure' = 'burden'
                        THEN jsonb_set(line, '{measure}', '"overhead"')
                        ELSE line END)
            FROM jsonb_array_elements(financial_profile -> 'layout') line)
       )
 WHERE financial_profile -> 'layout' @> '[{"measure":"burden"}]';
