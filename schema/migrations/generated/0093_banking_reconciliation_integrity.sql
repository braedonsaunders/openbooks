BEGIN;

WITH repaired AS (
  UPDATE accounts a
     SET currency_restriction = o.base_currency,
         updated_at = now()
    FROM orgs o
   WHERE a.org_id = o.id
     AND a.reconcilable
     AND a.currency_restriction IS NULL
  RETURNING a.id, a.org_id, o.base_currency
)
INSERT INTO audit_log (org_id, table_name, row_id, action, changes, actor_id)
SELECT org_id, 'accounts', id, 'update',
       jsonb_build_object(
         'reason', '0093: reconcilable accounts require one explicit statement currency',
         'before', jsonb_build_object('currencyRestriction', null),
         'after', jsonb_build_object('currencyRestriction', base_currency)
       ),
       NULL
  FROM repaired;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_reconcilable_currency_required,
  ADD CONSTRAINT accounts_reconcilable_currency_required
  CHECK (NOT reconcilable OR currency_restriction IS NOT NULL) NOT VALID;

ALTER TABLE accounts
  VALIDATE CONSTRAINT accounts_reconcilable_currency_required;

ALTER TABLE bank_statement_lines
  ADD COLUMN IF NOT EXISTS account_id uuid,
  ADD COLUMN IF NOT EXISTS exclusion_reason text,
  ADD COLUMN IF NOT EXISTS excluded_at timestamptz,
  ADD COLUMN IF NOT EXISTS excluded_by uuid;

UPDATE bank_statement_lines l
   SET account_id = s.account_id
  FROM bank_statements s
 WHERE l.statement_id = s.id
   AND l.account_id IS NULL;

ALTER TABLE bank_statement_lines
  ALTER COLUMN account_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bank_statements_org_id_account_id_key
  ON bank_statements (org_id, id, account_id);

ALTER TABLE bank_statement_lines
  DROP CONSTRAINT IF EXISTS bank_statement_lines_statement_account_fkey,
  ADD CONSTRAINT bank_statement_lines_statement_account_fkey
    FOREIGN KEY (org_id, statement_id, account_id)
    REFERENCES bank_statements (org_id, id, account_id)
    ON DELETE RESTRICT
    DEFERRABLE,
  DROP CONSTRAINT IF EXISTS bank_statement_lines_excluded_by_fkey,
  ADD CONSTRAINT bank_statement_lines_excluded_by_fkey
    FOREIGN KEY (excluded_by)
    REFERENCES users(id)
    ON DELETE RESTRICT
    DEFERRABLE;

CREATE UNIQUE INDEX IF NOT EXISTS stmt_lines_account_bank_transaction
  ON bank_statement_lines (org_id, account_id, bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

ALTER TABLE bank_statement_lines
  DROP CONSTRAINT IF EXISTS bank_statement_lines_exclusion_evidence,
  ADD CONSTRAINT bank_statement_lines_exclusion_evidence
  CHECK (
    (
      match_status = 'excluded'
      AND exclusion_reason IS NOT NULL
      AND length(btrim(exclusion_reason)) BETWEEN 5 AND 500
      AND excluded_at IS NOT NULL
      AND excluded_by IS NOT NULL
    )
    OR
    (
      match_status <> 'excluded'
      AND exclusion_reason IS NULL
      AND excluded_at IS NULL
      AND excluded_by IS NULL
    )
  ) NOT VALID;

ALTER TABLE bank_statement_lines
  VALIDATE CONSTRAINT bank_statement_lines_exclusion_evidence;

ALTER TABLE reconciliations
  ADD COLUMN IF NOT EXISTS currency text;

UPDATE reconciliations r
   SET currency = a.currency_restriction
  FROM accounts a
 WHERE r.account_id = a.id
   AND r.currency IS NULL;

ALTER TABLE reconciliations
  ALTER COLUMN currency SET NOT NULL;

ALTER TABLE reconciliations
  DROP CONSTRAINT IF EXISTS reconciliations_signoff_evidence,
  ADD CONSTRAINT reconciliations_signoff_evidence
  CHECK (
    (
      status = 'signed_off'
      AND signed_off_by IS NOT NULL
      AND signed_off_at IS NOT NULL
    )
    OR
    (
      status <> 'signed_off'
      AND signed_off_by IS NULL
      AND signed_off_at IS NULL
    )
  ) NOT VALID;

ALTER TABLE reconciliations
  VALIDATE CONSTRAINT reconciliations_signoff_evidence;

CREATE UNIQUE INDEX IF NOT EXISTS reconciliations_one_open_account
  ON reconciliations (org_id, account_id)
  WHERE status <> 'signed_off';

ALTER TABLE reconciliation_matches
  ALTER COLUMN reconciliation_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS recon_matches_one_journal_claim
  ON reconciliation_matches (journal_line_id);

COMMIT;
