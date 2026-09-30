/** Operator-facing names for subsequent-measurement events.
 * Inbox, emails, and source-record history use these so they cannot drift
 * from each other. This is not ASC 250 / IAS 8 "Accounting Changes". */
export const FINANCIAL_CHANGE_OPERATION_LABELS: Record<string, string> = {
  expected_breakage_estimate: "Expected prepaid breakage estimate",
  provision_assessment: "Provision assessment",
  modification: "Lease modification",
  remeasurement: "Lease remeasurement",
  termination: "Lease termination",
  separate_lease: "Separate lease",
  contract_modification: "Contract modification",
  partial_disposal: "Partial disposal",
  intercompany_transfer: "Intercompany transfer",
  group_valuation: "Group valuation",
  loss_of_control: "Loss of control",
  reversal: "Reversal",
  scrap_snapshot_restatement: "Scrap snapshot restatement",
};

export const FINANCIAL_CHANGE_DOMAIN_LABELS: Record<string, string> = {
  provision: "Provision and contingency",
  lease: "Lessee lease",
  asset: "Fixed asset",
  revenue: "Revenue contract",
  consolidation: "Consolidation",
  manufacturing: "Manufacturing",
};

export const FINANCIAL_CHANGE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  applied: "Applied",
};

export function financialChangeEventLabel(operation: string): string {
  return FINANCIAL_CHANGE_OPERATION_LABELS[operation] ?? operation.replaceAll("_", " ");
}

export function financialChangeDomainLabel(domain: string): string {
  return FINANCIAL_CHANGE_DOMAIN_LABELS[domain] ?? domain;
}

export function financialChangeStatusLabel(status: string): string {
  return FINANCIAL_CHANGE_STATUS_LABELS[status] ?? status.replaceAll("_", " ");
}

export function financialChangeInboxLabel(values: {
  operation?: unknown;
  effectiveOn?: unknown;
  subjectLabel?: unknown;
  id?: string;
}): string {
  const event = financialChangeEventLabel(String(values.operation ?? ""));
  const subject =
    typeof values.subjectLabel === "string" ? values.subjectLabel.trim() : "";
  if (subject) return `${event} · ${subject}`;
  const when = values.effectiveOn == null ? "" : String(values.effectiveOn);
  return when ? `${event} · ${when}` : event || String(values.id ?? "accounting event");
}
