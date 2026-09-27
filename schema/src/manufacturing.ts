import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

export const mfgWorkCenters = pgTable(
  "mfg_work_centers",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    kind: text("kind", { enum: ["machine", "labor", "cell"] }).notNull(),
    capacityHoursPerDay: money("capacity_hours_per_day").notNull(),
    efficiencyPct: money("efficiency_pct").notNull(),
    departmentId: uuid("department_id"),
    absorbsOverhead: boolean("absorbs_overhead").notNull(),
    calendarId: uuid("calendar_id"),
    isActive: boolean("is_active").notNull().default(true),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_work_centers_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("mfg_work_centers_org_code_unique").on(t.orgId, t.code),
    index("mfg_work_centers_org_active").on(t.orgId, t.isActive, t.code),
    check("mfg_work_centers_kind_check", sql`${t.kind} in ('machine', 'labor', 'cell')`),
    check("mfg_work_centers_capacity_nonnegative", sql`${t.capacityHoursPerDay} >= 0`),
    check("mfg_work_centers_efficiency_pct", sql`${t.efficiencyPct} between 0 and 100`),
    check(
      "mfg_work_centers_department_required",
      sql`${t.kind} not in ('labor', 'cell') or ${t.departmentId} is not null`,
    ),
    check(
      "mfg_work_centers_labels_nonempty",
      sql`length(btrim(${t.code})) > 0 and length(btrim(${t.name})) > 0`,
    ),
  ],
);

export const mfgWorkCenterRates = pgTable(
  "mfg_work_center_rates",
  {
    id: id(),
    orgId: orgRef(),
    workCenterId: uuid("work_center_id").notNull(),
    machineRatePerHour: money("machine_rate_per_hour").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_work_center_rates_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      name: "mfg_work_center_rates_center_fk",
      columns: [t.orgId, t.workCenterId],
      foreignColumns: [mfgWorkCenters.orgId, mfgWorkCenters.id],
    }),
    index("mfg_work_center_rates_org_center_from").on(t.orgId, t.workCenterId, t.effectiveFrom),
    check("mfg_work_center_rates_nonnegative", sql`${t.machineRatePerHour} >= 0`),
    check(
      "mfg_work_center_rates_valid_range",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  ],
);

export const mfgRoutings = pgTable(
  "mfg_routings",
  {
    id: id(),
    orgId: orgRef(),
    producedItemId: uuid("produced_item_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    status: text("status", { enum: ["draft", "active", "archived"] }).notNull().default("draft"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    defaultIssueLocationId: uuid("default_issue_location_id"),
    defaultReceiptLocationId: uuid("default_receipt_location_id"),
    overheadBasis: text("overhead_basis", { enum: ["labor_hours", "machine_hours", "units"] }).notNull(),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_routings_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("mfg_routings_org_item_version_unique").on(t.orgId, t.producedItemId, t.version),
    index("mfg_routings_org_status_item").on(t.orgId, t.status, t.producedItemId),
    check("mfg_routings_version_positive", sql`${t.version} > 0`),
    check("mfg_routings_status_check", sql`${t.status} in ('draft', 'active', 'archived')`),
    check(
      "mfg_routings_overhead_basis_check",
      sql`${t.overheadBasis} in ('labor_hours', 'machine_hours', 'units')`,
    ),
    check("mfg_routings_valid_range", sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`),
    check("mfg_routings_labels_nonempty", sql`length(btrim(${t.code})) > 0 and length(btrim(${t.name})) > 0`),
  ],
);

export const mfgRoutingOperations = pgTable(
  "mfg_routing_operations",
  {
    id: id(),
    orgId: orgRef(),
    routingId: uuid("routing_id").notNull(),
    sequence: integer("sequence").notNull(),
    name: text("name").notNull(),
    workCenterId: uuid("work_center_id").notNull(),
    setupMinutes: money("setup_minutes").notNull(),
    runMinutesPerUnit: money("run_minutes_per_unit").notNull(),
    laborMinutesPerUnit: money("labor_minutes_per_unit"),
    backflushAt: text("backflush_at", { enum: ["none", "start", "finish"] }).notNull().default("none"),
    qualityGate: text("quality_gate", { enum: ["none", "measure"] }).notNull().default("none"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_routing_operations_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("mfg_routing_operations_routing_sequence_unique").on(t.orgId, t.routingId, t.sequence),
    foreignKey({
      name: "mfg_routing_operations_routing_fk",
      columns: [t.orgId, t.routingId],
      foreignColumns: [mfgRoutings.orgId, mfgRoutings.id],
    }),
    foreignKey({
      name: "mfg_routing_operations_center_fk",
      columns: [t.orgId, t.workCenterId],
      foreignColumns: [mfgWorkCenters.orgId, mfgWorkCenters.id],
    }),
    index("mfg_routing_operations_org_center").on(t.orgId, t.workCenterId, t.routingId),
    check("mfg_routing_operations_sequence_positive", sql`${t.sequence} > 0`),
    check(
      "mfg_routing_operations_minutes_nonnegative",
      sql`${t.setupMinutes} >= 0 and ${t.runMinutesPerUnit} >= 0
          and (${t.laborMinutesPerUnit} is null or ${t.laborMinutesPerUnit} >= 0)`,
    ),
    check(
      "mfg_routing_operations_consumes_time",
      sql`${t.setupMinutes} <> 0 or ${t.runMinutesPerUnit} <> 0`,
    ),
    check("mfg_routing_operations_backflush_check", sql`${t.backflushAt} in ('none', 'start', 'finish')`),
    check("mfg_routing_operations_quality_gate_check", sql`${t.qualityGate} in ('none', 'measure')`),
    check("mfg_routing_operations_name_nonempty", sql`length(btrim(${t.name})) > 0`),
  ],
);

export const mfgScrapReasons = pgTable(
  "mfg_scrap_reasons",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    classification: text("classification", { enum: ["normal", "abnormal"] }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_scrap_reasons_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("mfg_scrap_reasons_org_code_unique").on(t.orgId, t.code),
    index("mfg_scrap_reasons_org_active").on(t.orgId, t.isActive, t.code),
    check("mfg_scrap_reasons_classification_check", sql`${t.classification} in ('normal', 'abnormal')`),
    check("mfg_scrap_reasons_labels_nonempty", sql`length(btrim(${t.code})) > 0 and length(btrim(${t.name})) > 0`),
  ],
);

export const mfgWorkOrders = pgTable(
  "mfg_work_orders",
  {
    id: id(),
    orgId: orgRef(),
    number: text("number").notNull(),
    producedItemId: uuid("produced_item_id").notNull(),
    routingId: uuid("routing_id"),
    bomRevision: text("bom_revision"),
    routingVersion: integer("routing_version"),
    quantityOrdered: money("quantity_ordered").notNull(),
    quantityCompleted: money("quantity_completed").notNull().default("0"),
    quantityScrapped: money("quantity_scrapped").notNull().default("0"),
    unit: text("unit").notNull(),
    status: text("status", { enum: ["draft", "released", "in_progress", "on_hold", "done", "closed", "cancelled"] }).notNull().default("draft"),
    priority: text("priority", { enum: ["low", "normal", "high", "rush"] }).notNull().default("normal"),
    source: text("source", { enum: ["manual", "mrp", "sales_order", "parent"] }).notNull().default("manual"),
    sourceRefId: uuid("source_ref_id"),
    parentWoId: uuid("parent_wo_id"),
    shortCloseReason: text("short_close_reason"),
    subsidiaryId: uuid("subsidiary_id"),
    issueLocationId: uuid("issue_location_id"),
    receiptLocationId: uuid("receipt_location_id"),
    plannedStart: date("planned_start"),
    plannedEnd: date("planned_end"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    holdReason: text("hold_reason"),
    cancelReason: text("cancel_reason"),
    standardCostSnapshot: money("standard_cost_snapshot"),
    costCollected: money("cost_collected").notNull().default("0"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_work_orders_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("mfg_work_orders_org_number_unique").on(t.orgId, t.number),
    foreignKey({
      name: "mfg_work_orders_routing_fk",
      columns: [t.orgId, t.routingId],
      foreignColumns: [mfgRoutings.orgId, mfgRoutings.id],
    }),
    foreignKey({
      name: "mfg_work_orders_parent_fk",
      columns: [t.orgId, t.parentWoId],
      foreignColumns: [t.orgId, t.id],
    }),
    index("mfg_work_orders_org_status_start").on(t.orgId, t.status, t.plannedStart),
    check("mfg_work_orders_source_check", sql`${t.source} in ('manual', 'mrp', 'sales_order', 'parent')`),
    check("mfg_work_orders_priority_check", sql`${t.priority} in ('low', 'normal', 'high', 'rush')`),
    check(
      "mfg_work_orders_status_check",
      sql`${t.status} in ('draft', 'released', 'in_progress', 'on_hold', 'done', 'closed', 'cancelled')`,
    ),
    check(
      "mfg_work_orders_source_reference",
      sql`(${t.source} = 'manual' and ${t.sourceRefId} is null)
          or (${t.source} <> 'manual' and ${t.sourceRefId} is not null)`,
    ),
    check(
      "mfg_work_orders_parent_reference",
      sql`(${t.source} = 'parent' and ${t.parentWoId} is not null)
          or (${t.source} <> 'parent' and ${t.parentWoId} is null)`,
    ),
    check(
      "mfg_work_orders_quantities_nonnegative",
      sql`${t.quantityOrdered} >= 0 and ${t.quantityCompleted} >= 0 and ${t.quantityScrapped} >= 0`,
    ),
    check(
      "mfg_work_orders_costs_nonnegative",
      sql`${t.costCollected} >= 0 and (${t.standardCostSnapshot} is null or ${t.standardCostSnapshot} >= 0)`,
    ),
    check("mfg_work_orders_routing_version_positive", sql`${t.routingVersion} is null or ${t.routingVersion} > 0`),
    check(
      "mfg_work_orders_hold_reason",
      sql`${t.status} <> 'on_hold' or (${t.holdReason} is not null and length(btrim(${t.holdReason})) > 0)`,
    ),
    check(
      "mfg_work_orders_short_close_reason",
      sql`${t.status} <> 'closed' or ${t.quantityCompleted} >= ${t.quantityOrdered}
          or (${t.shortCloseReason} is not null and length(btrim(${t.shortCloseReason})) > 0)`,
    ),
    check("mfg_work_orders_dates_ordered", sql`${t.plannedEnd} is null or ${t.plannedStart} is null or ${t.plannedEnd} >= ${t.plannedStart}`),
    check("mfg_work_orders_labels_nonempty", sql`length(btrim(${t.number})) > 0 and length(btrim(${t.unit})) > 0`),
  ],
);

export const mfgWoOperations = pgTable(
  "mfg_wo_operations",
  {
    id: id(),
    orgId: orgRef(),
    workOrderId: uuid("work_order_id").notNull(),
    sequence: integer("sequence").notNull(),
    name: text("name").notNull(),
    workCenterId: uuid("work_center_id").notNull(),
    plannedSetupMinutes: money("planned_setup_minutes").notNull(),
    plannedRunMinutes: money("planned_run_minutes").notNull(),
    actualSetupMinutes: money("actual_setup_minutes"),
    actualRunMinutes: money("actual_run_minutes"),
    actualLaborMinutes: money("actual_labor_minutes"),
    quantityPlanned: money("quantity_planned").notNull(),
    quantityDone: money("quantity_done").notNull().default("0"),
    quantityScrappedHere: money("quantity_scrapped_here").notNull().default("0"),
    status: text("status", { enum: ["pending", "running", "paused", "done"] }).notNull().default("pending"),
    operatorUserId: uuid("operator_user_id"),
    pauseReason: text("pause_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    measuredQty: money("measured_qty"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_wo_operations_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("mfg_wo_operations_org_order_id_unique").on(t.orgId, t.workOrderId, t.id),
    uniqueIndex("mfg_wo_operations_order_sequence_unique").on(t.orgId, t.workOrderId, t.sequence),
    foreignKey({
      name: "mfg_wo_operations_work_order_fk",
      columns: [t.orgId, t.workOrderId],
      foreignColumns: [mfgWorkOrders.orgId, mfgWorkOrders.id],
    }),
    foreignKey({
      name: "mfg_wo_operations_center_fk",
      columns: [t.orgId, t.workCenterId],
      foreignColumns: [mfgWorkCenters.orgId, mfgWorkCenters.id],
    }),
    index("mfg_wo_operations_org_center").on(t.orgId, t.workCenterId, t.workOrderId),
    check("mfg_wo_operations_status_check", sql`${t.status} in ('pending', 'running', 'paused', 'done')`),
    check("mfg_wo_operations_sequence_positive", sql`${t.sequence} > 0`),
    check(
      "mfg_wo_operations_minutes_nonnegative",
      sql`${t.plannedSetupMinutes} >= 0 and ${t.plannedRunMinutes} >= 0
          and (${t.actualSetupMinutes} is null or ${t.actualSetupMinutes} >= 0)
          and (${t.actualRunMinutes} is null or ${t.actualRunMinutes} >= 0)
          and (${t.actualLaborMinutes} is null or ${t.actualLaborMinutes} >= 0)`,
    ),
    check(
      "mfg_wo_operations_quantities_nonnegative",
      sql`${t.quantityPlanned} >= 0 and ${t.quantityDone} >= 0 and ${t.quantityScrappedHere} >= 0
          and (${t.measuredQty} is null or ${t.measuredQty} >= 0)`,
    ),
    check(
      "mfg_wo_operations_pause_reason",
      sql`${t.status} <> 'paused' or (${t.pauseReason} is not null and length(btrim(${t.pauseReason})) > 0)`,
    ),
    check("mfg_wo_operations_name_nonempty", sql`length(btrim(${t.name})) > 0`),
  ],
);

export const mfgWoMaterials = pgTable(
  "mfg_wo_materials",
  {
    id: id(),
    orgId: orgRef(),
    workOrderId: uuid("work_order_id").notNull(),
    componentItemId: uuid("component_item_id").notNull(),
    requiredQty: money("required_qty").notNull(),
    issuedQty: money("issued_qty").notNull().default("0"),
    backflushQty: money("backflush_qty").notNull().default("0"),
    operationSeq: integer("operation_seq"),
    lotSerialPolicy: text("lot_serial_policy", { enum: ["none", "lot", "serial"] }).notNull(),
    shortageQty: money("shortage_qty").notNull().default("0"),
    waivedAt: timestamp("waived_at", { withTimezone: true }),
    waivedBy: uuid("waived_by"),
    waiveReason: text("waive_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_wo_materials_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      name: "mfg_wo_materials_work_order_fk",
      columns: [t.orgId, t.workOrderId],
      foreignColumns: [mfgWorkOrders.orgId, mfgWorkOrders.id],
    }),
    index("mfg_wo_materials_org_order").on(t.orgId, t.workOrderId, t.componentItemId),
    check(
      "mfg_wo_materials_quantities_nonnegative",
      sql`${t.requiredQty} >= 0 and ${t.issuedQty} >= 0 and ${t.backflushQty} >= 0 and ${t.shortageQty} >= 0`,
    ),
    check("mfg_wo_materials_operation_sequence", sql`${t.operationSeq} is null or ${t.operationSeq} > 0`),
    check("mfg_wo_materials_tracking_check", sql`${t.lotSerialPolicy} in ('none', 'lot', 'serial')`),
    check(
      "mfg_wo_materials_waiver_evidence",
      sql`(${t.waivedAt} is null and ${t.waivedBy} is null and ${t.waiveReason} is null)
          or (${t.waivedAt} is not null and ${t.waivedBy} is not null
              and ${t.waiveReason} is not null and length(btrim(${t.waiveReason})) > 0)`,
    ),
  ],
);

export const mfgScrapEvents = pgTable(
  "mfg_scrap_events",
  {
    id: id(),
    orgId: orgRef(),
    workOrderId: uuid("work_order_id").notNull(),
    operationId: uuid("operation_id"),
    componentItemId: uuid("component_item_id"),
    quantity: money("quantity").notNull(),
    reasonId: uuid("reason_id").notNull(),
    classification: text("classification", { enum: ["normal", "abnormal"] }).notNull(),
    postedEntryId: uuid("posted_entry_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_scrap_events_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      name: "mfg_scrap_events_work_order_fk",
      columns: [t.orgId, t.workOrderId],
      foreignColumns: [mfgWorkOrders.orgId, mfgWorkOrders.id],
    }),
    foreignKey({
      name: "mfg_scrap_events_operation_fk",
      columns: [t.orgId, t.workOrderId, t.operationId],
      foreignColumns: [mfgWoOperations.orgId, mfgWoOperations.workOrderId, mfgWoOperations.id],
    }),
    foreignKey({
      name: "mfg_scrap_events_reason_fk",
      columns: [t.orgId, t.reasonId],
      foreignColumns: [mfgScrapReasons.orgId, mfgScrapReasons.id],
    }),
    index("mfg_scrap_events_org_order").on(t.orgId, t.workOrderId, t.createdAt),
    check("mfg_scrap_events_quantity_nonnegative", sql`${t.quantity} >= 0`),
    check("mfg_scrap_events_classification_check", sql`${t.classification} in ('normal', 'abnormal')`),
  ],
);

export const mfgItemPolicies = pgTable(
  "mfg_item_policies",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    supplyMethod: text("supply_method", { enum: ["make", "buy", "transfer"] }).notNull(),
    leadTimeDays: integer("lead_time_days"),
    safetyStockQty: money("safety_stock_qty").notNull(),
    minimumQty: money("minimum_qty").notNull(),
    orderMultipleQty: money("order_multiple_qty").notNull(),
    scrapPctPlanned: money("scrap_pct_planned").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_item_policies_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("mfg_item_policies_org_item_unique").on(t.orgId, t.itemId),
    index("mfg_item_policies_org_supply_method").on(t.orgId, t.supplyMethod, t.itemId),
    check("mfg_item_policies_supply_method_check", sql`${t.supplyMethod} in ('make', 'buy', 'transfer')`),
    check("mfg_item_policies_lead_time_nonnegative", sql`${t.leadTimeDays} is null or ${t.leadTimeDays} >= 0`),
    check(
      "mfg_item_policies_quantities_nonnegative",
      sql`${t.safetyStockQty} >= 0 and ${t.minimumQty} >= 0 and ${t.orderMultipleQty} >= 0`,
    ),
    check("mfg_item_policies_scrap_pct", sql`${t.scrapPctPlanned} >= 0 and ${t.scrapPctPlanned} < 100`),
  ],
);

export const mfgMrpRuns = pgTable(
  "mfg_mrp_runs",
  {
    id: id(),
    orgId: orgRef(),
    number: text("number").notNull(),
    horizonStart: date("horizon_start").notNull(),
    horizonEnd: date("horizon_end").notNull(),
    parameters: jsonb("parameters").notNull(),
    status: text("status", { enum: ["draft", "complete", "superseded"] }).notNull().default("draft"),
    runBy: uuid("run_by").notNull(),
    ranAt: timestamp("ran_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_mrp_runs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("mfg_mrp_runs_org_number_unique").on(t.orgId, t.number),
    index("mfg_mrp_runs_org_status_horizon").on(t.orgId, t.status, t.horizonStart, t.horizonEnd),
    check("mfg_mrp_runs_status_check", sql`${t.status} in ('draft', 'complete', 'superseded')`),
    check("mfg_mrp_runs_horizon_valid", sql`${t.horizonEnd} > ${t.horizonStart}`),
    check("mfg_mrp_runs_parameters_object", sql`jsonb_typeof(${t.parameters}) = 'object'`),
    check("mfg_mrp_runs_number_nonempty", sql`length(btrim(${t.number})) > 0`),
  ],
);

export const mfgPlannedOrders = pgTable(
  "mfg_planned_orders",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    itemId: uuid("item_id").notNull(),
    quantity: money("quantity").notNull(),
    dueDate: date("due_date").notNull(),
    action: text("action", { enum: ["make", "buy", "transfer"] }).notNull(),
    demandRef: jsonb("demand_ref").notNull(),
    status: text("status", { enum: ["suggested", "confirmed", "converted", "dismissed"] }).notNull().default("suggested"),
    convertedRefId: uuid("converted_ref_id"),
    isExpedite: boolean("is_expedite").notNull().default(false),
    plannedStart: date("planned_start"),
    dismissReason: text("dismiss_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_planned_orders_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      name: "mfg_planned_orders_run_fk",
      columns: [t.orgId, t.runId],
      foreignColumns: [mfgMrpRuns.orgId, mfgMrpRuns.id],
    }),
    index("mfg_planned_orders_org_run_status").on(t.orgId, t.runId, t.status, t.dueDate),
    check("mfg_planned_orders_action_check", sql`${t.action} in ('make', 'buy', 'transfer')`),
    check("mfg_planned_orders_status_check", sql`${t.status} in ('suggested', 'confirmed', 'converted', 'dismissed')`),
    check("mfg_planned_orders_quantity_nonnegative", sql`${t.quantity} >= 0`),
    check("mfg_planned_orders_demand_ref_object", sql`jsonb_typeof(${t.demandRef}) = 'object'`),
    check(
      "mfg_planned_orders_conversion_reference",
      sql`(${t.status} = 'converted' and ${t.convertedRefId} is not null)
          or (${t.status} <> 'converted' and ${t.convertedRefId} is null)`,
    ),
    check(
      "mfg_planned_orders_dismiss_reason",
      sql`(${t.status} = 'dismissed' and ${t.dismissReason} is not null and length(btrim(${t.dismissReason})) > 0)
          or (${t.status} <> 'dismissed' and ${t.dismissReason} is null)`,
    ),
  ],
);

export const mfgCapacityWeeks = pgTable(
  "mfg_capacity_weeks",
  {
    id: id(),
    orgId: orgRef(),
    workCenterId: uuid("work_center_id").notNull(),
    weekStart: date("week_start").notNull(),
    plannedHours: money("planned_hours").notNull(),
    availableHours: money("available_hours").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("mfg_capacity_weeks_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("mfg_capacity_weeks_org_center_week_unique").on(t.orgId, t.workCenterId, t.weekStart),
    foreignKey({
      name: "mfg_capacity_weeks_center_fk",
      columns: [t.orgId, t.workCenterId],
      foreignColumns: [mfgWorkCenters.orgId, mfgWorkCenters.id],
    }),
    index("mfg_capacity_weeks_org_week_center").on(t.orgId, t.weekStart, t.workCenterId),
    check("mfg_capacity_weeks_hours_nonnegative", sql`${t.plannedHours} >= 0 and ${t.availableHours} >= 0`),
  ],
);
