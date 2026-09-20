-- 0202: versioned lessee schedules and immutable, independently approved
-- financial-change evidence. No posted journal is rewritten by this migration.
SET search_path = public, pg_catalog;

CREATE TABLE IF NOT EXISTS financial_changes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  subsidiary_id uuid NOT NULL REFERENCES subsidiaries(id),
  domain text NOT NULL CHECK (domain IN ('lease','revenue','asset','consolidation')),
  subject_id uuid NOT NULL,
  operation text NOT NULL,
  effective_on date NOT NULL CHECK (effective_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 1000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','rejected','applied')),
  submitted_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  result jsonb,
  applied_by uuid REFERENCES users(id),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  UNIQUE (org_id, idempotency_key),
  UNIQUE (org_id, id),
  CHECK (approved_by IS NULL OR approved_by <> submitted_by),
  CHECK (status NOT IN ('approved','applied') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((status = 'applied') = (applied_at IS NOT NULL AND applied_by IS NOT NULL AND result IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS financial_changes_subject ON financial_changes(org_id, domain, subject_id, effective_on);
ALTER TABLE financial_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_changes FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='financial_changes' AND policyname='org_isolation') THEN
    CREATE POLICY org_isolation ON financial_changes
      USING (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
      WITH CHECK (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
  END IF;
END $$;
COMMENT ON POLICY org_isolation ON financial_changes IS 'openbooks:org_isolation:v1';

CREATE OR REPLACE FUNCTION financial_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'financial changes are immutable evidence; propose a correcting change';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subsidiaries WHERE id=NEW.subsidiary_id AND org_id=NEW.org_id) THEN
    RAISE EXCEPTION 'financial change subsidiary must belong to the organization';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'financial changes must start as draft'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','approved_by','approved_at','result','applied_by','applied_at','updated_at','updated_by'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','approved_by','approved_at','result','applied_by','applied_at','updated_at','updated_by']) THEN
    RAISE EXCEPTION 'financial change proposal is immutable; create a new proposal';
  END IF;
  IF NOT ((OLD.status='draft' AND NEW.status='pending') OR
          (OLD.status='pending' AND NEW.status IN ('approved','rejected')) OR
          (OLD.status='approved' AND NEW.status='applied')) THEN
    RAISE EXCEPTION 'invalid financial change transition % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'pending' AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'financial change approval cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS financial_change_guard ON financial_changes;
CREATE TRIGGER financial_change_guard BEFORE INSERT OR UPDATE OR DELETE ON financial_changes FOR EACH ROW EXECUTE FUNCTION financial_change_guard();

ALTER TABLE lease_agreements
  ADD COLUMN IF NOT EXISTS book_id uuid REFERENCES accounting_books(id),
  ADD COLUMN IF NOT EXISTS currency text;
-- Bind historical agreements to the book/currency of their actual inception,
-- or the current primary book for carry-in/draft agreements with no entry.
UPDATE lease_agreements l SET
  book_id=coalesce((SELECT e.book_id FROM journal_entries e WHERE e.id=l.commencement_entry_id AND e.org_id=l.org_id),
                  (SELECT b.id FROM accounting_books b WHERE b.org_id=l.org_id AND b.is_primary AND b.is_active AND b.posts_gl LIMIT 1)),
  currency=coalesce((SELECT min(j.currency) FROM journal_lines j WHERE j.entry_id=l.commencement_entry_id AND j.org_id=l.org_id AND j.subsidiary_id=l.subsidiary_id),
                    (SELECT s.base_currency FROM subsidiaries s WHERE s.id=l.subsidiary_id AND s.org_id=l.org_id))
 WHERE l.book_id IS NULL;

ALTER TABLE lease_agreements
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS initial_direct_costs numeric(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prepayments numeric(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS incentives numeric(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_clearing_account_id uuid REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS last_change_id uuid REFERENCES financial_changes(id);
ALTER TABLE lease_agreement_schedule_lines
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS superseded_by_change_id uuid REFERENCES financial_changes(id),
  ADD COLUMN IF NOT EXISTS payment_posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS accrual_posted_at timestamptz;
-- Legacy arrears postings combined both events (operating has no separate
-- amortization entry). Preserve that completion; never catch them up again.
UPDATE lease_agreement_schedule_lines SET payment_posted_at=posted_at, accrual_posted_at=posted_at
 WHERE posted_at IS NOT NULL AND payment_posted_at IS NULL AND accrual_posted_at IS NULL;

CREATE OR REPLACE FUNCTION lease_schedule_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'lease schedules are retained; supersede future rows through an approved change'; END IF;
  IF (to_jsonb(NEW) - ARRAY['payment_entry_id','amortization_entry_id','posted_at','payment_posted_at','accrual_posted_at','superseded_by_change_id','updated_at','updated_by'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['payment_entry_id','amortization_entry_id','posted_at','payment_posted_at','accrual_posted_at','superseded_by_change_id','updated_at','updated_by']) THEN
    RAISE EXCEPTION 'lease schedule measurements are immutable; append a revision';
  END IF;
  IF NEW.superseded_by_change_id IS DISTINCT FROM OLD.superseded_by_change_id THEN
    IF OLD.accrual_posted_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM financial_changes c WHERE c.id=NEW.superseded_by_change_id AND c.org_id=OLD.org_id
        AND c.subject_id=OLD.lease_id AND c.domain='lease' AND c.status='approved') THEN
      RAISE EXCEPTION 'only unaccrued rows may be superseded by an approved change to this lease';
    END IF;
  END IF;
  IF (OLD.payment_posted_at IS NOT NULL AND (NEW.payment_posted_at IS DISTINCT FROM OLD.payment_posted_at OR NEW.payment_entry_id IS DISTINCT FROM OLD.payment_entry_id))
    OR (OLD.accrual_posted_at IS NOT NULL AND (NEW.accrual_posted_at IS DISTINCT FROM OLD.accrual_posted_at OR NEW.amortization_entry_id IS DISTINCT FROM OLD.amortization_entry_id))
    OR (OLD.superseded_by_change_id IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'completed lease events cannot be changed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lease_schedule_history_guard ON lease_agreement_schedule_lines;
CREATE TRIGGER lease_schedule_history_guard BEFORE UPDATE OR DELETE ON lease_agreement_schedule_lines FOR EACH ROW EXECUTE FUNCTION lease_schedule_history_guard();

CREATE OR REPLACE FUNCTION financial_change_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log(org_id,table_name,row_id,action,changes,actor_id)
    VALUES (NEW.org_id,'financial_changes',NEW.id,lower(TG_OP),
      jsonb_build_object('before',CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,'after',to_jsonb(NEW)),
      NEW.updated_by);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS financial_change_audit ON financial_changes;
CREATE TRIGGER financial_change_audit AFTER INSERT OR UPDATE ON financial_changes FOR EACH ROW EXECUTE FUNCTION financial_change_audit();

-- Content cannot move between tenants even through a privileged SQL writer.
CREATE UNIQUE INDEX IF NOT EXISTS lease_agreements_org_identity ON lease_agreements(org_id,id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lease_schedule_tenant_parent') THEN
    ALTER TABLE lease_agreement_schedule_lines ADD CONSTRAINT lease_schedule_tenant_parent
      FOREIGN KEY(org_id,lease_id) REFERENCES lease_agreements(org_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lease_schedule_change_tenant') THEN
    ALTER TABLE lease_agreement_schedule_lines ADD CONSTRAINT lease_schedule_change_tenant
      FOREIGN KEY(org_id,superseded_by_change_id) REFERENCES financial_changes(org_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lease_change_tenant') THEN
    ALTER TABLE lease_agreements ADD CONSTRAINT lease_change_tenant
      FOREIGN KEY(org_id,last_change_id) REFERENCES financial_changes(org_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lease_cost_adjustments_finite') THEN
    ALTER TABLE lease_agreements ADD CONSTRAINT lease_cost_adjustments_finite CHECK (
      revision>0 AND initial_direct_costs>=0 AND initial_direct_costs<>'NaN'
      AND prepayments>=0 AND prepayments<>'NaN' AND incentives>=0 AND incentives<>'NaN');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='financial_change_result_only_applied') THEN
    ALTER TABLE financial_changes ADD CONSTRAINT financial_change_result_only_applied
      CHECK (status='applied' OR (result IS NULL AND applied_by IS NULL AND applied_at IS NULL));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION lease_agreement_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.status<>'draft' THEN RAISE EXCEPTION 'commenced lease agreements are retained; use a termination or correcting change'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.org_id<>NEW.org_id OR OLD.subsidiary_id<>NEW.subsidiary_id OR OLD.id<>NEW.id THEN
    RAISE EXCEPTION 'lease organization and legal entity are immutable';
  END IF;
  IF OLD.status='draft' THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW)-ARRAY['description','custom','updated_at','updated_by']) IS NOT DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['description','custom','updated_at','updated_by']) THEN RETURN NEW; END IF;
  IF NEW.revision<>OLD.revision+1 OR NEW.last_change_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM financial_changes c WHERE c.id=NEW.last_change_id AND c.org_id=NEW.org_id
      AND c.domain='lease' AND c.subject_id=NEW.id AND c.status='approved') THEN
    RAISE EXCEPTION 'changing a commenced lease requires an approved accounting change and a new revision';
  END IF;
  IF NEW.initial_liability IS DISTINCT FROM OLD.initial_liability OR NEW.initial_rou_asset IS DISTINCT FROM OLD.initial_rou_asset
     OR NEW.commencement_entry_id IS DISTINCT FROM OLD.commencement_entry_id OR NEW.commencement_on<>OLD.commencement_on
     OR NEW.book_id IS DISTINCT FROM OLD.book_id OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'lease commencement history is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lease_agreement_revision_guard ON lease_agreements;
CREATE TRIGGER lease_agreement_revision_guard BEFORE UPDATE OR DELETE ON lease_agreements FOR EACH ROW EXECUTE FUNCTION lease_agreement_revision_guard();
