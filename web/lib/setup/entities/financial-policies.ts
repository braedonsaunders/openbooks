import type { SetupEntity } from "../types";

const rateMethods = ["current", "average", "historical"].map((value) => ({
  value,
  labelKey: `options.accountRateMethod.${value}`,
}));
const lossPolicyModes = ["off", "warn", "require"].map((value) => ({
  value,
  labelKey: `options.projectLossPolicy.${value}`,
}));
const version = {
  actorCols: true,
  orgScoped: true,
  hasActive: false,
  allowUpdate: false,
  allowDelete: false,
  groupKey: "accounting",
  iconKey: "book-open",
  orderBy: "effective_from desc",
} as const;

export const FINANCIAL_POLICY_ENTITIES: SetupEntity[] = [
  {
    key: "fiscal-calendars",
    table: "fiscal_calendars",
    groupKey: "accounting",
    iconKey: "calendar",
    orgScoped: true,
    hasActive: true,
    readOnly: true,
    rehomed: true,
    allowCreate: false,
    allowUpdate: false,
    allowDelete: false,
    columns: [{ key: "name", kind: "text" }],
    fields: [{ key: "name", kind: "text", required: true }],
  },
  {
    key: "form-layouts",
    table: "form_layouts",
    groupKey: "accounting",
    iconKey: "book-open",
    orgScoped: true,
    hasActive: true,
    readOnly: true,
    rehomed: true,
    allowCreate: false,
    allowUpdate: false,
    allowDelete: false,
    columns: [
      { key: "name", kind: "text" },
      { key: "recordType", kind: "text" },
    ],
    fields: [
      { key: "name", kind: "text", required: true },
      { key: "recordType", kind: "text" },
    ],
  },
  {
    ...version,
    key: "fx-rate-types",
    table: "fx_rate_types",
    groupKey: "currency",
    naturalKey: "key",
    refValue: "key",
    hasActive: true,
    allowUpdate: true,
    orderBy: "key",
    columns: [
      { key: "key", kind: "code" },
      { key: "name", kind: "text" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      { key: "key", kind: "text", required: true, lockedOnEdit: true },
      { key: "name", kind: "text", required: true },
      { key: "isActive", kind: "boolean", defaultValue: true },
    ],
  },
  {
    ...version,
    key: "account-translation-policies",
    table: "account_translation_policies",
    featureKey: "multiCurrency",
    columns: [
      { key: "accountId", kind: "ref", ref: "accounts" },
      { key: "effectiveFrom", kind: "date" },
      { key: "generalRateType", kind: "badge", options: rateMethods },
      { key: "cashFlowRateType", kind: "badge", options: rateMethods },
    ],
    fields: [
      { key: "accountId", kind: "ref", ref: "accounts", required: true },
      { key: "effectiveFrom", kind: "date", required: true },
      {
        key: "generalRateType",
        kind: "select",
        required: true,
        options: rateMethods,
      },
      {
        key: "cashFlowRateType",
        kind: "select",
        required: true,
        options: rateMethods,
      },
      { key: "reason", kind: "textarea", required: true },
    ],
  },
  {
    ...version,
    key: "subsidiary-accounting-preferences",
    table: "subsidiary_accounting_preferences",
    featureKey: "multiSubsidiary",
    columns: [
      { key: "subsidiaryId", kind: "ref", ref: "subsidiaries" },
      { key: "effectiveFrom", kind: "date" },
      { key: "fiscalCalendarId", kind: "ref", ref: "fiscal-calendars" },
      { key: "postingRateType", kind: "ref", ref: "fx-rate-types" },
    ],
    fields: [
      { key: "subsidiaryId", kind: "ref", ref: "subsidiaries", required: true },
      { key: "effectiveFrom", kind: "date", required: true },
      { key: "fiscalCalendarId", kind: "ref", ref: "fiscal-calendars" },
      {
        key: "postingRateType",
        kind: "ref",
        ref: "fx-rate-types",
        required: true,
      },
      { key: "allowBackdatedPosting", kind: "boolean", defaultValue: true },
      { key: "allowFuturePosting", kind: "boolean", defaultValue: true },
      { key: "defaultJournalFormId", kind: "ref", ref: "form-layouts" },
      { key: "reason", kind: "textarea", required: true },
    ],
  },
  {
    ...version,
    key: "segment-balancing-policies",
    table: "segment_balancing_policies",
    columns: [
      { key: "segmentKey", kind: "text" },
      { key: "effectiveFrom", kind: "date" },
      { key: "clearingAccountId", kind: "ref", ref: "accounts" },
      { key: "priority", kind: "number" },
    ],
    fields: [
      { key: "segmentKey", kind: "text", required: true },
      { key: "effectiveFrom", kind: "date", required: true },
      {
        key: "clearingAccountId",
        kind: "ref",
        ref: "accounts",
        required: true,
        refAccountTypes: [
          "asset_current_other",
          "asset_other",
          "liability_current_other",
          "liability_long_term",
        ],
      },
      { key: "priority", kind: "integer", required: true, defaultValue: 100 },
      { key: "reason", kind: "textarea", required: true },
    ],
  },
  {
    ...version,
    key: "gl-audit-number-policies",
    table: "gl_audit_number_policies",
    columns: [
      { key: "subsidiaryId", kind: "ref", ref: "subsidiaries" },
      { key: "effectiveFrom", kind: "date" },
      { key: "resetRule", kind: "text" },
      { key: "prefix", kind: "text" },
    ],
    fields: [
      { key: "subsidiaryId", kind: "ref", ref: "subsidiaries", required: true },
      { key: "effectiveFrom", kind: "date", required: true },
      {
        key: "resetRule",
        kind: "select",
        required: true,
        options: ["period", "fiscal_year", "never"].map((value) => ({
          value,
          labelKey: `options.auditNumberReset.${value}`,
        })),
      },
      { key: "prefix", kind: "text", required: true, defaultValue: "GL" },
      { key: "reason", kind: "textarea", required: true },
    ],
  },
  // Foreign-currency expense lines convert at the dated exchange rate. A
  // version allowing overrides lets the operator record an explicit rate
  // with its reason instead; with no version the override is refused.
  {
    ...version,
    key: "expense-fx-policies",
    table: "expense_fx_policies",
    groupKey: "currency",
    featureKey: "expenses",
    columns: [
      { key: "effectiveFrom", kind: "date" },
      { key: "allowRateOverride", kind: "boolean" },
    ],
    fields: [
      { key: "effectiveFrom", kind: "date", required: true },
      { key: "allowRateOverride", kind: "boolean", defaultValue: false },
      { key: "reason", kind: "textarea", required: true },
    ],
  },
  // Loss contracts: whether close flags projects forecasting a loss without a
  // loss assessment in the period, and whether that finding blocks the close.
  {
    ...version,
    key: "project-loss-policies",
    table: "project_loss_policies",
    groupKey: "projects",
    featureKey: "projects",
    columns: [
      { key: "effectiveFrom", kind: "date" },
      { key: "mode", kind: "badge", options: lossPolicyModes },
    ],
    fields: [
      { key: "effectiveFrom", kind: "date", required: true },
      { key: "mode", kind: "select", required: true, options: lossPolicyModes },
      { key: "reason", kind: "textarea", required: true },
    ],
  },
];
