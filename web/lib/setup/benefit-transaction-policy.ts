import type { SetupEntity, SetupField } from "./types";

const field = (
  key: string,
  kind: SetupField["kind"],
  extra: Partial<SetupField> = {},
): SetupField => ({ key, kind, labelKey: `transactionBenefits.fields.${key}`, ...extra });
const ROLE_SOURCES = [
  "field_ticket_foreman",
  "field_ticket_superintendent",
  "project_foreman",
  "project_manager",
] as const;
const RECIPIENT_SOURCES = ["assignment", ...ROLE_SOURCES] as const;
const group = () =>
  field("groupId", "ref", {
    ref: "benefit-transaction-groups",
    refScopeField: "groupingSegmentId",
    required: true,
  });

/** The parent program owns one audited aggregate, rather than five independent settings lists. */
export const BENEFIT_TRANSACTION_POLICY_ENTITY: SetupEntity = {
  key: "benefit-transaction-policy",
  table: "hrm_benefit_programs",
  rehomed: true,
  groupKey: "workforce",
  featureKey: "hrm",
  iconKey: "gift",
  orgScoped: true,
  actorCols: true,
  naturalKey: "code",
  hasActive: false,
  allowCreate: false,
  allowDelete: false,
  titleKey: "transactionBenefits.title",
  singularTitleKey: "transactionBenefits.title",
  writePermission: "hrm.benefits.manage",
  importVia: "none",
  drawerSize: "2xl",
  mutationPath: "/api/hrm/benefit-transaction-rules",
  mutationRevision: { requestKey: "expectedRevision", rowColumn: "revision" },
  mutationUpdateKeys: [
    "documentKind",
    "dateBasis",
    "groupingSegmentId",
    "itemIds",
    "positions",
    "unassignedShare",
    "rounding",
    "responsibilities",
    "capPercent",
    "capProjectTypeId",
    "limits",
    "reason",
    "expectedRevision",
  ],
  columns: [
    { key: "code", kind: "code" },
    { key: "name", kind: "text" },
  ],
  recordSections: [
    {
      key: "source",
      titleKey: "transactionBenefits.source",
      descriptionKey: "transactionBenefits.sourceHint",
      fields: ["documentKind", "dateBasis", "groupingSegmentId", "itemIds"],
    },
    {
      key: "positions",
      titleKey: "transactionBenefits.positions",
      descriptionKey: "transactionBenefits.positionsHint",
      fields: ["positions", "unassignedShare", "rounding"],
    },
    {
      key: "responsibilities",
      titleKey: "transactionBenefits.responsibilities",
      descriptionKey: "transactionBenefits.responsibilitiesHint",
      fields: ["responsibilities"],
    },
    {
      key: "limits",
      titleKey: "transactionBenefits.limits",
      descriptionKey: "transactionBenefits.limitsHint",
      fields: ["capPercent", "capProjectTypeId", "limits"],
    },
    {
      key: "reason",
      titleKey: "transactionBenefits.reason",
      descriptionKey: "transactionBenefits.reasonHint",
      fields: ["reason"],
    },
  ],
  fields: [
    field("documentKind", "select", {
      required: true,
      options: ["sales_order", "customer_invoice", "field_ticket", "quote"].map((value) => ({
        value,
        labelKey: `transactionBenefits.kinds.${value}`,
      })),
    }),
    field("dateBasis", "select", {
      required: true,
      options: [
        { value: "document_date", labelKey: "transactionBenefits.documentDate" },
        { value: "work_date", labelKey: "transactionBenefits.workDate" },
      ],
    }),
    field("groupingSegmentId", "ref", {
      ref: "segment-definitions",
      helpTextKey: "transactionBenefits.companyGrouping",
    }),
    field("itemIds", "multiref", {
      ref: "items",
      required: true,
      searchableReferences: true,
      fullWidth: true,
    }),
    field("positions", "objectArray", {
      required: true,
      fullWidth: true,
      itemTitleField: "name",
      fields: [
        field("key", "text", { required: true }),
        field("name", "text", { required: true }),
        field("weight", "decimal", { required: true, decimalScale: 4, defaultValue: "1" }),
        field("recipientSource", "select", {
          required: true,
          defaultValue: "assignment",
          options: RECIPIENT_SOURCES.map((value) => ({
            value,
            labelKey: `transactionBenefits.sources.${value}`,
          })),
        }),
        field("fallbackOnlyWhenContextAbsent", "boolean", {
          showWhen: { field: "fallbackSource", in: [...ROLE_SOURCES] },
          clearWhenHidden: true,
          helpTextKey: "transactionBenefits.fields.fallbackOnlyWhenContextAbsentHint",
        }),
        field("fallbackSource", "select", {
          options: ROLE_SOURCES.map((value) => ({
            value,
            labelKey: `transactionBenefits.sources.${value}`,
          })),
          showWhen: { field: "recipientSource", in: [...ROLE_SOURCES] },
          clearWhenHidden: true,
        }),
      ],
    }),
    field("unassignedShare", "select", {
      required: true,
      defaultValue: "refuse",
      options: ["refuse", "forfeit"].map((value) => ({
        value,
        labelKey: `transactionBenefits.unassigned.${value}`,
      })),
    }),
    field("rounding", "select", {
      required: true,
      defaultValue: "per_group",
      options: ["per_group", "per_recipient"].map((value) => ({
        value,
        labelKey: `transactionBenefits.roundings.${value}`,
      })),
    }),
    field("responsibilities", "objectArray", {
      fullWidth: true,
      fields: [
        group(),
        field("positionKey", "select", {
          required: true,
          optionsFromField: { field: "positions", valueKey: "key", labelKey: "name" },
        }),
        field("employmentId", "ref", { required: true, ref: "worker-employments" }),
        field("effectiveFrom", "date", { required: true }),
        field("effectiveTo", "date"),
      ],
    }),
    field("capPercent", "decimal", {
      decimalScale: 4,
      helpTextKey: "transactionBenefits.capPercentHint",
    }),
    field("capProjectTypeId", "ref", {
      ref: "project-types",
      showWhen: { field: "capPercent", present: true },
      clearWhenHidden: true,
    }),
    field("limits", "objectArray", {
      fullWidth: true,
      helpTextKey: "transactionBenefits.limitsHint",
      fields: [
        group(),
        field("kind", "select", {
          required: true,
          defaultValue: "none",
          options: ["none", "amount"].map((value) => ({
            value,
            labelKey: `transactionBenefits.limitKinds.${value}`,
          })),
        }),
        field("amount", "decimal", {
          required: true,
          decimalScale: 4,
          showWhen: { field: "kind", in: ["amount"] },
          clearWhenHidden: true,
        }),
      ],
    }),
    field("reason", "textarea", { required: true, fullWidth: true, resetOnEdit: true }),
  ],
};

/**
 * The editor for one program's rules. A draft saves its rules in place; an
 * active program saves a dated revision, so the form also asks for the date
 * the revised rules apply from. Closed programs are read-only.
 */
export function benefitTransactionPolicyEditor(status: string, canManage: boolean): SetupEntity {
  const base = BENEFIT_TRANSACTION_POLICY_ENTITY;
  const readOnly = !canManage || (status !== "draft" && status !== "active");
  if (status !== "active") return { ...base, readOnly };
  return {
    ...base,
    readOnly,
    mutationUpdateKeys: [...(base.mutationUpdateKeys ?? []), "changeEffectiveFrom"],
    recordSections: base.recordSections?.map((section) =>
      section.key === "reason"
        ? { ...section, fields: ["changeEffectiveFrom", ...section.fields] }
        : section,
    ),
    fields: [
      ...base.fields,
      field("changeEffectiveFrom", "date", {
        required: true,
        helpTextKey: "transactionBenefits.changeEffectiveFromHint",
      }),
    ],
  };
}
