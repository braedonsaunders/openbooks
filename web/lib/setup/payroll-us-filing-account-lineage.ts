import type { SetupEntity } from "./types";

/** Source ownership is a selected filing account's dated child history. */
export const PAYROLL_US_FILING_ACCOUNT_LINEAGE_ENTITY: SetupEntity = {
  key: "payroll-us-filing-account-employer-lineage",
  table: "payroll_us_filing_account_employer_lineage",
  groupKey: "workforce",
  featureKey: "payroll",
  iconKey: "landmark",
  orgScoped: true,
  actorCols: true,
  hasActive: false,
  allowDelete: false,
  parentRecords: [
    {
      entityKey: "payroll-filing-accounts",
      fieldKey: "filingAccountId",
      showWhen: {
        all: [
          { field: "country", in: ["US"] },
          { field: "programType", in: ["us_state_sui"] },
        ],
      },
    },
  ],
  rehomed: true,
  orderBy: "effective_from desc",
  columns: [
    {
      key: "federalAccountId",
      kind: "ref",
      ref: "us-federal-filing-accounts",
      labelKey: "usFilingLineage.federalAccount",
    },
    {
      key: "subsidiaryId",
      kind: "ref",
      ref: "payroll-lineage-employers",
      labelKey: "usFilingLineage.employer",
    },
    { key: "effectiveFrom", kind: "date" },
    { key: "effectiveTo", kind: "date" },
    { key: "sourceReference", kind: "text", labelKey: "usFilingLineage.sourceReference" },
  ],
  fields: [
    {
      key: "filingAccountId",
      kind: "ref",
      ref: "payroll-filing-accounts",
      required: true,
      lockedOnEdit: true,
      labelKey: "usFilingLineage.stateAccount",
    },
    {
      key: "subsidiaryId",
      kind: "ref",
      ref: "payroll-lineage-employers",
      required: true,
      legalEntity: true,
      lockedOnEdit: true,
      labelKey: "usFilingLineage.employer",
    },
    {
      key: "federalAccountId",
      kind: "ref",
      ref: "us-federal-filing-accounts",
      required: true,
      lockedOnEdit: true,
      labelKey: "usFilingLineage.federalAccount",
      helpTextKey: "usFilingLineage.federalHelp",
    },
    { key: "effectiveFrom", kind: "date", required: true, lockedOnEdit: true },
    { key: "effectiveTo", kind: "date", helpTextKey: "usFilingLineage.datesHelp" },
    {
      key: "sourceReference",
      kind: "textarea",
      required: true,
      lockedOnEdit: true,
      fullWidth: true,
      labelKey: "usFilingLineage.sourceReference",
      helpTextKey: "usFilingLineage.sourceHelp",
    },
    {
      key: "changeReason",
      kind: "textarea",
      required: true,
      resetOnEdit: true,
      fullWidth: true,
      labelKey: "usFilingLineage.reason",
    },
  ],
};
