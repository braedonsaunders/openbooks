import type { SetupEntity } from "./types";

/**
 * Leave types and their time-entitlement policies share the setup registry
 * and CRUD API. Policies are managed inside their owning leave type.
 *
 * What these screens are, and are NOT:
 *
 * They are NOT the payroll banks. Leave types name time off (vacation,
 * sick, unpaid) and policies declare the entitlement in TIME (accrual and
 * carryover in hours); the payroll entitlement bank in VALUE is computed by
 * the pay run and read through the entitlement functions, never configured
 * here. The two are never conflated in code or copy — see the in-app docs
 * article "leave-time-versus-value".
 *
 * Policies never edit raw JSON (a json-kind field on a workforce entity is
 * barred by registry.test.ts). The drawer edits scope, accrual, and
 * carryover through typed slot controls backed by 0194 STORED GENERATED
 * columns (readable for prefill, never written), plus targeting pickers
 * and the service-tier table that prefill straight off the stored jsonb;
 * normalizeHrmLeavePolicyInput
 * folds the slots back into applies_to, accrual_rule, and carryover_rule
 * before buildRow, write.ts persists the folded objects explicitly, and
 * leavePolicyRuleProblem refuses malformed shapes with the engine's own
 * words before the write. The stored jsonb stays the source of truth, and a
 * rule that still arrives malformed fails closed at read time (the balance
 * read throws instead of accruing zero), never as a silent nil.
 */

const VALUE_CROSSINGS = [
  { value: "none", labelKey: "options.leaveValueCrossing.none" },
  { value: "payout", labelKey: "options.leaveValueCrossing.payout" },
  { value: "bank_in", labelKey: "options.leaveValueCrossing.bankIn" },
];

export const LEAVE_TYPES_ENTITY: SetupEntity = {
  key: "leave-types",
  table: "hrm_leave_types",
  groupKey: "workforce",
  featureKey: "hrm",
  iconKey: "timer",
  orgScoped: true,
  actorCols: true,
  naturalKey: "code",
  hasActive: true,
  docSlug: "leave-time-versus-value",
  columns: [
    { key: "code", kind: "code" },
    { key: "name", kind: "text" },
    { key: "paid", kind: "boolean" },
    { key: "valueCrossing", kind: "badge", options: VALUE_CROSSINGS },
    { key: "requiresAttachment", kind: "boolean" },
    { key: "isActive", kind: "badge-active" },
  ],
  filters: [{ key: "valueCrossing", options: VALUE_CROSSINGS }],
  fields: [
    // Code is identity: editable on create, read-only on edit — rename by
    // deactivating and creating the new code, never by rewriting history.
    { key: "code", kind: "text", required: true, lockedOnEdit: true },
    { key: "name", kind: "text", required: true },
    { key: "paid", kind: "boolean", defaultValue: true },
    {
      key: "valueCrossing",
      kind: "select",
      required: true,
      defaultValue: "none",
      options: VALUE_CROSSINGS,
      helpTextKey: "fieldHelp.leaveValueCrossing",
    },
    { key: "requiresAttachment", kind: "boolean" },
    { key: "isActive", kind: "boolean", defaultValue: true },
  ],
};

export const LEAVE_POLICIES_ENTITY: SetupEntity = {
  key: "leave-policies",
  parentRecords: [{ entityKey: "leave-types", fieldKey: "leaveTypeId" }],
  table: "hrm_leave_policies",
  groupKey: "workforce",
  featureKey: "hrm",
  iconKey: "calendar",
  orgScoped: true,
  actorCols: true,
  orderBy: "effective_from desc",
  hasActive: true,
  docSlug: "leave-time-versus-value",
  columns: [
    { key: "leaveTypeId", kind: "ref", ref: "leave-types" },
    { key: "appliesEmployerSubsidiaryId", kind: "ref", ref: "subsidiaries" },
    { key: "appliesDepartmentId", kind: "ref", ref: "departments" },
    { key: "accrualKind", kind: "badge" },
    { key: "effectiveFrom", kind: "date" },
    { key: "effectiveTo", kind: "date" },
    { key: "minimumNoticeDays", kind: "number" },
    { key: "isActive", kind: "badge-active" },
  ],
  fields: [
    { key: "leaveTypeId", kind: "ref", ref: "leave-types", required: true },
    // Scope, accrual and carryover edit through typed slots projected from
    // the rule jsonb by 0194 STORED GENERATED columns (readable for prefill,
    // never written); normalizeHrmLeavePolicyInput folds them back into
    // applies_to, accrual_rule and carryover_rule and hrm-rule-slots.ts
    // persists the folded objects. Empty scope slots mean the whole org.
    {
      key: "appliesEmployerSubsidiaryId",
      kind: "ref",
      ref: "subsidiaries",
      helpTextKey: "fieldHelp.leaveAppliesSubsidiary",
    },
    {
      key: "appliesDepartmentId",
      kind: "ref",
      ref: "departments",
      helpTextKey: "fieldHelp.leaveAppliesDepartment",
    },
    // Targeting pickers: chip controls with type-ahead over employments
    // and classifications. Empty means all; the fold carries selections
    // into applies_to, never a member table (so kind 'stringArray', never
    // 'multiref' — multiref syncs a join table this entity does not have).
    {
      key: "appliesEmploymentIds",
      kind: "stringArray",
      ref: "worker-employments",
      helpTextKey: "fieldHelp.leaveAppliesEmployments",
    },
    {
      key: "appliesClassificationIds",
      kind: "stringArray",
      ref: "construction-classifications",
      helpTextKey: "fieldHelp.leaveAppliesClassifications",
    },
    {
      key: "accrualKind",
      kind: "select",
      defaultValue: "none",
      helpTextKey: "fieldHelp.leaveAccrualKind",
      options: [
        { value: "none", labelKey: "options.leaveAccrualKind.none" },
        { value: "per_period", labelKey: "options.leaveAccrualKind.per_period" },
        { value: "per_year", labelKey: "options.leaveAccrualKind.per_year" },
        { value: "unlimited", labelKey: "options.leaveAccrualKind.unlimited" },
      ],
    },
    { key: "accrualHours", kind: "text", helpTextKey: "fieldHelp.leaveAccrualHours" },
    {
      key: "accrualPeriodsPerYear",
      kind: "integer",
      helpTextKey: "fieldHelp.leaveAccrualPeriodsPerYear",
    },
    // Service tiers: base hours below the first tier, each tier's hours
    // from its anniversary on. Stored items keep snake_case props
    // (after_years, hours), the same shape the stored tiers keep, so the
    // fold and the prefill projection pass rows through untouched.
    {
      key: "accrualTiers",
      kind: "objectArray",
      helpTextKey: "fieldHelp.leaveAccrualTiers",
      itemTitleKey: "setup.fields.leaveAccrualTier",
      itemTitleField: "after_years",
      addLabelKey: "setup.fields.leaveAccrualTierAdd",
      fields: [
        {
          key: "after_years",
          labelKey: "setup.fields.leaveAccrualTierAfterYears",
          kind: "integer",
          required: true,
          min: 1,
        },
        {
          key: "hours",
          labelKey: "setup.fields.leaveAccrualTierHours",
          kind: "text",
          required: true,
        },
      ],
    },
    {
      key: "carryoverKind",
      kind: "select",
      defaultValue: "none",
      helpTextKey: "fieldHelp.leaveCarryoverKind",
      options: [
        { value: "none", labelKey: "options.leaveCarryoverKind.none" },
        { value: "carry_all", labelKey: "options.leaveCarryoverKind.carry_all" },
        { value: "carry_up_to", labelKey: "options.leaveCarryoverKind.carry_up_to" },
      ],
    },
    { key: "carryoverHours", kind: "text", helpTextKey: "fieldHelp.leaveCarryoverHours" },
    {
      key: "carryoverExpiresAfterDays",
      kind: "integer",
      helpTextKey: "fieldHelp.leaveCarryoverExpiresAfterDays",
    },
    { key: "minimumNoticeDays", kind: "integer", keepDefault: true, defaultValue: 0 },
    { key: "effectiveFrom", kind: "date", required: true },
    { key: "effectiveTo", kind: "date" },
    // Every policy change records why: the reason rides into the audit
    // before/after image, never into a column. Blanked on each edit so a
    // new change cannot reuse the previous reason.
    { key: "reason", kind: "textarea", required: true, resetOnEdit: true },
    { key: "isActive", kind: "boolean", defaultValue: true },
  ],
};

export const LEAVE_PAYROLL_ENTITLEMENT_MAPPINGS_ENTITY: SetupEntity = {
  key: "leave-payroll-entitlement-mappings",
  parentRecords: [{ entityKey: "leave-types", fieldKey: "leaveTypeId" }],
  table: "hrm_leave_payroll_entitlement_mappings",
  groupKey: "workforce",
  featureKey: "hrm",
  iconKey: "landmark",
  orgScoped: true,
  actorCols: true,
  orderBy: "effective_from desc",
  hasActive: true,
  allowUpdate: false,
  allowDelete: false,
  docSlug: "leave-time-versus-value",
  columns: [
    { key: "leaveTypeId", kind: "ref", ref: "leave-types" },
    { key: "entitlementPlanId", kind: "ref", ref: "entitlement-plans", labelKey: "fields.planId" },
    { key: "effectiveFrom", kind: "date" },
    { key: "reason", kind: "text" },
    { key: "isActive", kind: "badge-active" },
  ],
  fields: [
    { key: "leaveTypeId", kind: "ref", ref: "leave-types", required: true },
    {
      key: "entitlementPlanId",
      kind: "ref",
      ref: "entitlement-plans",
      required: true,
      labelKey: "fields.planId",
    },
    { key: "effectiveFrom", kind: "date", required: true },
    { key: "reason", kind: "textarea", required: true },
    { key: "isActive", kind: "boolean", defaultValue: true },
  ],
};
