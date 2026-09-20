-- Approved amendments retain every posted journal and superseded future plan.
SET search_path=public,pg_catalog;
ALTER TABLE revenue_contracts
  ADD COLUMN IF NOT EXISTS subsidiary_id uuid REFERENCES subsidiaries(id),
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_change_id uuid REFERENCES financial_changes(id),
  ADD COLUMN IF NOT EXISTS parent_contract_id uuid REFERENCES revenue_contracts(id);
-- Resolve only identities the source proves. Ambiguous legacy ownership is
-- deliberately left unset for the amendment's explicit, authorized assignment.
UPDATE revenue_contracts c SET subsidiary_id=owners.subsidiary_id FROM (
 SELECT contract_id,(array_agg(DISTINCT subsidiary_id))[1] AS subsidiary_id FROM (
  SELECT o.contract_id,coalesce(dl.subsidiary_id,d.subsidiary_id,p.subsidiary_id) subsidiary_id
  FROM performance_obligations o JOIN revenue_contracts rc ON rc.id=o.contract_id AND rc.org_id=o.org_id
  LEFT JOIN document_lines dl ON dl.id=o.document_line_id AND dl.org_id=o.org_id
  LEFT JOIN documents d ON d.id=dl.document_id AND d.org_id=dl.org_id
  LEFT JOIN projects p ON p.id=rc.project_id AND p.org_id=rc.org_id
 ) resolved GROUP BY contract_id HAVING count(DISTINCT subsidiary_id)=1
) owners WHERE c.id=owners.contract_id AND c.subsidiary_id IS NULL;
ALTER TABLE performance_obligations ADD COLUMN IF NOT EXISTS last_change_id uuid REFERENCES financial_changes(id);
ALTER TABLE recognition_schedules
 ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
 ADD COLUMN IF NOT EXISTS change_basis jsonb;
ALTER TABLE recognition_schedule_lines
 ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
 ADD COLUMN IF NOT EXISTS superseded_by_change_id uuid REFERENCES financial_changes(id),
 ADD COLUMN IF NOT EXISTS modification_adjustment boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS recognition_on date;

CREATE OR REPLACE FUNCTION recognition_revision_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 IF OLD.superseded_by_change_id IS NOT NULL THEN RAISE EXCEPTION 'superseded revenue plans are immutable evidence'; END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.journal_entry_id IS NOT NULL THEN RAISE EXCEPTION 'posted revenue history cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.journal_entry_id IS NOT NULL AND
    (to_jsonb(NEW)-ARRAY['reversal_journal_entry_id','updated_at','updated_by']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['reversal_journal_entry_id','updated_at','updated_by']) THEN
   RAISE EXCEPTION 'posted revenue measurements are immutable; append an adjustment';
 END IF;
 IF OLD.reversal_journal_entry_id IS NOT NULL AND NEW.reversal_journal_entry_id IS DISTINCT FROM OLD.reversal_journal_entry_id THEN
   RAISE EXCEPTION 'revenue reversal lineage is immutable';
 END IF;
 IF NEW.superseded_by_change_id IS DISTINCT FROM OLD.superseded_by_change_id AND
   (OLD.journal_entry_id IS NOT NULL OR NOT EXISTS (
     SELECT 1 FROM financial_changes f JOIN recognition_schedules s ON s.id=OLD.schedule_id AND s.org_id=OLD.org_id
     JOIN performance_obligations o ON o.id=s.obligation_id AND o.org_id=s.org_id
     WHERE f.id=NEW.superseded_by_change_id AND f.org_id=OLD.org_id AND f.domain='revenue' AND f.subject_id=o.contract_id AND f.status='approved')) THEN
   RAISE EXCEPTION 'only unposted plans may be superseded by an approved modification of this contract';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recognition_revision_history_guard ON recognition_schedule_lines;
CREATE TRIGGER recognition_revision_history_guard BEFORE UPDATE OR DELETE ON recognition_schedule_lines FOR EACH ROW EXECUTE FUNCTION recognition_revision_history_guard();
CREATE UNIQUE INDEX IF NOT EXISTS revenue_contracts_org_identity ON revenue_contracts(org_id,id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='revenue_change_tenant') THEN
  ALTER TABLE revenue_contracts ADD CONSTRAINT revenue_change_tenant FOREIGN KEY(org_id,last_change_id) REFERENCES financial_changes(org_id,id);
  ALTER TABLE revenue_contracts ADD CONSTRAINT revenue_parent_tenant FOREIGN KEY(org_id,parent_contract_id) REFERENCES revenue_contracts(org_id,id);
  ALTER TABLE performance_obligations ADD CONSTRAINT revenue_obligation_change_tenant FOREIGN KEY(org_id,last_change_id) REFERENCES financial_changes(org_id,id);
  ALTER TABLE recognition_schedule_lines ADD CONSTRAINT revenue_plan_change_tenant FOREIGN KEY(org_id,superseded_by_change_id) REFERENCES financial_changes(org_id,id);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION revenue_approved_terms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid; changed boolean; amendment uuid;
BEGIN
 IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN RETURN NEW; END IF;
 IF NEW.org_id<>OLD.org_id OR NEW.id<>OLD.id THEN RAISE EXCEPTION 'revenue identity and organization are immutable'; END IF;
 IF TG_TABLE_NAME='revenue_contracts' THEN
  IF OLD.subsidiary_id IS NOT NULL AND NEW.subsidiary_id IS DISTINCT FROM OLD.subsidiary_id THEN RAISE EXCEPTION 'revenue legal entity cannot be changed'; END IF;
  subject:=OLD.id; amendment:=NEW.last_change_id;
  changed:=(NEW.total_transaction_price,NEW.currency,NEW.customer_id,NEW.starts_on,NEW.ends_on) IS DISTINCT FROM
           (OLD.total_transaction_price,OLD.currency,OLD.customer_id,OLD.starts_on,OLD.ends_on);
 ELSE
  IF NEW.contract_id<>OLD.contract_id THEN RAISE EXCEPTION 'a performance obligation cannot move contracts'; END IF;
  subject:=OLD.contract_id; amendment:=NEW.last_change_id;
  changed:=(NEW.allocated_price,NEW.standalone_selling_price,NEW.recognition_rule_id,NEW.recognition_starts_on,NEW.recognition_ends_on,NEW.deferred_account_id,NEW.recognized_account_id) IS DISTINCT FROM
           (OLD.allocated_price,OLD.standalone_selling_price,OLD.recognition_rule_id,OLD.recognition_starts_on,OLD.recognition_ends_on,OLD.deferred_account_id,OLD.recognized_account_id);
 END IF;
 IF (OLD.last_change_id IS NOT NULL AND changed) OR NEW.last_change_id IS DISTINCT FROM OLD.last_change_id THEN
  IF amendment IS NULL OR NOT EXISTS(SELECT 1 FROM financial_changes f WHERE f.id=amendment AND f.org_id=OLD.org_id AND f.domain='revenue' AND f.subject_id=subject AND f.status='approved') THEN
   RAISE EXCEPTION 'approved revenue terms require a new independently approved contract modification';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS revenue_approved_terms_guard ON revenue_contracts;
CREATE TRIGGER revenue_approved_terms_guard BEFORE UPDATE ON revenue_contracts FOR EACH ROW EXECUTE FUNCTION revenue_approved_terms_guard();
DROP TRIGGER IF EXISTS revenue_approved_terms_guard ON performance_obligations;
CREATE TRIGGER revenue_approved_terms_guard BEFORE UPDATE ON performance_obligations FOR EACH ROW EXECUTE FUNCTION revenue_approved_terms_guard();

CREATE OR REPLACE FUNCTION revenue_schedule_basis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid; parent uuid;
BEGIN
 IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN RETURN NEW; END IF;
 IF NEW.change_basis IS NOT NULL AND (TG_OP='INSERT' OR NEW.change_basis IS DISTINCT FROM OLD.change_basis) THEN
  SELECT c.id,c.parent_contract_id INTO subject,parent FROM performance_obligations o JOIN revenue_contracts c ON c.id=o.contract_id AND c.org_id=o.org_id WHERE o.id=NEW.obligation_id AND o.org_id=NEW.org_id;
  IF NOT EXISTS(SELECT 1 FROM financial_changes f WHERE f.id=(NEW.change_basis->>'changeId')::uuid AND f.org_id=NEW.org_id AND f.domain='revenue' AND f.subject_id IN(subject,parent) AND f.status='approved') THEN
   RAISE EXCEPTION 'amended recognition basis requires the approved contract modification';
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.change_basis IS NOT NULL AND NEW.change_basis IS NULL THEN RAISE EXCEPTION 'an approved recognition basis cannot be erased'; END IF;
 IF NEW.change_basis IS NOT NULL AND NEW.total_amount IS DISTINCT FROM (NEW.change_basis->>'totalAmount')::numeric THEN RAISE EXCEPTION 'recognition total must match its approved basis'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS revenue_schedule_basis_guard ON recognition_schedules;
CREATE TRIGGER revenue_schedule_basis_guard BEFORE INSERT OR UPDATE ON recognition_schedules FOR EACH ROW EXECUTE FUNCTION revenue_schedule_basis_guard();
