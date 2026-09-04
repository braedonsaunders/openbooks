import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/** Reusable, tenant-owned item rate books. Equipment is the first rich
 * consumer, but labor and other T&M items use the same pricing system. */
export const itemRateBooks = pgTable(
  "item_rate_books",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    currency: currencyCode("currency").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("item_rate_books_org_code").on(t.orgId, t.code)],
);

/** Effective-dated labor-card behavior. Numeric item prices stay in the shared
 * rate engine; this row only selects how missing time-type prices derive. */
export const laborRateVersionPolicies = pgTable(
  "labor_rate_version_policies",
  {
    id: id(),
    orgId: orgRef(),
    versionId: uuid("version_id").notNull(),
    derivationPolicy: text("derivation_policy", {
      enum: ["explicit", "time_type_multipliers"],
    })
      .notNull()
      .default("explicit"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("labor_rate_version_policies_version").on(t.versionId)],
);

/** Dimension restrictions are rows, not one-off columns: a labor card may be
 * scoped by any standard dimension today and extended without reshaping the
 * rate-book header. Text values cover operational scopes such as job title or
 * trade; UUID values cover persisted dimensions. */
export const laborRateVersionScopes = pgTable(
  "labor_rate_version_scopes",
  {
    id: id(),
    orgId: orgRef(),
    versionId: uuid("version_id").notNull(),
    scopeType: text("scope_type", {
      enum: [
        "department",
        "subsidiary",
        "location",
        "class",
        "trade",
        "job_title",
        "other",
      ],
    }).notNull(),
    scopeValueId: uuid("scope_value_id"),
    scopeValueText: text("scope_value_text"),
    includeChildren: boolean("include_children").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("labor_rate_version_scopes_version").on(t.versionId),
    check(
      "labor_rate_version_scopes_one_value",
      sql`num_nonnulls(${t.scopeValueId}, ${t.scopeValueText}) = 1`,
    ),
  ],
);

/** General commercial adjustments on a labor card. A fuel surcharge imports
 * as category=surcharge + calculation=percent; per-diem, travel, minimums,
 * allowances, and future negotiated rules use the same model. */
export const laborRateAdjustments = pgTable(
  "labor_rate_adjustments",
  {
    id: id(),
    orgId: orgRef(),
    versionId: uuid("version_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    category: text("category", {
      enum: ["markup", "travel", "allowance", "minimum", "surcharge", "other"],
    }).notNull(),
    calculation: text("calculation", {
      enum: [
        "percent",
        "fixed",
        "per_hour",
        "per_day",
        "distance",
        "time",
        "text",
      ],
    }).notNull(),
    /** Unit follows `calculation`: a percent value is a PERCENTAGE (3.75 means
     * 3.75%), never a fraction; fixed/per_hour/per_day are money. */
    value: numeric("value", { precision: 19, scale: 10 }),
    unit: text("unit"),
    presentation: text("presentation", {
      enum: ["included", "separate", "informational"],
    })
      .notNull()
      .default("included"),
    threshold: numeric("threshold", { precision: 19, scale: 4 }),
    thresholdUnit: text("threshold_unit"),
    referenceText: text("reference_text"),
    /** Item that carries the charge when presentation = 'separate'. A surcharge
     * bills as a real invoice line, so it needs a real item for its revenue
     * account and tax treatment; 'included' adjustments never need one. */
    itemId: uuid("item_id"),
    appliesRegular: boolean("applies_regular").notNull().default(true),
    appliesOvertime: boolean("applies_overtime").notNull().default(true),
    appliesDoubleTime: boolean("applies_double_time").notNull().default(true),
    appliesShift: boolean("applies_shift").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    unique("labor_rate_adjustments_version_code").on(t.versionId, t.code),
    index("labor_rate_adjustments_version").on(t.versionId, t.sortOrder),
    check(
      "labor_rate_adjustments_nonnegative_value",
      sql`${t.value} is null or ${t.value} >= 0`,
    ),
    check(
      "labor_rate_adjustments_nonnegative_threshold",
      sql`${t.threshold} is null or ${t.threshold} >= 0`,
    ),
  ],
);

/** Reusable applicability predicates for a commercial adjustment. No rows
 * means the whole card. Multiple rows are inclusive alternatives, allowing a
 * markup or surcharge to target materials, transaction types, named items,
 * or any standard accounting dimension without adding one-off columns. */
export const laborRateAdjustmentTargets = pgTable(
  "labor_rate_adjustment_targets",
  {
    id: id(), orgId: orgRef(), adjustmentId: uuid("adjustment_id").notNull(),
    /** `labor` and `material` describe where the charge CAME FROM — billable time
     * versus a cost document — which is stable across tenants no matter how each
     * one classifies its items. The rest match the line's own attributes. */
    targetType: text("target_type", { enum: ["labor", "material", "item", "item_kind", "item_category", "transaction_type", "department", "subsidiary", "location", "class", "trade", "job_title", "project", "customer", "other"] }).notNull(),
    targetValueId: uuid("target_value_id"), targetValueText: text("target_value_text"),
    includeChildren: boolean("include_children").notNull().default(false), ...auditColumns,
  },
  (t) => [
    index("labor_rate_adjustment_targets_adjustment").on(t.adjustmentId),
    unique("labor_rate_adjustment_targets_unique").on(t.adjustmentId, t.targetType, t.targetValueId, t.targetValueText).nullsNotDistinct(),
    check("labor_rate_adjustment_targets_one_value", sql`num_nonnulls(${t.targetValueId}, ${t.targetValueText}) = 1`),
  ],
);

/** Ordered contract language and display notes. This retains negotiated terms
 * exactly without turning each source phrase into a permanent schema field. */
export const laborRateTerms = pgTable(
  "labor_rate_terms",
  {
    id: id(),
    orgId: orgRef(),
    versionId: uuid("version_id").notNull(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    content: text("content").notNull(),
    placement: text("placement", { enum: ["header", "conditions", "footer"] })
      .notNull()
      .default("conditions"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("labor_rate_terms_version_code").on(t.versionId, t.code),
    index("labor_rate_terms_version").on(t.versionId, t.sortOrder),
  ],
);

/** Effective-dated price configuration. Posted/approved charges retain the
 * exact snapshotted rate evidence; configuration edits are audited in place
 * and therefore never rewrite transaction history. */
export const itemRateVersions = pgTable(
  "item_rate_versions",
  {
    id: id(),
    orgId: orgRef(),
    rateBookId: uuid("rate_book_id").notNull(),
    /** Inclusive validity window. Active versions may not overlap within one
     *  rate book (storage constraint 0051). */
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    status: text("status", { enum: ["draft", "active", "retired"] })
      .notNull()
      .default("draft"),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("item_rate_versions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("item_rate_versions_book_from").on(
      t.rateBookId,
      t.effectiveFrom,
    ),
    index("item_rate_versions_effective").on(
      t.orgId,
      t.effectiveFrom,
      t.effectiveTo,
    ),
    check(
      "item_rate_versions_valid_range",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** Item-level behavior shared by every rate book. A tier's base_quantity is
 * expressed in this base unit (for example day=1, week=4, month=12). */
export const itemRateProfiles = pgTable(
  "item_rate_profiles",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    baseUnit: text("base_unit").notNull(),
    pricingPolicy: text("pricing_policy", {
      enum: ["explicit", "capped_ladder", "lowest_cost"],
    })
      .notNull()
      .default("capped_ladder"),
    invoicePresentation: text("invoice_presentation", {
      enum: ["summary", "rate_components"],
    })
      .notNull()
      .default("rate_components"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("item_rate_profiles_item").on(t.orgId, t.itemId)],
);

/** N addable rate units per item/version. Cost and bill prices are independent:
 * zero internal cost with a positive customer price is valid. */
export const itemRateLines = pgTable(
  "item_rate_lines",
  {
    id: id(),
    orgId: orgRef(),
    versionId: uuid("version_id").notNull(),
    itemId: uuid("item_id").notNull(),
    unitCode: text("unit_code").notNull(),
    unitName: text("unit_name").notNull(),
    baseQuantity: money("base_quantity").notNull(),
    costRate: money("cost_rate"),
    billRate: money("bill_rate"),
    /** Explicit bill rates by time-type id (reg/OT/DT card): overrides
     * billRate × timeType.billMultiplier for that tier. */
    timeTypeBillRates: jsonb("time_type_bill_rates")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    sortOrder: integer("sort_order").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("item_rate_lines_version_item_unit").on(
      t.versionId,
      t.itemId,
      t.unitCode,
    ),
    index("item_rate_lines_item").on(t.orgId, t.itemId),
    check("item_rate_lines_positive_quantity", sql`${t.baseQuantity} > 0`),
    check(
      "item_rate_lines_nonnegative_cost",
      sql`${t.costRate} is null or ${t.costRate} >= 0`,
    ),
    check(
      "item_rate_lines_nonnegative_bill",
      sql`${t.billRate} is null or ${t.billRate} >= 0`,
    ),
  ],
);

/** Customer/project rate-book selection. All scope keys null means organization
 *  scope. Dimension scopes (department/subsidiary/location/class) let the same
 *  customer carry different rate books per dimension over identical date ranges;
 *  the no-overlap guard (0065) keys on the full scope tuple so those coexist. */
export const itemRateBookAssignments = pgTable(
  "item_rate_book_assignments",
  {
    id: id(),
    orgId: orgRef(),
    rateBookId: uuid("rate_book_id").notNull(),
    /** Optional exact version pin for negotiated/job-awarded pricing. */
    rateVersionId: uuid("rate_version_id"),
    customerId: uuid("customer_id"),
    projectId: uuid("project_id"),
    departmentId: uuid("department_id"),
    subsidiaryId: uuid("subsidiary_id"),
    locationId: uuid("location_id"),
    classId: uuid("class_id"),
    /** Inclusive validity window. Active assignments may not overlap within
     *  one full scope identity (storage constraint 0051). */
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    /** Usage date is the normal price-list behavior. Project-start locks a
     * negotiated customer schedule according to when the job began. */
    dateBasis: text("date_basis", { enum: ["usage_date", "project_start"] })
      .notNull()
      .default("usage_date"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("item_rate_assignments_customer").on(t.orgId, t.customerId),
    index("item_rate_assignments_project").on(t.orgId, t.projectId),
    index("item_rate_assignments_dimensions").on(t.orgId, t.subsidiaryId, t.departmentId, t.locationId, t.classId),
    check(
      "item_rate_assignment_one_primary_scope",
      sql`not (${t.customerId} is not null and ${t.projectId} is not null)`,
    ),
    check(
      "item_rate_assignment_valid_range",
      sql`${t.effectiveTo} is null or ${t.effectiveFrom} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** Auditable decomposition of a snapshotted project-charge line. */
export const chargeRateComponents = pgTable(
  "charge_rate_components",
  {
    id: id(),
    orgId: orgRef(),
    documentLineId: uuid("document_line_id").notNull(),
    role: text("role", { enum: ["cost", "bill"] }).notNull(),
    rateLineId: uuid("rate_line_id"),
    unitCode: text("unit_code").notNull(),
    unitName: text("unit_name").notNull(),
    quantity: numeric("quantity", { precision: 28, scale: 8 }).notNull(),
    quantityRatio: jsonb("quantity_ratio").$type<{ numerator: string; denominator: string }>(),
    rate: money("rate").notNull(),
    amount: money("amount").notNull(),
    sequence: integer("sequence").notNull(),
    ...auditColumns,
  },
  (t) => [
    index("charge_rate_components_line").on(
      t.documentLineId,
      t.role,
      t.sequence,
    ),
    check("charge_rate_components_positive_quantity", sql`${t.quantity} > 0`),
    check("charge_rate_fraction_shape", sql`${t.quantityRatio} is null or coalesce((
      jsonb_typeof(${t.quantityRatio}) = 'object'
      and jsonb_typeof(${t.quantityRatio}->'numerator') = 'string'
      and jsonb_typeof(${t.quantityRatio}->'denominator') = 'string'
      and ${t.quantityRatio}->>'numerator' ~ '^[1-9][0-9]*$'
      and ${t.quantityRatio}->>'denominator' ~ '^[1-9][0-9]*$'
      and ${t.quantityRatio} ? 'numerator' and ${t.quantityRatio} ? 'denominator'
    ), false)`),
    check("charge_rate_components_nonnegative_rate", sql`${t.rate} >= 0`),
    check("charge_rate_components_nonnegative_amount", sql`${t.amount} >= 0`),
  ],
);
