-- Unify standard + custom reports on one model: report_definitions can now hold
-- a `statement` definition (seeded standard financial statement) alongside the
-- existing `query` (entity-query) definitions. Additive + backward compatible:
-- existing rows default to report_type='query' and keep their `query` payload.
ALTER TABLE report_definitions
  ADD COLUMN IF NOT EXISTS report_type text NOT NULL DEFAULT 'query',
  ADD COLUMN IF NOT EXISTS statement jsonb,
  ADD COLUMN IF NOT EXISTS system boolean NOT NULL DEFAULT false;

-- Statement definitions carry their spec in `statement`, not `query`.
ALTER TABLE report_definitions ALTER COLUMN query DROP NOT NULL;
