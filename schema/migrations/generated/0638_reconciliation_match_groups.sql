-- Grouped reconciliation matches: many bank lines may clear against one
-- journal line and vice versa. One match operation writes one group
-- (group_id): unmatch removes the whole group and sign-off cross-foots group
-- sums, so a wire pair clears one journal without voiding and re-posting it.
-- The legacy one-journal-claim unique index cannot express a shared journal,
-- so per-pair uniqueness replaces it, and a constraint trigger keeps one
-- journal in a single group under every writer.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE reconciliation_matches ADD COLUMN group_id uuid;
-- Deterministic per (org, reconciliation, statement): legacy rows written by
-- one match operation share their statement, so they stay grouped; the org
-- keeps match groups distinct across tenants. Signed-off matches are
-- immutable evidence; assigning the new grouping column changes none of it,
-- so the match guard is suspended for this backfill only. The migration
-- transaction's table lock excludes concurrent writers.
ALTER TABLE reconciliation_matches DISABLE TRIGGER reconciliation_match_guard;
UPDATE reconciliation_matches
   SET group_id = md5(org_id::text || '|' || reconciliation_id::text || '|' || statement_line_id::text)::uuid
 WHERE group_id IS NULL;
ALTER TABLE reconciliation_matches ENABLE TRIGGER reconciliation_match_guard;
ALTER TABLE reconciliation_matches ALTER COLUMN group_id SET NOT NULL;
DROP INDEX recon_matches_one_journal_claim;
CREATE UNIQUE INDEX recon_matches_pair_claim ON reconciliation_matches (org_id, statement_line_id, journal_line_id);
CREATE INDEX recon_matches_group ON reconciliation_matches (org_id, group_id);

-- One journal belongs to a single match group, under every writer. The match
-- engine already serializes group creation on the bank-account lock; this
-- trigger is the storage backstop for writers that do not (hand-applied SQL
-- included). Same-group rows never trip it; a second group claiming the
-- journal raises instead of silently double-clearing it. Constraint triggers
-- run after the row is written; the check ignores the row's own group.
CREATE OR REPLACE FUNCTION recon_matches_single_group_per_journal() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize concurrent match writers on the claimed journal: without this,
  -- two transactions could both pass the check below on uncommitted rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('recon-match-journal:' || NEW.org_id::text || ':' || NEW.journal_line_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM reconciliation_matches
     WHERE org_id = NEW.org_id
       AND journal_line_id = NEW.journal_line_id
       AND group_id IS DISTINCT FROM NEW.group_id
  ) THEN
    RAISE EXCEPTION 'journal line % is already matched in another group (reconciliation_matches one-journal-one-group)', NEW.journal_line_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER recon_matches_one_journal_one_group
  AFTER INSERT OR UPDATE OF journal_line_id, group_id ON reconciliation_matches
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION recon_matches_single_group_per_journal();
