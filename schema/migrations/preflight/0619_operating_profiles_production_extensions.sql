-- Admission examines only the pre-migration catalog and existing tenant rows.
-- New nullable references remain NULL; operation/per-unit/order defaults preserve
-- legacy rows. New child tables are empty. The operation scrap check widens the
-- positive-value contract only for a newly approved zero-value loss disposition.
-- Labor snapshots copy the uniquely matched routing sequence, retaining NULL
-- when no labor standard exists; missing standards never become zero here.
-- Unknown or partially installed schema objects are preserved for owner review.
WITH
wanted_relations(name) AS (VALUES
 ('operating_profiles'),
 ('operating_profile_versions'),
 ('operating_profile_scopes'),
 ('operating_profile_scope_identity'),
 ('time_entries_one_replacement'),
 ('mfg_completion_batches'),
 ('mfg_completion_inputs'),
 ('mfg_completion_inputs_source'),
 ('inventory_inspection_plans'),
 ('inventory_inspections'),
 ('inventory_inspection_operation_identity'),
 ('inventory_inspection_operation_sequence'),
 ('inventory_inspection_queue'),
 ('inventory_inspection_lot_holds'),
 ('inventory_inspection_serial_holds'),
 ('mfg_subcontracts'),
 ('mfg_subcontract_open_operation'),
 ('mfg_subcontract_shipments'),
 ('mfg_subcontract_returns'),
 ('mfg_subcontract_consumption_request'),
 ('mfg_subcontract_service_bills'),
 ('mfg_subcontract_service_active_bill'),
 ('mfg_subcontract_material_returns'),
 ('mfg_subcontract_material_return_from_unique'),
 ('mfg_subcontract_material_return_to_unique'),
 ('mfg_scrap_one_loss_disposition'),
 ('mfg_work_order_one_loss_change'),
 ('mfg_one_receipt_rework'),
 ('inspection_one_receipt_rework_work')
),
wanted_functions(name) AS (VALUES
 ('operating_profile_version_immutable'),
 ('work_operating_profile_guard'),
 ('operating_profile_scope_guard'),
 ('production_time_history_guard'),
 ('production_operation_time_snapshot_guard'),
 ('manufacturing_routing_revision_guard'),
 ('manufacturing_routing_operation_guard'),
 ('manufacturing_released_revision_guard'),
 ('manufacturing_completion_trace_guard'),
 ('inventory_inspection_plan_guard'),
 ('inventory_inspection_guard'),
 ('inventory_inspection_scrap_guard'),
 ('manufacturing_operation_inspection_guard'),
 ('inventory_inspection_rework_guard'),
 ('manufacturing_material_formula_guard'),
 ('stock_location_custody_guard'),
 ('production_subcontract_return_guard'),
 ('production_subcontract_guard'),
 ('production_subcontract_shipment_guard'),
 ('production_subcontract_service_guard'),
 ('production_service_bill_status_guard'),
 ('production_service_reversal_guard'),
 ('production_clone_evidence'),
 ('production_subcontract_material_return_guard'),
 ('production_work_center_cost_identity_guard'),
 ('manufacturing_loss_event_guard'),
 ('manufacturing_loss_order_guard'),
 ('manufacturing_loss_completion_guard'),
 ('manufacturing_loss_journal_guard'),
 ('manufacturing_receipt_rework_order_guard'),
 ('manufacturing_receipt_rework_link_guard'),
 ('manufacturing_receipt_rework_movement_guard'),
 ('manufacturing_inspected_output_guard'),
 ('manufacturing_snapshot_configuration_guard'),
 ('manufacturing_snapshot_addition_guard'),
 ('production_canonical_json'),
 ('production_clone_journal_evidence'),
 ('production_mask_evidence'),
 ('production_clone_safe_evidence'),
 ('production_bom_line_evidence'),
 ('production_bom_revision_guard'),
 ('production_bom_revision_complete_guard'),
 ('production_mrp_run_evidence_guard'),
 ('production_receipt_rework_loss_guard'),
 ('manufacturing_run_profile_guard')
),
wanted_columns(table_name,name) AS (VALUES
 ('projects', 'operating_profile_version_id'),
 ('projects', 'operating_department_id'),
 ('mfg_work_orders', 'operating_profile_version_id'),
 ('mfg_work_orders', 'operating_department_id'),
 ('mfg_routing_operations', 'labor_time_source'),
 ('mfg_wo_operations', 'labor_time_source'),
 ('mfg_wo_operations', 'labor_minutes_per_unit'),
 ('time_entries', 'production_consumed_operation_id'),
 ('time_entries', 'corrects_entry_id'),
 ('mfg_routings', 'activation_change_id'),
 ('mfg_work_orders', 'production_mode'),
 ('mfg_work_orders', 'campaign_reference'),
 ('mfg_wo_operations', 'inspection_plan_snapshot'),
 ('bom_components', 'quantity_basis'),
 ('bom_components', 'formula_output_quantity'),
 ('bom_components', 'output_cost_weight'),
 ('mfg_wo_materials', 'quantity_basis'),
 ('mfg_wo_materials', 'formula_output_quantity'),
 ('mfg_wo_byproducts', 'quantity_basis'),
 ('mfg_wo_byproducts', 'formula_output_quantity'),
 ('mfg_wo_byproducts', 'output_cost_weight'),
 ('mfg_wo_byproducts', 'standard_cost_snapshot'),
 ('stock_locations', 'custodian_party_id'),
 ('user_list_preferences', 'presentation'),
 ('user_list_preferences', 'view_selection_explicit'),
 ('mfg_work_orders', 'loss_change_id'),
 ('mfg_scrap_events', 'disposition_change_id'),
 ('mfg_work_orders', 'receipt_rework_inspection_id'),
 ('mfg_work_orders', 'receipt_rework_sequence'),
 ('inventory_inspections', 'rework_work_order_id')
),
wanted_constraints(table_name,name) AS (VALUES
 ('operating_profiles', 'operating_profile_current_version_fk'),
 ('projects', 'projects_operating_profile_version_fk'),
 ('projects', 'projects_operating_department_fk'),
 ('mfg_work_orders', 'mfg_operating_profile_version_fk'),
 ('mfg_work_orders', 'mfg_operating_department_fk'),
 ('time_entries', 'time_production_consumed_operation_fk'),
 ('time_entries', 'time_production_consumed_target_chk'),
 ('time_entries', 'time_corrects_entry_fk'),
 ('time_entries', 'time_correction_kind_chk'),
 ('mfg_routings', 'mfg_routing_activation_change_fk'),
 ('mfg_work_orders', 'mfg_production_mode'),
 ('mfg_work_orders', 'mfg_campaign_reference'),
 ('inventory_inspections', 'inspection_operation_sequence'),
 ('bom_components', 'bom_components_output_cost_weight'),
 ('bom_components', 'bom_components_quantity_basis'),
 ('mfg_wo_materials', 'mfg_wo_materials_quantity_basis'),
 ('mfg_wo_byproducts', 'mfg_wo_byproducts_output_cost_weight'),
 ('mfg_wo_byproducts', 'mfg_wo_byproducts_standard_snapshot'),
 ('mfg_wo_byproducts', 'mfg_wo_byproducts_quantity_basis'),
 ('stock_locations', 'stock_location_custodian_tenant'),
 ('stock_locations', 'stock_location_subcontract_custody'),
 ('user_list_preferences', 'user_list_preferences_presentation'),
 ('mfg_work_orders', 'mfg_work_order_loss_change_fk'),
 ('mfg_scrap_events', 'mfg_scrap_disposition_change_fk'),
 ('mfg_work_orders', 'mfg_receipt_rework_source_fk'),
 ('inventory_inspections', 'inspection_rework_work_fk'),
 ('mfg_work_orders', 'mfg_receipt_rework_pair')
),
wanted_triggers(table_name,name) AS (VALUES
 ('operating_profile_versions', 'operating_profile_version_immutable'),
 ('projects', 'project_operating_profile_guard'),
 ('mfg_work_orders', 'manufacturing_operating_profile_guard'),
 ('operating_profile_scopes', 'operating_profile_scope_guard'),
 ('time_entries', 'production_time_history_guard'),
 ('mfg_wo_operations', 'production_operation_time_snapshot_guard'),
 ('mfg_routings', 'manufacturing_routing_revision_guard'),
 ('mfg_routing_operations', 'manufacturing_routing_operation_guard'),
 ('mfg_work_orders', 'manufacturing_released_revision_guard'),
 ('mfg_completion_batches', 'manufacturing_completion_batch_guard'),
 ('mfg_completion_inputs', 'manufacturing_completion_input_guard'),
 ('inventory_inspection_plans', 'inventory_inspection_plan_guard'),
 ('inventory_inspections', 'inventory_inspection_guard'),
 ('inventory_inspections', 'inventory_inspection_scrap_guard'),
 ('mfg_wo_operations', 'manufacturing_operation_inspection_guard'),
 ('inventory_inspections', 'inventory_inspection_rework_guard'),
 ('mfg_wo_materials', 'manufacturing_material_formula_guard'),
 ('mfg_wo_byproducts', 'manufacturing_byproduct_formula_guard'),
 ('stock_locations', 'stock_location_custody_guard'),
 ('mfg_subcontract_returns', 'production_subcontract_return_guard'),
 ('mfg_subcontracts', 'production_subcontract_guard'),
 ('mfg_subcontract_shipments', 'production_subcontract_shipment_guard'),
 ('mfg_subcontract_service_bills', 'production_subcontract_service_guard'),
 ('documents', 'production_service_bill_status_guard'),
 ('journal_entries', 'production_service_reversal_guard'),
 ('mfg_subcontract_material_returns', 'production_subcontract_material_return_guard'),
 ('mfg_work_centers', 'production_work_center_cost_identity_guard'),
 ('mfg_scrap_events', 'manufacturing_loss_event_guard'),
 ('mfg_work_orders', 'manufacturing_loss_order_guard'),
 ('mfg_scrap_events', 'manufacturing_loss_completion_guard'),
 ('journal_entries', 'manufacturing_loss_journal_guard'),
 ('mfg_work_orders', 'manufacturing_receipt_rework_order_guard'),
 ('mfg_work_orders', 'manufacturing_receipt_rework_link_guard'),
 ('inventory_movements', 'manufacturing_receipt_rework_movement_guard'),
 ('inventory_movements', 'manufacturing_inspected_output_guard'),
 ('mfg_wo_operations', 'manufacturing_snapshot_configuration_guard'),
 ('mfg_wo_materials', 'manufacturing_snapshot_configuration_guard'),
 ('mfg_wo_byproducts', 'manufacturing_snapshot_configuration_guard'),
 ('mfg_wo_operations', 'manufacturing_snapshot_addition_guard'),
 ('mfg_wo_materials', 'manufacturing_snapshot_addition_guard'),
 ('mfg_wo_byproducts', 'manufacturing_snapshot_addition_guard'),
 ('bom_components', 'production_bom_revision_guard'),
 ('bom_components', 'production_bom_revision_complete_guard'),
 ('mfg_mrp_runs', 'production_mrp_run_evidence_guard'),
 ('mfg_work_orders', 'production_receipt_rework_loss_guard'),
 ('mfg_work_orders', 'manufacturing_run_profile_guard')
),
financial_guard AS (
 SELECT p.*, l.lanname
 FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 WHERE n.nspname='public' AND p.proname='financial_change_guard' AND p.pronargs=0
), labor_backfill AS (
 SELECT o.org_id,o.id,r.id AS routing_operation_id,r.labor_minutes_per_unit
 FROM public.mfg_wo_operations o
 JOIN public.mfg_work_orders w ON w.org_id=o.org_id AND w.id=o.work_order_id
 JOIN public.mfg_routing_operations r ON r.org_id=w.org_id AND r.routing_id=w.routing_id AND r.sequence=o.sequence
), problems(code,subject,detail,remedy) AS (
 SELECT '0619.financial_guard_unknown','public.financial_change_guard()',
        'The existing financial-change guard is missing or differs from the published approval and retirement contract.',
        'Preserve the live guard and financial history. Have the database owner qualify a forward migration against the published guard contract before upgrading; never replace an unknown guard.'
 WHERE NOT EXISTS (
  SELECT 1 FROM financial_guard p
  WHERE p.prorettype='pg_catalog.trigger'::pg_catalog.regtype AND p.lanname='plpgsql'
    AND NOT p.prosecdef AND p.provolatile='v' AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u'
    AND coalesce(cardinality(p.proconfig),0)=0
    -- Published 0458 body, or that same body with the published 0626 DELETE-only authority branch.
    AND encode(public.digest(p.prosrc,'sha256'),'hex') IN (
     'ccb63c80d1213a103a75a36dbe44601dcfbf5714bf16a30448c54a774df4e2a4',
     'd31367c8e253a2a2804ecf971c8726bab2ebbd38f916bff34255f6f8b305cdda')
 )
 UNION ALL
 SELECT '0619.financial_guard_trigger_unknown','public.financial_changes.financial_change_guard',
        'The native before-row INSERT/UPDATE/DELETE trigger is missing, disabled, filtered, or bound to another function.',
        'Preserve the schema. Have the database owner qualify the published financial-change trigger through a forward migration; never disable its approvals or history controls.'
 WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN financial_guard p ON p.oid=t.tgfoid
  WHERE n.nspname='public' AND c.relname='financial_changes' AND t.tgname='financial_change_guard'
    AND NOT t.tgisinternal AND t.tgtype=31 AND t.tgenabled IN ('O','A')
    AND t.tgnargs=0 AND t.tgqual IS NULL AND cardinality(t.tgattr::smallint[])=0
 )
 UNION ALL
 SELECT '0619.scrap_constraint_missing','public.mfg_scrap_events.mfg_scrap_snapshot_operation_chk',
        'The validated operation-scrap constraint to be widened is missing or is not a CHECK constraint.',
        'Preserve scrap history. Have the database owner qualify the published frozen-snapshot storage contract before upgrading.'
 WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_constraint k
  JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='mfg_scrap_events'
    AND k.conname='mfg_scrap_snapshot_operation_chk' AND k.contype='c' AND k.convalidated
 )
 UNION ALL
 SELECT '0619.operation_scrap_incoherent',format('organization %s scrap event %s',org_id,id),
        'Existing operation scrap does not satisfy the positive-value frozen snapshot retained by the new constraint.',
        'Preserve the event and its journal. Request a database-owner-reviewed forward remediation of the frozen snapshot; do not rewrite or delete posted scrap history.'
 FROM public.mfg_scrap_events
 WHERE (treatment<>'operation' OR (classification='abnormal' AND operation_id IS NOT NULL
        AND component_item_id IS NULL AND frozen_value>0 AND frozen_unit_cost IS NOT NULL AND frozen_unit_cost>=0
        AND plan_fingerprint IS NULL AND lot_id IS NULL AND serial_id IS NULL AND approval_required IS NOT NULL)) IS FALSE
 UNION ALL
 SELECT '0619.labor_snapshot_invalid',format('organization %s operation %s routing operation %s',org_id,id,routing_operation_id),
        'A labor standard selected for the operation snapshot is negative or non-finite.',
        'Preserve released operations and their costing evidence. Request a database-owner-reviewed forward remediation of the labor standard before upgrading; do not substitute zero.'
 FROM labor_backfill
 WHERE labor_minutes_per_unit<0 OR labor_minutes_per_unit::text IN ('NaN','Infinity','-Infinity')
 UNION ALL
 SELECT '0619.labor_snapshot_ambiguous',format('organization %s operation %s',org_id,id),
        format('%s routing sequences match the operation snapshot; the backfill would be nondeterministic.',count(*)),
        'Preserve all routing revisions and released work. Have the database owner qualify the published routing-sequence uniqueness contract before upgrading.'
 FROM labor_backfill GROUP BY org_id,id HAVING count(*)>1
 UNION ALL
 SELECT '0619.subcontract_custody_unresolved',format('organization %s stock location %s',org_id,id),
        'An existing subcontract location has no native custodian reference; the new custody constraint cannot infer its vendor or rewrite ownership.',
        'Preserve the location, stock valuation and movement history. Request a database-owner-reviewed forward custody migration with the actual vendor lineage before upgrading; do not guess a vendor or change owned stock to external ownership.'
 FROM public.stock_locations WHERE kind='subcontract'
 UNION ALL
 SELECT '0619.subcontract_consumption_duplicate',format('organization %s consumption key digest %s',org_id,md5(custom->>'subcontract_consumption_key')),
        format('%s unreversed manufacturing journals share a non-null consumption key and would violate the new unique index.',count(*)),
        'Preserve all journals. Request a database-owner-reviewed forward reconciliation of request identity with its actual manufacturing postings before upgrading; do not delete journals or clear replay keys.'
 FROM public.journal_entries
 WHERE origin='manufacturing' AND reverses_entry_id IS NULL AND custom ? 'subcontract_consumption_key'
   AND custom->>'subcontract_consumption_key' IS NOT NULL
 GROUP BY org_id,custom->>'subcontract_consumption_key' HAVING count(*)>1
 UNION ALL
 SELECT '0619.relation_already_present',format('public.%s',w.name),
        'A relation name required by this migration is already in use.',
        'Stop and preserve the existing object and tenant data. Have the database owner compare it with the migration ledger and approve a forward reconciliation; do not drop or recreate it to force the upgrade.'
 FROM wanted_relations w JOIN pg_catalog.pg_class c ON c.relname=w.name
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
 UNION ALL
 SELECT '0619.function_already_present',format('public.%s',w.name),
        'A function name required by this migration is already in use.',
        'Stop and preserve the function. Have the database owner compare its body, signature and authority with the published migration ledger and qualify a forward reconciliation.'
 FROM wanted_functions w JOIN pg_catalog.pg_proc p ON p.proname=w.name
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 UNION ALL
 SELECT '0619.column_already_present',format('public.%s.%s',w.table_name,w.name),
        'A column required by this migration is already present before its ledger entry.',
        'Stop and preserve the column and all tenant data. Have the database owner compare its definition and dependencies with the migration ledger and approve a forward reconciliation.'
 FROM wanted_columns w JOIN pg_catalog.pg_class c ON c.relname=w.table_name
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=w.name AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname='public'
 UNION ALL
 SELECT '0619.constraint_already_present',format('public.%s.%s',w.table_name,w.name),
        'A new constraint name is already present on its intended table.',
        'Stop and preserve the constraint and tenant data. Have the database owner compare the storage contract with the migration ledger and approve a forward reconciliation.'
 FROM wanted_constraints w JOIN pg_catalog.pg_class c ON c.relname=w.table_name
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid AND k.conname=w.name WHERE n.nspname='public'
 UNION ALL
 SELECT '0619.trigger_already_present',format('public.%s.%s',w.table_name,w.name),
        'A new trigger name is already present on its intended table.',
        'Stop and preserve the trigger. Have the database owner compare its function, authority and enabled state with the migration ledger and approve a forward reconciliation.'
 FROM wanted_triggers w JOIN pg_catalog.pg_class c ON c.relname=w.table_name
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid AND t.tgname=w.name WHERE n.nspname='public'
), ranked AS (
 SELECT *,row_number() OVER(PARTITION BY code ORDER BY subject,detail) AS position,
        count(*) OVER(PARTITION BY code) AS total FROM problems
)
SELECT code,'refuse' AS severity,subject,detail,remedy FROM ranked WHERE position<=50
UNION ALL
SELECT code,'refuse',format('%s findings',max(total)),
       'Only the first 50 subjects for this refusal are shown.',min(remedy)
FROM ranked GROUP BY code HAVING max(total)>50
ORDER BY code,subject;
