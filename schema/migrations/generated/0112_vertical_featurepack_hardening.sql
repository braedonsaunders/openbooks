BEGIN;

-- Follow-up for installations that received 0111 before its final integrity
-- review. Fresh databases already receive these definitions from 0111; every
-- statement here is safe to replay and brings early installations to parity.

DROP INDEX IF EXISTS wip_prebill_lines_time_source;
DROP INDEX IF EXISTS wip_prebill_lines_cost_source;
CREATE INDEX wip_prebill_lines_time_source ON wip_prebill_lines (org_id, time_entry_id) WHERE time_entry_id IS NOT NULL;
CREATE INDEX wip_prebill_lines_cost_source ON wip_prebill_lines (org_id, document_line_id) WHERE document_line_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_plan_versions_published_effective
  ON subscription_plan_versions (org_id, plan_id, effective_from)
  WHERE status IN ('published','superseded');
CREATE UNIQUE INDEX IF NOT EXISTS subscription_components_one_open
  ON subscription_components (org_id, subscription_id, component_key)
  WHERE effective_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS projects_org_id_id_unique ON projects (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS parties_org_id_id_unique ON parties (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_org_id_id_unique ON documents (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS document_lines_org_id_id_unique ON document_lines (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_id_id_unique ON accounts (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS items_org_id_id_unique ON items (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS tax_codes_org_id_id_unique ON tax_codes (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS departments_org_id_id_unique ON departments (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_org_id_id_unique ON time_entries (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS time_types_org_id_id_unique ON time_types (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS billing_requests_org_id_id_unique ON billing_requests (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_plans_org_id_id_unique ON subscription_plans (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_org_id_id_unique ON subscriptions (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subcontracts_org_id_id_unique ON subcontracts (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subcontract_sov_lines_org_id_id_unique ON subcontract_sov_lines (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subcontract_change_orders_org_id_id_unique ON subcontract_change_orders (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_pay_applications_org_id_id_unique ON vendor_pay_applications (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS wip_prebills_org_id_id_unique ON wip_prebills (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_plan_versions_org_id_id_unique ON subscription_plan_versions (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_plan_version_components_org_id_id_unique ON subscription_plan_version_components (org_id, id);

DO $$
DECLARE fk record;
BEGIN
  FOR fk IN SELECT * FROM (VALUES
    ('subcontracts','subcontracts_project_org_fk','org_id, project_id','projects'),
    ('subcontracts','subcontracts_vendor_org_fk','org_id, vendor_id','parties'),
    ('subcontracts','subcontracts_po_org_fk','org_id, purchase_order_id','documents'),
    ('subcontract_sov_lines','subcontract_sov_parent_org_fk','org_id, subcontract_id','subcontracts'),
    ('subcontract_sov_lines','subcontract_sov_account_org_fk','org_id, expense_account_id','accounts'),
    ('subcontract_sov_lines','subcontract_sov_change_org_fk','org_id, change_order_id','subcontract_change_orders'),
    ('subcontract_change_orders','subcontract_change_parent_org_fk','org_id, subcontract_id','subcontracts'),
    ('subcontract_change_orders','subcontract_change_sov_org_fk','org_id, target_sov_line_id','subcontract_sov_lines'),
    ('vendor_pay_applications','vendor_pay_app_parent_org_fk','org_id, subcontract_id','subcontracts'),
    ('vendor_pay_applications','vendor_pay_app_bill_org_fk','org_id, vendor_bill_document_id','documents'),
    ('vendor_pay_application_lines','vendor_pay_line_app_org_fk','org_id, pay_application_id','vendor_pay_applications'),
    ('vendor_pay_application_lines','vendor_pay_line_sov_org_fk','org_id, sov_line_id','subcontract_sov_lines'),
    ('vendor_retainage_releases','vendor_retainage_parent_org_fk','org_id, subcontract_id','subcontracts'),
    ('vendor_retainage_releases','vendor_retainage_bill_org_fk','org_id, vendor_bill_document_id','documents'),
    ('subcontract_payment_controls','subcontract_control_parent_org_fk','org_id, subcontract_id','subcontracts'),
    ('subcontract_payment_controls','subcontract_control_app_org_fk','org_id, pay_application_id','vendor_pay_applications'),
    ('subcontract_payment_controls','subcontract_control_bill_org_fk','org_id, vendor_bill_document_id','documents'),
    ('subcontract_payment_controls','subcontract_control_payee_org_fk','org_id, joint_payee_party_id','parties'),
    ('wip_prebills','wip_prebill_project_org_fk','org_id, project_id','projects'),
    ('wip_prebills','wip_prebill_request_org_fk','org_id, billing_request_id','billing_requests'),
    ('wip_prebills','wip_prebill_invoice_org_fk','org_id, invoice_document_id','documents'),
    ('wip_prebill_lines','wip_prebill_line_parent_org_fk','org_id, prebill_id','wip_prebills'),
    ('wip_prebill_lines','wip_prebill_line_project_org_fk','org_id, project_id','projects'),
    ('wip_prebill_lines','wip_prebill_line_time_org_fk','org_id, time_entry_id','time_entries'),
    ('wip_prebill_lines','wip_prebill_line_cost_org_fk','org_id, document_line_id','document_lines'),
    ('wip_prebill_lines','wip_prebill_line_source_doc_org_fk','org_id, source_document_id','documents'),
    ('wip_prebill_lines','wip_prebill_line_item_org_fk','org_id, item_id','items'),
    ('wip_prebill_lines','wip_prebill_line_income_org_fk','org_id, income_account_id','accounts'),
    ('wip_prebill_lines','wip_prebill_line_tax_org_fk','org_id, tax_code_id','tax_codes'),
    ('wip_prebill_lines','wip_prebill_line_employee_org_fk','org_id, employee_party_id','parties'),
    ('wip_prebill_lines','wip_prebill_line_time_type_org_fk','org_id, time_type_id','time_types'),
    ('wip_prebill_lines','wip_prebill_line_department_org_fk','org_id, department_id','departments'),
    ('wip_holds','wip_hold_project_org_fk','org_id, project_id','projects'),
    ('wip_prebill_events','wip_event_parent_org_fk','org_id, prebill_id','wip_prebills'),
    ('subscription_plan_versions','subscription_version_plan_org_fk','org_id, plan_id','subscription_plans'),
    ('subscription_plan_version_components','subscription_version_component_parent_org_fk','org_id, version_id','subscription_plan_versions'),
    ('subscription_plan_version_components','subscription_version_component_income_org_fk','org_id, income_account_id','accounts'),
    ('subscription_plan_version_components','subscription_version_component_item_org_fk','org_id, item_id','items'),
    ('subscription_plan_version_components','subscription_version_component_tax_org_fk','org_id, tax_code_id','tax_codes'),
    ('subscription_lifecycles','subscription_lifecycle_subscription_org_fk','org_id, subscription_id','subscriptions'),
    ('subscription_lifecycles','subscription_lifecycle_version_org_fk','org_id, plan_version_id','subscription_plan_versions'),
    ('subscription_lifecycles','subscription_lifecycle_anchor_org_fk','org_id, coterm_anchor_subscription_id','subscriptions'),
    ('subscription_components','subscription_component_subscription_org_fk','org_id, subscription_id','subscriptions'),
    ('subscription_components','subscription_component_source_org_fk','org_id, source_version_component_id','subscription_plan_version_components'),
    ('subscription_components','subscription_component_income_org_fk','org_id, income_account_id','accounts'),
    ('subscription_components','subscription_component_item_org_fk','org_id, item_id','items'),
    ('subscription_components','subscription_component_tax_org_fk','org_id, tax_code_id','tax_codes'),
    ('subscription_amendments','subscription_amendment_subscription_org_fk','org_id, subscription_id','subscriptions'),
    ('subscription_period_invoices','subscription_period_subscription_org_fk','org_id, subscription_id','subscriptions'),
    ('subscription_period_invoices','subscription_period_invoice_org_fk','org_id, invoice_id','documents')
  ) AS refs(child_table, constraint_name, child_columns, parent_table)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=fk.constraint_name AND conrelid=fk.child_table::regclass) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I (org_id, id) DEFERRABLE INITIALLY IMMEDIATE',
        fk.child_table, fk.constraint_name, fk.child_columns, fk.parent_table);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION wip_prebill_source_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text; source_key uuid;
BEGIN
  SELECT status INTO parent_status FROM wip_prebills WHERE org_id=NEW.org_id AND id=NEW.prebill_id;
  IF parent_status NOT IN ('draft','review','approved') THEN RETURN NEW; END IF;
  source_key := coalesce(NEW.time_entry_id, NEW.document_line_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text||':'||NEW.source_type||':'||source_key::text,0));
  IF EXISTS (SELECT 1 FROM wip_prebill_lines line JOIN wip_prebills worksheet ON worksheet.org_id=line.org_id AND worksheet.id=line.prebill_id
    WHERE line.org_id=NEW.org_id AND line.id<>NEW.id AND line.source_type=NEW.source_type
      AND coalesce(line.time_entry_id,line.document_line_id)=source_key AND worksheet.status IN ('draft','review','approved'))
  THEN RAISE EXCEPTION 'WIP source is already reserved by an active prebill'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wip_prebill_source_reservation ON wip_prebill_lines;
CREATE TRIGGER wip_prebill_source_reservation BEFORE INSERT OR UPDATE OF prebill_id,source_type,time_entry_id,document_line_id
  ON wip_prebill_lines FOR EACH ROW EXECUTE FUNCTION wip_prebill_source_reservation_guard();

CREATE OR REPLACE FUNCTION wip_prebill_event_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION 'WIP prebill events are append-only';
END $$;
DROP TRIGGER IF EXISTS wip_prebill_event_append_only ON wip_prebill_events;
CREATE TRIGGER wip_prebill_event_append_only BEFORE UPDATE OR DELETE ON wip_prebill_events
  FOR EACH ROW EXECUTE FUNCTION wip_prebill_event_append_only_guard();

CREATE OR REPLACE FUNCTION subscription_plan_version_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF OLD.status IN ('published','superseded') THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'published subscription plan versions are immutable'; END IF;
    IF ROW(OLD.plan_id,OLD.effective_from,OLD.name,OLD.description,OLD.currency_code,OLD.interval,OLD.interval_count,OLD.billing_timing,OLD.published_at,OLD.published_by)
      IS DISTINCT FROM ROW(NEW.plan_id,NEW.effective_from,NEW.name,NEW.description,NEW.currency_code,NEW.interval,NEW.interval_count,NEW.billing_timing,NEW.published_at,NEW.published_by)
    THEN RAISE EXCEPTION 'published subscription plan commercial terms are immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS subscription_plan_version_immutable ON subscription_plan_versions;
CREATE TRIGGER subscription_plan_version_immutable BEFORE UPDATE OR DELETE ON subscription_plan_versions
  FOR EACH ROW EXECUTE FUNCTION subscription_plan_version_immutable_guard();

CREATE OR REPLACE FUNCTION subscription_version_component_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_version uuid; parent_status text;
BEGIN
  IF current_setting('app.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  parent_version := CASE WHEN TG_OP='DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  SELECT status INTO parent_status FROM subscription_plan_versions WHERE id=parent_version;
  IF parent_status IN ('published','superseded') THEN RAISE EXCEPTION 'components of published subscription plan versions are immutable'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS subscription_version_component_immutable ON subscription_plan_version_components;
CREATE TRIGGER subscription_version_component_immutable BEFORE INSERT OR UPDATE OR DELETE ON subscription_plan_version_components
  FOR EACH ROW EXECUTE FUNCTION subscription_version_component_immutable_guard();

CREATE OR REPLACE FUNCTION subscription_amendment_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF OLD.status='applied' THEN RAISE EXCEPTION 'applied subscription amendments are immutable'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS subscription_amendment_immutable ON subscription_amendments;
CREATE TRIGGER subscription_amendment_immutable BEFORE UPDATE OR DELETE ON subscription_amendments
  FOR EACH ROW EXECUTE FUNCTION subscription_amendment_immutable_guard();

CREATE OR REPLACE FUNCTION subscription_period_invoice_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION 'subscription period invoice lineage is immutable';
END $$;
DROP TRIGGER IF EXISTS subscription_period_invoice_immutable ON subscription_period_invoices;
CREATE TRIGGER subscription_period_invoice_immutable BEFORE UPDATE OR DELETE ON subscription_period_invoices
  FOR EACH ROW EXECUTE FUNCTION subscription_period_invoice_immutable_guard();

-- 0111 was hardened before release; reconcile the digest only after every
-- equivalent guard above has installed successfully on an early database.
UPDATE _applied_migrations
   SET sha256='c9221277fee0d0ef5929c99580f57e2e41561712c36c416f8276cf904add412b'
 WHERE filename='generated/0111_subcontracts_wip_advanced_subscriptions.sql';

COMMIT;
