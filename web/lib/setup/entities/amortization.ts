/** Setup-registry expense amortization templates. */
import type { SetupEntity } from "../types";

const METHOD_OPTIONS = ["straight_line", "prorated_first_last", "exact_days", "variable"].map(
  (value) => ({
    value,
    labelKey: `options.amortizationMethod.${value}`,
  }),
);
const TERM_SOURCE_OPTIONS = ["template", "service_dates"].map((value) => ({
  value,
  labelKey: `options.amortizationTermSource.${value}`,
}));
const DEFERRAL_ACCOUNT_TYPES = ["asset_current_other", "asset_other"] as const;
const DESTINATION_ACCOUNT_TYPES = ["cogs", "expense", "expense_other", "expense_deferred"] as const;

export const AMORTIZATION_ENTITIES: SetupEntity[] = [
  {
    // Amortization templates: how a prepaid or deferred expense releases to
    // expense. Effective-dated by code: a new version (same code, later
    // effective date) governs transactions dated from then on, and a version
    // a schedule or posted line uses keeps its policy — the database refuses
    // the edit — so a change never reinterprets history.
    key: "expense-amortization-templates",
    table: "expense_amortization_templates",
    actorCols: true,
    groupKey: "accounting",
    featureKey: "expenseAmortization",
    writePermission: "amortization.manage",
    iconKey: "timer",
    orgScoped: true,
    orderBy: "code, effective_from desc",
    hasActive: true,
    docSlug: "expense-amortization",
    columns: [
      { key: "code", kind: "code" },
      { key: "name", kind: "text" },
      { key: "effectiveFrom", kind: "date" },
      {
        key: "method",
        kind: "badge",
        options: METHOD_OPTIONS,
        labelKey: "fields.amortizationMethod",
      },
      { key: "periodCount", kind: "number", labelKey: "fields.amortizationPeriodCount" },
      {
        key: "deferralAccountId",
        kind: "ref",
        ref: "accounts",
        labelKey: "fields.amortizationDeferralAccount",
      },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      {
        key: "code",
        kind: "text",
        required: true,
        helpTextKey: "fieldHelp.amortizationTemplateCode",
      },
      { key: "name", kind: "text", required: true },
      { key: "description", kind: "textarea" },
      {
        key: "effectiveFrom",
        kind: "date",
        required: true,
        helpTextKey: "fieldHelp.amortizationEffectiveFrom",
      },
      {
        key: "method",
        kind: "select",
        required: true,
        options: METHOD_OPTIONS,
        defaultValue: "straight_line",
        labelKey: "fields.amortizationMethod",
        helpTextKey: "fieldHelp.amortizationMethod",
      },
      {
        key: "termSource",
        kind: "select",
        required: true,
        options: TERM_SOURCE_OPTIONS,
        defaultValue: "template",
        labelKey: "fields.amortizationTermSource",
        helpTextKey: "fieldHelp.amortizationTermSource",
        showWhen: { field: "method", in: ["straight_line", "prorated_first_last", "exact_days"] },
      },
      {
        key: "periodCount",
        kind: "integer",
        min: 1,
        max: 600,
        labelKey: "fields.amortizationPeriodCount",
        showWhen: { field: "termSource", in: ["template"] },
        clearWhenHidden: true,
      },
      {
        key: "percentages",
        kind: "objectArray",
        fullWidth: true,
        labelKey: "fields.amortizationPercentages",
        helpTextKey: "fieldHelp.amortizationPercentages",
        itemTitleKey: "fields.amortizationPeriodRow",
        addLabelKey: "fields.amortizationAddPeriod",
        showWhen: { field: "method", in: ["variable"] },
        clearWhenHidden: true,
        fields: [
          {
            key: "percent",
            kind: "decimal",
            decimalScale: 6,
            required: true,
            labelKey: "fields.amortizationPercent",
          },
        ],
      },
      {
        key: "periodOffset",
        kind: "integer",
        min: 0,
        max: 120,
        keepDefault: true,
        helpTextKey: "fieldHelp.amortizationPeriodOffset",
      },
      {
        key: "deferralAccountId",
        kind: "ref",
        ref: "accounts",
        required: true,
        refAccountTypes: DEFERRAL_ACCOUNT_TYPES,
        labelKey: "fields.amortizationDeferralAccount",
        helpTextKey: "fieldHelp.amortizationDeferralAccount",
      },
      {
        key: "destinationAccountId",
        kind: "ref",
        ref: "accounts",
        refAccountTypes: DESTINATION_ACCOUNT_TYPES,
        labelKey: "fields.amortizationDestinationAccount",
        helpTextKey: "fieldHelp.amortizationDestinationAccount",
      },
      { key: "isActive", kind: "boolean", defaultValue: true },
    ],
  },
];
