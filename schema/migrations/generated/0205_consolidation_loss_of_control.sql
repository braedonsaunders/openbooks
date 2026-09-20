SET search_path=public,pg_catalog;
CREATE TABLE IF NOT EXISTS consolidation_control_losses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES orgs(id),
 change_id uuid NOT NULL REFERENCES financial_changes(id),interest_id uuid NOT NULL REFERENCES subsidiary_ownership_interests(id),
 subsidiary_id uuid NOT NULL REFERENCES subsidiaries(id),parent_subsidiary_id uuid NOT NULL REFERENCES subsidiaries(id),
 elimination_subsidiary_id uuid NOT NULL REFERENCES subsidiaries(id),book_id uuid NOT NULL REFERENCES accounting_books(id),
 period_id uuid NOT NULL REFERENCES accounting_periods(id),effective_on date NOT NULL,
 excluded_subsidiary_ids jsonb NOT NULL,measurement jsonb NOT NULL,parent_journal_entry_id uuid REFERENCES journal_entries(id),journal_entry_id uuid REFERENCES journal_entries(id),
 retained_method text NOT NULL CHECK(retained_method IN('none','equity','financial_asset')),
 retained_interest_id uuid REFERENCES subsidiary_ownership_interests(id),
 reversed_by_change_id uuid REFERENCES financial_changes(id),
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES users(id),
 UNIQUE(org_id,id),UNIQUE(org_id,change_id),FOREIGN KEY(org_id,change_id) REFERENCES financial_changes(org_id,id)
);
CREATE UNIQUE INDEX consolidation_control_loss_active_interest ON consolidation_control_losses(org_id,interest_id) WHERE reversed_by_change_id IS NULL;
ALTER TABLE consolidation_control_losses ENABLE ROW LEVEL SECURITY;
ALTER TABLE consolidation_control_losses FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON consolidation_control_losses USING(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON consolidation_control_losses IS 'openbooks:org_isolation:v1';
CREATE OR REPLACE FUNCTION control_loss_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.reversed_by_change_id IS NULL AND NEW.reversed_by_change_id IS NOT NULL AND (to_jsonb(NEW)-'reversed_by_change_id') IS NOT DISTINCT FROM (to_jsonb(OLD)-'reversed_by_change_id') AND EXISTS(SELECT 1 FROM financial_changes f WHERE f.org_id=OLD.org_id AND f.id=NEW.reversed_by_change_id AND f.domain='consolidation' AND f.operation='reversal' AND f.payload->>'sourceChangeId'=OLD.change_id::text AND f.status='approved') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'loss-of-control evidence is immutable; propose its independently approved correction';
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'loss-of-control evidence cannot be deleted'; END IF;
 IF NOT(NEW.excluded_subsidiary_ids ? NEW.subsidiary_id::text) OR NOT EXISTS(SELECT 1 FROM subsidiaries s WHERE s.org_id=NEW.org_id AND s.id=NEW.elimination_subsidiary_id AND s.is_elimination) OR (NEW.retained_interest_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subsidiary_ownership_interests p WHERE p.org_id=NEW.org_id AND p.id=NEW.retained_interest_id AND p.subsidiary_id=NEW.subsidiary_id AND p.parent_subsidiary_id=NEW.parent_subsidiary_id AND p.method=NEW.retained_method AND p.effective_from=NEW.effective_on+1)) THEN RAISE EXCEPTION 'loss-of-control entities and retained interest must match the approved ownership scope'; END IF;
 IF NOT EXISTS(SELECT 1 FROM accounting_books b WHERE b.id=NEW.book_id AND b.org_id=NEW.org_id AND b.is_primary AND b.posts_gl AND b.is_active) OR NOT EXISTS(SELECT 1 FROM accounting_periods p WHERE p.id=NEW.period_id AND p.org_id=NEW.org_id AND NEW.effective_on BETWEEN p.starts_on AND p.ends_on) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.excluded_subsidiary_ids) child(id) WHERE NOT EXISTS(SELECT 1 FROM subsidiaries s WHERE s.id=child.id::uuid AND s.org_id=NEW.org_id)) THEN RAISE EXCEPTION 'loss-of-control scope must reference this organization and accounting period'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(array_remove(ARRAY[NEW.parent_journal_entry_id,NEW.journal_entry_id],NULL)) wanted(id) WHERE NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.org_id=NEW.org_id AND e.id=wanted.id AND e.book_id=NEW.book_id AND e.period_id=NEW.period_id AND e.status='posted')) THEN RAISE EXCEPTION 'loss-of-control journals must be posted in its accounting book and period'; END IF;
 IF NOT EXISTS(SELECT 1 FROM financial_changes f WHERE f.org_id=NEW.org_id AND f.id=NEW.change_id AND f.domain='consolidation' AND f.subject_id=NEW.interest_id AND f.status='approved') THEN RAISE EXCEPTION 'loss of control requires independent approval for this ownership interest'; END IF;
 IF NOT EXISTS(SELECT 1 FROM subsidiary_ownership_interests p WHERE p.org_id=NEW.org_id AND p.id=NEW.interest_id AND p.subsidiary_id=NEW.subsidiary_id AND p.parent_subsidiary_id=NEW.parent_subsidiary_id AND p.effective_to=NEW.effective_on) THEN RAISE EXCEPTION 'loss of control must close its ownership window at the approved date'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER control_loss_history_guard BEFORE INSERT OR UPDATE OR DELETE ON consolidation_control_losses FOR EACH ROW EXECUTE FUNCTION control_loss_history_guard();
ALTER TABLE subsidiary_ownership_interests ADD COLUMN IF NOT EXISTS last_change_id uuid REFERENCES financial_changes(id);
-- Preserve every material used-policy term. Only the end date may be closed
-- by this independently approved loss-of-control command.
CREATE OR REPLACE FUNCTION ownership_interest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_parent uuid; bad_account boolean; approved_close boolean:=false;
BEGIN
 SELECT parent_id INTO actual_parent FROM subsidiaries WHERE id=NEW.subsidiary_id AND org_id=NEW.org_id AND is_active AND NOT is_elimination;
 IF actual_parent IS DISTINCT FROM NEW.parent_subsidiary_id OR NOT EXISTS(SELECT 1 FROM subsidiaries WHERE id=NEW.parent_subsidiary_id AND org_id=NEW.org_id AND is_active AND NOT is_elimination) THEN RAISE EXCEPTION 'ownership interest must follow the active tenant consolidation hierarchy'; END IF;
 SELECT EXISTS(SELECT 1 FROM unnest(array_remove(ARRAY[NEW.investment_account_id,NEW.equity_income_account_id,NEW.distribution_account_id,NEW.distribution_income_account_id,NEW.nci_equity_account_id,NEW.nci_income_account_id,NEW.goodwill_account_id,NEW.fair_value_adjustment_account_id],NULL)) wanted(id) WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=wanted.id AND a.org_id=NEW.org_id AND a.is_active AND NOT a.is_summary)) INTO bad_account;
 IF bad_account THEN RAISE EXCEPTION 'ownership accounts must be active postable accounts in the tenant'; END IF;
 IF NEW.method='full' AND NEW.ownership_percent<100 AND (NEW.nci_equity_account_id IS NULL OR NEW.nci_income_account_id IS NULL) THEN RAISE EXCEPTION 'full consolidation below 100 percent requires NCI equity and income accounts'; END IF;
 IF NEW.method='full' AND (NEW.goodwill_account_id IS NULL OR NEW.fair_value_adjustment_account_id IS NULL) THEN RAISE EXCEPTION 'full consolidation requires goodwill and fair-value adjustment accounts'; END IF;
 IF NEW.distribution_account_id IS NOT NULL AND NEW.distribution_income_account_id IS NULL THEN RAISE EXCEPTION 'distribution income account is required when a distribution account is configured'; END IF;
 -- A new full policy alone does not book a new acquisition or reopen the
 -- disposed reporting window. Do not silently reconsolidate from stale basis.
 IF NEW.method='full' AND NEW.is_active AND EXISTS(SELECT 1 FROM consolidation_control_losses loss WHERE loss.org_id=NEW.org_id AND loss.subsidiary_id=NEW.subsidiary_id AND loss.reversed_by_change_id IS NULL AND NEW.effective_from>loss.effective_on) THEN RAISE EXCEPTION 'a full reacquisition requires new acquisition accounting; a policy-only change cannot reopen the disposed group. For an erroneous disposal use its approved correction in Accounting changes'; END IF;
 IF TG_OP='UPDATE' THEN
  approved_close:=NEW.effective_to IS NOT NULL AND NEW.effective_to>=OLD.effective_from AND (OLD.effective_to IS NULL OR NEW.effective_to<=OLD.effective_to) AND NEW.last_change_id IS DISTINCT FROM OLD.last_change_id AND EXISTS(SELECT 1 FROM financial_changes f WHERE f.org_id=OLD.org_id AND f.id=NEW.last_change_id AND f.domain='consolidation' AND f.operation='loss_of_control' AND f.subject_id=OLD.id AND f.effective_on=NEW.effective_to AND f.status='approved') AND (to_jsonb(NEW)-ARRAY['effective_to','last_change_id','updated_at','updated_by']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['effective_to','last_change_id','updated_at','updated_by']);
  approved_close:=approved_close OR (NEW.last_change_id IS DISTINCT FROM OLD.last_change_id AND EXISTS(SELECT 1 FROM financial_changes f JOIN consolidation_control_losses loss ON loss.org_id=f.org_id AND loss.change_id::text=f.payload->>'sourceChangeId' WHERE f.org_id=OLD.org_id AND f.id=NEW.last_change_id AND f.domain='consolidation' AND f.operation='reversal' AND f.status='approved' AND loss.interest_id=OLD.id AND loss.reversed_by_change_id=f.id AND NEW.effective_to IS NOT DISTINCT FROM (loss.measurement->>'originalEffectiveTo')::date) AND (to_jsonb(NEW)-ARRAY['effective_to','last_change_id','updated_at','updated_by']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['effective_to','last_change_id','updated_at','updated_by']));
  approved_close:=approved_close OR (OLD.is_active AND NOT NEW.is_active AND EXISTS(SELECT 1 FROM financial_changes f JOIN consolidation_control_losses loss ON loss.org_id=f.org_id AND loss.change_id::text=f.payload->>'sourceChangeId' WHERE f.org_id=OLD.org_id AND f.id=NEW.last_change_id AND f.domain='consolidation' AND f.operation='reversal' AND f.status='approved' AND loss.retained_interest_id=OLD.id AND loss.reversed_by_change_id=f.id) AND (to_jsonb(NEW)-ARRAY['is_active','last_change_id','updated_at','updated_by']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['is_active','last_change_id','updated_at','updated_by']));
  IF EXISTS(SELECT 1 FROM ownership_consolidation_entries WHERE interest_id=OLD.id) AND (to_jsonb(NEW)-ARRAY['updated_at','updated_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','updated_by']) AND NOT approved_close THEN RAISE EXCEPTION 'used ownership policy is immutable; propose an approved loss-of-control change or retain the existing historical terms'; END IF;
 END IF;
 RETURN NEW;
END $$;

-- Once approved, the historical source cannot drift underneath the signed
-- workpaper. Corrections first reverse the controlled disposal in its open
-- period; a later reacquisition cannot be represented by a policy-only edit.
CREATE OR REPLACE FUNCTION control_loss_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  IF NEW.status='posted' AND (TG_OP='INSERT' OR OLD.status<>'posted') AND EXISTS(SELECT 1 FROM consolidation_control_losses loss WHERE loss.org_id=NEW.org_id AND loss.reversed_by_change_id IS NULL AND loss.book_id=NEW.book_id AND ( (NEW.posting_date<=loss.effective_on AND EXISTS(SELECT 1 FROM journal_lines l WHERE l.org_id=NEW.org_id AND l.entry_id=NEW.id AND loss.excluded_subsidiary_ids ? l.subsidiary_id::text)) OR NEW.reverses_entry_id IN(SELECT jsonb_array_elements_text(loss.measurement->'sourceEntryIds')::uuid) OR NEW.reverses_entry_id IN(SELECT jsonb_array_elements_text(f.result->'entryIds')::uuid FROM financial_changes f WHERE f.org_id=loss.org_id AND f.id=loss.change_id) OR NEW.reverses_entry_id IN(SELECT (evidence->>'entryId')::uuid FROM jsonb_array_elements(loss.measurement->'manualEvidence') evidence))) THEN RAISE EXCEPTION 'this posting changes an approved disposal source; propose a correction from Accounting changes before changing the historical balances'; END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='consolidated_fx_rates' THEN
  IF EXISTS(SELECT 1 FROM consolidation_control_losses loss JOIN accounting_periods p ON p.org_id=loss.org_id AND p.id=OLD.period_id WHERE loss.org_id=OLD.org_id AND loss.reversed_by_change_id IS NULL AND p.starts_on<=loss.effective_on AND EXISTS(SELECT 1 FROM subsidiaries s WHERE s.org_id=loss.org_id AND loss.excluded_subsidiary_ids ? s.id::text AND s.base_currency=OLD.from_currency)) AND (TG_OP='DELETE' OR (NEW.current_rate,NEW.average_rate,NEW.historical_rate) IS DISTINCT FROM (OLD.current_rate,OLD.average_rate,OLD.historical_rate)) THEN RAISE EXCEPTION 'consolidated rates support an approved disposal; correct that disposal before changing its historical translation evidence'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER control_loss_source_guard BEFORE INSERT OR UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION control_loss_source_guard();
CREATE TRIGGER control_loss_rate_guard BEFORE UPDATE OR DELETE ON consolidated_fx_rates FOR EACH ROW EXECUTE FUNCTION control_loss_source_guard();

CREATE OR REPLACE FUNCTION control_loss_hierarchy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN RETURN NEW; END IF;
 IF (NEW.parent_id,NEW.base_currency,NEW.is_active,NEW.is_elimination) IS DISTINCT FROM (OLD.parent_id,OLD.base_currency,OLD.is_active,OLD.is_elimination) AND EXISTS(SELECT 1 FROM consolidation_control_losses loss WHERE loss.org_id=OLD.org_id AND loss.reversed_by_change_id IS NULL AND (loss.excluded_subsidiary_ids ? OLD.id::text OR OLD.id IN(loss.parent_subsidiary_id,loss.elimination_subsidiary_id))) THEN RAISE EXCEPTION 'the entity hierarchy and currency support an approved disposal; correct the disposal before changing its historical reporting scope'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER control_loss_hierarchy_guard BEFORE UPDATE ON subsidiaries FOR EACH ROW EXECUTE FUNCTION control_loss_hierarchy_guard();

CREATE OR REPLACE FUNCTION control_loss_asset_measurement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM asset_transfer_bases b JOIN consolidation_control_losses loss ON loss.org_id=b.org_id AND loss.reversed_by_change_id IS NULL AND (loss.excluded_subsidiary_ids ? b.buyer_subsidiary_id::text OR loss.excluded_subsidiary_ids ? b.seller_subsidiary_id::text) WHERE b.org_id=NEW.org_id AND b.id=NEW.transfer_id AND NEW.effective_on<=loss.effective_on) THEN RAISE EXCEPTION 'this group measurement changes an approved disposal basis; correct that disposal through Accounting changes first'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER control_loss_asset_measurement_guard BEFORE INSERT ON asset_transfer_measurements FOR EACH ROW EXECUTE FUNCTION control_loss_asset_measurement_guard();

-- A component workpaper changes group basis even when its book has no GL.
CREATE OR REPLACE FUNCTION control_loss_component_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.group_component IS NOT NULL AND EXISTS(SELECT 1 FROM asset_transfer_bases b JOIN consolidation_control_losses loss ON loss.org_id=b.org_id AND loss.reversed_by_change_id IS NULL AND (loss.excluded_subsidiary_ids ? b.buyer_subsidiary_id::text OR loss.excluded_subsidiary_ids ? b.seller_subsidiary_id::text) WHERE b.org_id=NEW.org_id AND b.receiving_asset_id=NEW.asset_id AND b.book_id=NEW.book_id AND NEW.effective_on<=loss.effective_on) THEN RAISE EXCEPTION 'the component measurement changes an approved loss-of-control basis; correct that disposal through Accounting changes first'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER control_loss_component_guard BEFORE INSERT ON asset_basis_changes FOR EACH ROW EXECUTE FUNCTION control_loss_component_guard();
