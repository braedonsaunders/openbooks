-- Governed query coverage and two trigger guard repairs.
--
-- Separation payment declarations: the reference guard's selected-event
-- variable no longer shares its name with the issued event source's event_id
-- column, which PostgreSQL refuses as ambiguous on every declaration write.
-- The guard's rules are unchanged.
--
-- Journal lines: the line guard admits tenant retirement deletes like every
-- other retirement-contracted guard. The installed body is patched in place,
-- as the retirement contracts patch their guards, and is verified against
-- its published digest before and after.
--
-- Inventory, warehouse, manufacturing, rebate, recognition, provision,
-- renewal, statement delivery and operating profile records join the
-- governed query catalog.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.payroll_roe_separation_basis_reference_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE subject jsonb; selected_event uuid; tenant uuid;
BEGIN
 subject:=CASE WHEN TG_OP='INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;
 tenant:=(subject->>'org_id')::uuid;selected_event:=(subject->>'separation_event_id')::uuid;
 IF TG_OP='UPDATE' AND (NEW.org_id,NEW.id,NEW.separation_event_id) IS DISTINCT FROM (OLD.org_id,OLD.id,OLD.separation_event_id) THEN
   RAISE EXCEPTION 'A separation payment declaration retains its organization, identity and selected event' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,subject)
   OR public.openbooks_sandbox_wipe_allowed(tenant)) THEN RETURN OLD; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||tenant::text||':'||
   (SELECT employee_party_id::text FROM public.payroll_roe_separation_events WHERE org_id=tenant AND id=selected_event),0));
 IF EXISTS(SELECT 1 FROM public.payroll_roe_separation_events e WHERE e.org_id=tenant AND e.id=selected_event AND e.status='issued')
   OR EXISTS(SELECT 1 FROM public.payroll_roe_issued_event_sources b WHERE b.org_id=tenant AND b.event_id=selected_event) THEN
   RAISE EXCEPTION 'Issued ROE separation payment declarations are immutable; retain the original statutory source' USING ERRCODE='23514';
 END IF;
 IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.payroll_roe_line_evidence evidence
   WHERE evidence.org_id=tenant AND evidence.reporting_basis='separation_payment' AND evidence.separation_payment_id=OLD.id) THEN
   RAISE EXCEPTION 'Qualified ROE separation reporting retains this payment; withdraw unissued attribution before correcting its declaration' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.source_line_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.pay_stub_lines l JOIN public.pay_stubs s ON s.org_id=l.org_id AND s.id=l.stub_id
   JOIN public.pay_runs r ON r.org_id=s.org_id AND r.document_id=s.pay_run_document_id AND r.run_status='committed'
   JOIN public.documents d ON d.org_id=r.org_id AND d.id=r.document_id
   JOIN public.payroll_roe_separation_events e ON e.org_id=s.org_id AND e.id=NEW.separation_event_id
   WHERE l.org_id=NEW.org_id AND l.id=NEW.source_line_id AND l.kind='earning' AND l.component_id=NEW.pay_component_id
     AND l.amount=NEW.amount AND l.amount>0 AND l.amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND (l.hours IS NULL OR l.hours=0) AND s.pay_date=NEW.expected_payment_on
     AND s.employee_party_id=e.employee_party_id AND s.employment_id=e.employment_id AND d.subsidiary_id=e.subsidiary_id AND d.status<>'voided'
     AND s.currency_code='CAD' AND NEW.payment_status='paid') THEN
   RAISE EXCEPTION 'A paid separation declaration must retain its exact committed employee line and payment facts' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

DO $journal_line_retirement$
DECLARE proc record; replacement text;
BEGIN
 SELECT p.oid,p.prosrc INTO STRICT proc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='jl_guard' AND p.pronargs=0;
 IF encode(public.digest(proc.prosrc,'sha256'),'hex')='7d99adf2194cdb727672a9cbc5b5b07cc6e75788422e678439b276191eb13b3f' THEN
  RETURN; -- expected on replay: the retirement authority is already installed
 END IF;
 IF encode(public.digest(proc.prosrc,'sha256'),'hex')<>'05c9fd13613199ff8f8e571e52bf6e32c2fbe51587a8be15afaf5242357a4242' THEN
  RAISE EXCEPTION 'jl_guard differs from its published definition; reconcile it before applying this migration' USING ERRCODE='55000';
 END IF;
 replacement:=regexp_replace(proc.prosrc,'(\m[Bb][Ee][Gg][Ii][Nn]\M)',E'\\1\n  IF TG_OP = ''DELETE'' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN\n    RETURN OLD;\n  END IF;\n');
 IF encode(public.digest(replacement,'sha256'),'hex')<>'7d99adf2194cdb727672a9cbc5b5b07cc6e75788422e678439b276191eb13b3f' THEN
  RAISE EXCEPTION 'jl_guard retirement authority differs from its published body' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(pg_get_functiondef(proc.oid),proc.prosrc,replacement);
END $journal_line_retirement$;

INSERT INTO public.openbooks_query_catalog_relations(relation, added_in) VALUES
 ('assembly_disassemblies', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('consignment_events', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('consignment_stock', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('document_goods_tax_snapshots', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('drop_ship_agent_allocations', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('handling_unit_contents', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('handling_unit_moves', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('handling_units', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('inventory_count_policies', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('inventory_inspection_plans', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('inventory_inspections', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('mfg_completion_batches', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('mfg_completion_inputs', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('mfg_subcontract_material_returns', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('mfg_subcontract_returns', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('mfg_subcontract_service_bills', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('mfg_subcontract_shipments', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('mfg_subcontracts', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('net_investment_entries', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('net_investment_sources', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('operating_profile_scopes', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('operating_profile_versions', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('operating_profiles', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('pay_component_department_expenses', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('pick_execution_lines', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('pick_wave_members', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('pick_waves', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('provision_obligations', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('purchase_over_receipt_tolerances', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('rebate_accruals', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('rebate_agreements', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('rebate_claims', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('rebate_cost_attestations', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('rebate_settlement_reversals', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('recognition_control_events', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('statement_batch_items', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('statement_batch_runs', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('subscription_renewal_occurrences', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('subscription_renewal_policies', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('time_approval_policies', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('warehouse_defaults', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('warehouse_execution_tasks', '0752_governed_catalog_coverage_and_guard_repairs'),
 ('warehouse_scan_events', '0752_governed_catalog_coverage_and_guard_repairs')
ON CONFLICT (relation) DO NOTHING; -- expected on replay; the registry seed is idempotent
SELECT public.openbooks_refresh_query_catalog();
