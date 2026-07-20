-- Fixed-price project revenue flows through the ARM pipeline: each qualifying
-- project gets ONE revenue contract (+ percent_complete obligation), posted
-- only by the central recognition run. project_id links the contract to its
-- project (null for invoice-bundle contracts). Idempotent.

ALTER TABLE revenue_contracts ADD COLUMN IF NOT EXISTS project_id uuid;
CREATE INDEX IF NOT EXISTS rev_contracts_project ON revenue_contracts (project_id);
