-- OpenBooks forward migration 0204_asset_lifecycle_changes.
--
-- Append-only, independently approved book-basis changes. Historical cost and
-- posted depreciation retain their identities; all carrying reads net these.
SET search_path=public,pg_catalog;
CREATE TABLE IF NOT EXISTS asset_basis_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ordinal bigserial NOT NULL, org_id uuid NOT NULL REFERENCES orgs(id),
 asset_id uuid NOT NULL REFERENCES fixed_assets(id), book_id uuid NOT NULL REFERENCES accounting_books(id),
 change_id uuid NOT NULL REFERENCES financial_changes(id), effective_on date NOT NULL,
 units_remaining numeric(19,4) CHECK(units_remaining>=0),depreciable_after numeric(19,4) CHECK(depreciable_after>=0),
 group_component jsonb,
 impairment_released numeric(19,4) NOT NULL DEFAULT 0,
 cost_delta numeric(19,4) NOT NULL, accumulated_delta numeric(19,4) NOT NULL, salvage_delta numeric(19,4) NOT NULL,
 journal_entry_id uuid REFERENCES journal_entries(id), stub_journal_entry_id uuid REFERENCES journal_entries(id),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES users(id),
 UNIQUE(org_id,id), UNIQUE(org_id,asset_id,book_id,change_id),
 FOREIGN KEY(org_id,change_id) REFERENCES financial_changes(org_id,id)
);
CREATE INDEX IF NOT EXISTS asset_basis_changes_subject ON asset_basis_changes(org_id,asset_id,book_id,effective_on);
ALTER TABLE asset_basis_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_basis_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON asset_basis_changes;
CREATE POLICY org_isolation ON asset_basis_changes USING (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true)) WITH CHECK (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON asset_basis_changes IS 'openbooks:org_isolation:v1';
CREATE OR REPLACE FUNCTION asset_basis_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'asset basis changes are immutable; approve an adjusting change'; END IF;
 IF NOT EXISTS(SELECT 1 FROM financial_changes f WHERE f.id=NEW.change_id AND f.org_id=NEW.org_id AND f.domain='asset' AND f.subject_id=NEW.asset_id AND f.status='approved') THEN RAISE EXCEPTION 'asset basis requires independent approval for this asset'; END IF;
 IF NOT EXISTS(SELECT 1 FROM fixed_assets a WHERE a.id=NEW.asset_id AND a.org_id=NEW.org_id) OR NOT EXISTS(SELECT 1 FROM accounting_books b WHERE b.id=NEW.book_id AND b.org_id=NEW.org_id) THEN RAISE EXCEPTION 'asset basis references another organization'; END IF;
 IF NEW.journal_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.id=NEW.journal_entry_id AND e.org_id=NEW.org_id AND e.book_id=NEW.book_id AND e.status='posted' AND e.posting_date=NEW.effective_on AND e.subsidiary_id=(SELECT a.subsidiary_id FROM fixed_assets a WHERE a.org_id=NEW.org_id AND a.id=NEW.asset_id)) THEN RAISE EXCEPTION 'asset basis requires its posted book journal'; END IF;
 IF NEW.stub_journal_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.id=NEW.stub_journal_entry_id AND e.org_id=NEW.org_id AND e.book_id=NEW.book_id AND e.status='posted' AND e.posting_date=NEW.effective_on AND e.subsidiary_id=(SELECT a.subsidiary_id FROM fixed_assets a WHERE a.org_id=NEW.org_id AND a.id=NEW.asset_id)) THEN RAISE EXCEPTION 'elapsed depreciation must reference its posted book journal'; END IF;
 -- Absence must match too: accepting NULL when the approval contains a group
 -- component would silently make consolidation infer a legal-book fraction.
 IF NEW.group_component IS DISTINCT FROM (SELECT f.before_state->'groupComponents'->NEW.book_id::text FROM financial_changes f WHERE f.org_id=NEW.org_id AND f.id=NEW.change_id AND f.operation IN('partial_disposal','intercompany_transfer')) OR (NEW.group_component IS NOT NULL AND NOT EXISTS(SELECT 1 FROM asset_transfer_bases t WHERE t.org_id=NEW.org_id AND t.receiving_asset_id=NEW.asset_id AND t.book_id=NEW.book_id AND t.reversed_by_change_id IS NULL)) THEN RAISE EXCEPTION 'group component basis must match its independently approved retained and removed measurements'; END IF;
 IF NEW.effective_on<>(SELECT f.effective_on FROM financial_changes f WHERE f.org_id=NEW.org_id AND f.id=NEW.change_id) THEN RAISE EXCEPTION 'basis date differs from the approved effective date'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_basis_change_guard BEFORE INSERT OR UPDATE OR DELETE ON asset_basis_changes FOR EACH ROW EXECUTE FUNCTION asset_basis_change_guard();
ALTER TABLE asset_events ADD COLUMN IF NOT EXISTS financial_change_id uuid REFERENCES financial_changes(id),ADD COLUMN IF NOT EXISTS book_id uuid REFERENCES accounting_books(id);
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS transferred_from_asset_id uuid REFERENCES fixed_assets(id);

CREATE OR REPLACE VIEW asset_book_carrying_values WITH (security_invoker=true) AS
 SELECT a.org_id,a.id AS asset_id,b.id AS book_id,
  CASE WHEN a.status IN('disposed','written_off') THEN 0 ELSE a.acquisition_cost+coalesce(x.cost_delta,0) END AS cost,
  CASE WHEN a.status IN('disposed','written_off') THEN 0 ELSE a.salvage_value+coalesce(x.salvage_delta,0) END AS salvage,
  CASE WHEN a.status IN('disposed','written_off') THEN 0 ELSE coalesce(a.opening_accumulated_depreciation,0)+coalesce(d.amount,0)-coalesce(v.amount,0)+coalesce(x.accumulated_delta,0) END AS accumulated,
  CASE WHEN a.status IN('disposed','written_off') THEN 0 ELSE a.acquisition_cost+coalesce(x.cost_delta,0)-coalesce(a.opening_accumulated_depreciation,0)-coalesce(d.amount,0)+coalesce(v.amount,0)-coalesce(x.accumulated_delta,0) END AS carrying_value,
  x.cutoff
 FROM fixed_assets a JOIN accounting_books b ON b.org_id=a.org_id
 LEFT JOIN LATERAL(SELECT sum(cost_delta) cost_delta,sum(accumulated_delta) accumulated_delta,sum(salvage_delta) salvage_delta,max(effective_on) cutoff FROM asset_basis_changes x WHERE x.org_id=a.org_id AND x.asset_id=a.id AND x.book_id=b.id) x ON true
 LEFT JOIN LATERAL(SELECT sum(l.posted_amount) amount FROM depreciation_schedules s JOIN depreciation_schedule_lines l ON l.schedule_id=s.id AND l.org_id=s.org_id WHERE s.org_id=a.org_id AND s.asset_id=a.id AND s.book_id=b.id) d ON true
 LEFT JOIN LATERAL(SELECT sum(v.amount) amount FROM asset_events v JOIN journal_entries e ON e.id=v.journal_entry_id AND e.org_id=v.org_id WHERE v.org_id=a.org_id AND v.asset_id=a.id AND e.book_id=b.id AND e.status='posted' AND v.kind IN('impaired','revalued') AND NOT EXISTS(SELECT 1 FROM asset_events r WHERE r.org_id=v.org_id AND r.reverses_event_id=v.id)) v ON true;

CREATE TABLE IF NOT EXISTS asset_transfer_bases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES orgs(id),
 change_id uuid NOT NULL REFERENCES financial_changes(id), source_asset_id uuid NOT NULL REFERENCES fixed_assets(id),
 receiving_asset_id uuid NOT NULL REFERENCES fixed_assets(id), book_id uuid NOT NULL REFERENCES accounting_books(id), effective_on date NOT NULL,
 seller_subsidiary_id uuid NOT NULL REFERENCES subsidiaries(id),buyer_subsidiary_id uuid NOT NULL REFERENCES subsidiaries(id),elimination_subsidiary_id uuid NOT NULL REFERENCES subsidiaries(id),
 group_currency text NOT NULL REFERENCES currencies(code),basis jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES users(id),
 UNIQUE(org_id,id),UNIQUE(org_id,change_id,book_id),UNIQUE(org_id,receiving_asset_id,book_id),FOREIGN KEY(org_id,change_id) REFERENCES financial_changes(org_id,id)
);
CREATE TABLE IF NOT EXISTS asset_transfer_consolidation_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES orgs(id),
 transfer_id uuid NOT NULL REFERENCES asset_transfer_bases(id),period_id uuid NOT NULL REFERENCES accounting_periods(id),
 journal_entry_id uuid NOT NULL REFERENCES journal_entries(id),target_balances jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES users(id),
 FOREIGN KEY(org_id,transfer_id) REFERENCES asset_transfer_bases(org_id,id)
);
ALTER TABLE asset_transfer_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_transfer_bases FORCE ROW LEVEL SECURITY;
ALTER TABLE asset_transfer_consolidation_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_transfer_consolidation_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON asset_transfer_bases USING(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
CREATE POLICY org_isolation ON asset_transfer_consolidation_entries USING(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON asset_transfer_bases IS 'openbooks:org_isolation:v1';
COMMENT ON POLICY org_isolation ON asset_transfer_consolidation_entries IS 'openbooks:org_isolation:v1';
-- Basis-bearing assets cannot evade the controlled workflow via a generic edit.
CREATE OR REPLACE FUNCTION asset_changed_basis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM asset_basis_changes x WHERE x.org_id=OLD.org_id AND x.asset_id=OLD.id) OR OLD.transferred_from_asset_id IS NOT NULL THEN
  IF (NEW.org_id,NEW.id,NEW.subsidiary_id,NEW.category_id,NEW.acquisition_cost,NEW.salvage_value,NEW.in_service_on,NEW.opening_accumulated_depreciation,NEW.opening_accumulated_as_of,NEW.asset_account_id,NEW.accumulated_depreciation_account_id,NEW.depreciation_expense_account_id,NEW.depreciation_method,NEW.depreciation_method_id,NEW.useful_life_months,NEW.depreciation_rate_percent,NEW.depreciation_convention,NEW.depreciation_units_total,NEW.transferred_from_asset_id) IS DISTINCT FROM (OLD.org_id,OLD.id,OLD.subsidiary_id,OLD.category_id,OLD.acquisition_cost,OLD.salvage_value,OLD.in_service_on,OLD.opening_accumulated_depreciation,OLD.opening_accumulated_as_of,OLD.asset_account_id,OLD.accumulated_depreciation_account_id,OLD.depreciation_expense_account_id,OLD.depreciation_method,OLD.depreciation_method_id,OLD.useful_life_months,OLD.depreciation_rate_percent,OLD.depreciation_convention,OLD.depreciation_units_total,OLD.transferred_from_asset_id) THEN RAISE EXCEPTION 'approved asset basis cannot be rewritten; propose a lifecycle change'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_changed_basis_guard BEFORE UPDATE ON fixed_assets FOR EACH ROW EXECUTE FUNCTION asset_changed_basis_guard();

ALTER TABLE asset_transfer_bases ADD COLUMN IF NOT EXISTS reversed_by_change_id uuid REFERENCES financial_changes(id),ADD COLUMN IF NOT EXISTS reversed_on date;
CREATE OR REPLACE FUNCTION asset_transfer_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
 IF TG_TABLE_NAME='asset_transfer_bases' THEN
  IF TG_OP='INSERT' THEN
   IF NOT EXISTS(SELECT 1 FROM fixed_assets a WHERE a.org_id=NEW.org_id AND a.id=NEW.source_asset_id AND a.subsidiary_id=NEW.seller_subsidiary_id) OR NOT EXISTS(SELECT 1 FROM fixed_assets a WHERE a.org_id=NEW.org_id AND a.id=NEW.receiving_asset_id AND a.subsidiary_id=NEW.buyer_subsidiary_id AND a.transferred_from_asset_id=NEW.source_asset_id) OR NOT EXISTS(SELECT 1 FROM subsidiaries s WHERE s.org_id=NEW.org_id AND s.id=NEW.elimination_subsidiary_id AND s.is_elimination AND s.base_currency=NEW.group_currency) OR NOT EXISTS(SELECT 1 FROM accounting_books b WHERE b.org_id=NEW.org_id AND b.id=NEW.book_id) THEN RAISE EXCEPTION 'transfer evidence must reference its tenant, asset owners, book and group currency'; END IF;
   IF NOT EXISTS(SELECT 1 FROM financial_changes f WHERE f.org_id=NEW.org_id AND f.id=NEW.change_id AND f.subject_id=NEW.source_asset_id AND f.domain='asset' AND f.operation='intercompany_transfer' AND f.status='approved') THEN RAISE EXCEPTION 'transfer basis requires its independently approved change'; END IF;
  ELSIF TG_OP='UPDATE' THEN
   IF OLD.reversed_by_change_id IS NOT NULL OR NEW.reversed_by_change_id IS NULL OR NEW.reversed_on IS NULL OR NEW.reversed_on<OLD.effective_on OR (to_jsonb(NEW)-ARRAY['reversed_by_change_id','reversed_on']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['reversed_by_change_id','reversed_on']) OR NOT EXISTS(SELECT 1 FROM financial_changes f WHERE f.org_id=OLD.org_id AND f.id=NEW.reversed_by_change_id AND f.domain='asset' AND f.operation='reversal' AND f.subject_id=OLD.source_asset_id AND f.payload->>'sourceChangeId'=OLD.change_id::text AND f.status='approved') THEN RAISE EXCEPTION 'only an independently approved reversal may close a transfer basis'; END IF;
  ELSE RAISE EXCEPTION 'asset transfer evidence is immutable'; END IF;
 ELSE
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'asset transfer consolidation evidence is immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM asset_transfer_bases b JOIN journal_entries e ON e.org_id=b.org_id AND e.id=NEW.journal_entry_id AND e.book_id=b.book_id AND e.subsidiary_id=b.elimination_subsidiary_id AND e.status='posted' AND e.period_id=NEW.period_id JOIN accounting_periods p ON p.org_id=e.org_id AND p.id=e.period_id WHERE b.org_id=NEW.org_id AND b.id=NEW.transfer_id) THEN RAISE EXCEPTION 'asset consolidation evidence requires its posted group/book journal'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_transfer_history_guard BEFORE INSERT OR UPDATE OR DELETE ON asset_transfer_bases FOR EACH ROW EXECUTE FUNCTION asset_transfer_history_guard();
CREATE TRIGGER asset_transfer_history_guard BEFORE INSERT OR UPDATE OR DELETE ON asset_transfer_consolidation_entries FOR EACH ROW EXECUTE FUNCTION asset_transfer_history_guard();

CREATE OR REPLACE FUNCTION asset_lifecycle_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='fixed_assets' THEN
  IF NEW.transferred_from_asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fixed_assets a WHERE a.org_id=NEW.org_id AND a.id=NEW.transferred_from_asset_id AND a.id<>NEW.id) THEN RAISE EXCEPTION 'the source asset must belong to the same organization'; END IF;
 ELSE
  IF NEW.financial_change_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM financial_changes f JOIN fixed_assets a ON a.org_id=f.org_id AND a.id=NEW.asset_id WHERE f.org_id=NEW.org_id AND f.id=NEW.financial_change_id AND f.domain='asset' AND f.status='approved' AND f.effective_on=NEW.occurred_on AND (f.subject_id=a.id OR (a.transferred_from_asset_id=f.subject_id AND (NEW.kind='acquired' AND f.operation='intercompany_transfer' OR NEW.kind='reversed' AND f.operation='reversal')))) THEN RAISE EXCEPTION 'asset event requires independent approval for this asset and effective date'; END IF;
  IF NEW.book_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM accounting_books b WHERE b.org_id=NEW.org_id AND b.id=NEW.book_id) OR (NEW.journal_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.org_id=NEW.org_id AND e.id=NEW.journal_entry_id AND e.book_id=NEW.book_id))) THEN RAISE EXCEPTION 'asset event book must match its tenant and journal'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_lifecycle_reference_guard BEFORE INSERT OR UPDATE ON fixed_assets FOR EACH ROW EXECUTE FUNCTION asset_lifecycle_reference_guard();
CREATE TRIGGER asset_lifecycle_reference_guard BEFORE INSERT OR UPDATE ON asset_events FOR EACH ROW EXECUTE FUNCTION asset_lifecycle_reference_guard();

-- Group recoverability is a distinct, approved measurement, never silently
-- inferred from a receiving legal entity's impairment or valuation reserve.
CREATE TABLE asset_transfer_measurements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ordinal bigserial NOT NULL,
 org_id uuid NOT NULL REFERENCES orgs(id),transfer_id uuid NOT NULL REFERENCES asset_transfer_bases(id),
 source_event_id uuid NOT NULL REFERENCES asset_events(id),change_id uuid NOT NULL REFERENCES financial_changes(id),
 effective_on date NOT NULL,measurement jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES users(id),
 UNIQUE(org_id,id),UNIQUE(org_id,change_id),
 FOREIGN KEY(org_id,transfer_id) REFERENCES asset_transfer_bases(org_id,id),
 FOREIGN KEY(org_id,change_id) REFERENCES financial_changes(org_id,id)
);
ALTER TABLE asset_transfer_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_transfer_measurements FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON asset_transfer_measurements USING(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON asset_transfer_measurements IS 'openbooks:org_isolation:v1';
CREATE OR REPLACE FUNCTION asset_transfer_measurement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'approved group asset measurements are immutable; propose a correcting group valuation'; END IF;
 IF NOT EXISTS(SELECT 1 FROM asset_transfer_bases b JOIN asset_events v ON v.org_id=b.org_id AND v.asset_id=b.receiving_asset_id JOIN journal_entries e ON e.org_id=v.org_id AND e.id=v.journal_entry_id JOIN financial_changes f ON f.org_id=b.org_id AND f.id=NEW.change_id WHERE b.org_id=NEW.org_id AND b.id=NEW.transfer_id AND b.reversed_by_change_id IS NULL AND v.id=NEW.source_event_id AND v.kind IN('impaired','revalued') AND v.occurred_on=NEW.effective_on AND e.book_id=b.book_id AND e.status='posted' AND f.subject_id=b.receiving_asset_id AND f.domain='asset' AND f.operation='group_valuation' AND f.status='approved' AND f.effective_on=NEW.effective_on) THEN RAISE EXCEPTION 'group valuation requires its approved asset, book and source valuation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_transfer_measurement_guard BEFORE INSERT OR UPDATE OR DELETE ON asset_transfer_measurements FOR EACH ROW EXECUTE FUNCTION asset_transfer_measurement_guard();

-- A governed multi-book correction reverses its EVENTS as well as its ledger.
-- Non-posting books and zero-valued journals still have valid approved basis
-- evidence; do not invent a zero GL entry merely to record their correction.
ALTER TABLE asset_events DROP CONSTRAINT asset_events_reversal_shape;
ALTER TABLE asset_events ADD CONSTRAINT asset_events_reversal_shape CHECK (
 (kind='reversed' AND reverses_event_id IS NOT NULL AND (journal_entry_id IS NOT NULL OR (financial_change_id IS NOT NULL AND book_id IS NOT NULL)) AND reversal_reason IS NOT NULL AND length(btrim(reversal_reason)) BETWEEN 8 AND 500)
 OR (kind<>'reversed' AND reverses_event_id IS NULL AND reversal_reason IS NULL)
);
CREATE OR REPLACE FUNCTION asset_event_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record;
BEGIN
 IF TG_OP IN('UPDATE','DELETE') THEN
  IF openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN coalesce(NEW,OLD); END IF;
  RAISE EXCEPTION 'asset lifecycle evidence is append-only; post a linked reversal event';
 END IF;
 IF NEW.kind='reversed' THEN
  SELECT * INTO source FROM asset_events WHERE id=NEW.reverses_event_id FOR SHARE;
  IF source.id IS NULL OR source.org_id<>NEW.org_id OR source.asset_id<>NEW.asset_id OR source.kind NOT IN('revalued','impaired','disposed','written_off','partially_disposed','transferred','acquired') THEN RAISE EXCEPTION 'an asset reversal must reference a reversible event for the same tenant and asset'; END IF;
  IF source.financial_change_id IS NOT NULL THEN
   IF NEW.book_id IS DISTINCT FROM source.book_id OR NOT EXISTS(SELECT 1 FROM financial_changes f WHERE f.org_id=NEW.org_id AND f.id=NEW.financial_change_id AND f.domain='asset' AND f.operation='reversal' AND f.status='approved' AND f.payload->>'sourceChangeId'=source.financial_change_id::text) THEN RAISE EXCEPTION 'governed asset events require the approved correction of their original change and book'; END IF;
  ELSIF source.kind IN('acquired','partially_disposed','transferred') THEN
   RAISE EXCEPTION 'this acquisition or transfer has no governed correction evidence';
  END IF;
  IF source.financial_change_id IS NOT NULL AND ((source.journal_entry_id IS NULL) IS DISTINCT FROM (NEW.journal_entry_id IS NULL) OR (source.journal_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.org_id=NEW.org_id AND e.id=NEW.journal_entry_id AND e.reverses_entry_id=source.journal_entry_id AND e.status='posted'))) THEN RAISE EXCEPTION 'asset correction event must link the exact reversing journal'; END IF;
 END IF;
 RETURN NEW;
END $$;
