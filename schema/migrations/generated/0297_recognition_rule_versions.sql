-- OpenBooks forward migration 0297_recognition_rule_versions.
--
-- Recognition-rule policy drifted under existing obligations: the setup
-- writer updated the rule row in place, and every schedule rebuild (plus the
-- modification snapshot's read of the "old" policy) reloaded the LIVE row.
-- A 12-month straight-line obligation rescheduled after an admin edited its
-- rule to point_in_time or changed its start offset was re-priced and
-- re-timed under the new policy, and history could no longer reproduce the
-- old plan.
--
-- Effective-dated financial configuration: once a rule is referenced by any
-- obligation, its policy columns (method, periods, date sources, offsets,
-- up-front percent, accounts) are immutable in place. A policy edit creates
-- a SUCCESSOR row (same code, version + 1) that new obligations use, links
-- the old row forward through superseded_by, deactivates it so pickers stop
-- offering it, and repoints items at the successor. Each obligation pins the
-- rule version it was created under through its recognition_rule_id foreign
-- key, so rebuilds and modification snapshots read the pinned row with no
-- code change. Non-policy edits (name, active flag) stay in place. The
-- application writer (web/lib/setup/write.ts) performs the versioning; this
-- migration only carries the storage shape.
--
-- Backfill: every existing rule becomes version 1 — exactly the policy under
-- which its current obligations were built — and every existing obligation
-- already references its rule row, so the pin needs no backfill of its own.
-- The new partial uniqueness (one current row per org and code) holds on
-- existing data because the previous full unique index guaranteed it and
-- every row starts unsurpassed.
--
-- No existing row violates the new shape (all columns are nullable or carry
-- the version-1 default); nothing is rewritten or deleted.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.recognition_rules
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS superseded_by uuid NULL;

COMMENT ON COLUMN public.recognition_rules.version IS
  'Successor-chain version for effective-dated rule policy (0297). A policy edit on a rule referenced by any obligation creates a successor row with version + 1 instead of rewriting this row.';
COMMENT ON COLUMN public.recognition_rules.superseded_by IS
  'Forward link to the successor recognition_rules row that replaced this version (0297). NULL while the version is current.';

ALTER TABLE public.recognition_rules
  ADD CONSTRAINT recognition_rules_superseded_by_fkey
  FOREIGN KEY (superseded_by) REFERENCES public.recognition_rules(id) DEFERRABLE;

DROP INDEX IF EXISTS recognition_rules_org_code;
CREATE UNIQUE INDEX IF NOT EXISTS recognition_rules_org_code
  ON public.recognition_rules USING btree (org_id, code) WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS recognition_rules_superseded_by
  ON public.recognition_rules USING btree (superseded_by);

DROP VIEW openbooks_query.recognition_rules;
CREATE VIEW openbooks_query.recognition_rules WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    code,
    name,
    method,
    is_forecast,
    recognition_periods,
    start_date_source,
    end_date_source,
    period_offset,
    start_offset_days,
    initial_amount_percent,
    deferred_account_id,
    recognized_account_id,
    is_active,
    version,
    superseded_by,
    created_at,
    created_by,
    updated_at,
    updated_by
   FROM public.recognition_rules
  WHERE (org_id = public.openbooks_query_org_id());

GRANT SELECT ON TABLE openbooks_query.recognition_rules TO openbooks_read;
