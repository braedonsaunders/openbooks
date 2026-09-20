import type { ContinuousCloseAgentKey } from "@openbooks/engine/src/agents/continuous-close-config.ts";

/**
 * Per-pack enrichment prompts for the continuous-close background agents.
 * Pure strings: no server imports, so unit tests can pin the copy every pack
 * (and the coordinator's future packs) send to the enrichment model.
 *
 * Packs without an entry run on the shared finance/accounting instructions
 * unchanged; a future pack degrades to the generic brief until it registers
 * its own lines here.
 */
const PACK_SYSTEM_GUIDANCE: Partial<Record<ContinuousCloseAgentKey, string>> = {
  collections:
    "For collections work, age every overdue balance with the AR aging tool as of today, corroborate broken promises against the document's expected pay date, and rank debtors by exposure before drafting the next reminder or call-list step per customer.",
  payables:
    "For payables work, age open bills with the AP aging tool as of today, confirm each duplicate pair by vendor, kind, and amount before recommending a void or recovery, and sequence the pay run oldest-due first inside the discount windows.",
  reconciliation:
    "For reconciliation work, treat every match candidate as unconfirmed until the statement line and the journal leg agree on signed amount and date; never mark anything matched yourself — recommend the exact match command for review.",
  hygiene:
    "For data-hygiene work, verify each gap against the live record and recommend the exact setup correction with its navigation path; never guess an account, tax code, budget value, or mapping — name what the user must pick.",
};

/** Extra system instructions for one pack; empty for packs on shared instructions. */
export function packSystemGuidance(agentKey: ContinuousCloseAgentKey): string {
  return PACK_SYSTEM_GUIDANCE[agentKey] ?? "";
}

const PACK_MISSIONS: Partial<Record<ContinuousCloseAgentKey, string>> = {
  collections:
    "Create a prioritized collections action list. Rank every supplied finding by exposure, confirm the arrears against current AR aging, and draft the next reminder or call step per customer.",
  payables:
    "Create a payables review: confirm duplicate pairs, sequence the bills due before the next pay run oldest-due first, flag capturable discounts, and clear the stalled approvals.",
  reconciliation:
    "Create a reconciliation review. Confirm each match candidate against the statement line and journal leg, and state exactly which sessions can be signed off and which accounts still need a first session.",
  hygiene:
    "Create a data-hygiene review. Verify each master-data gap against the live record and prescribe the exact setup correction and navigation path for every item.",
  forensics:
    "Investigate every supplied finding down to its spend document: load the bill, expense, or journal entry behind each item with find_documents, get_document, and find_journal_entries, and decide whether the pattern is genuine exposure or a posting artefact. Cite the document behind every explanation.",
  tax:
    "Investigate every supplied finding against the filing surface: re-run tax_return for a blocked return, list_tax_return_forms for coverage, and documents_missing_tax_code for code gaps. Name the exact missing input or engine error behind each flag.",
  payroll:
    "Investigate every supplied finding in the pay records: list_pay_runs and payroll_remittances for dues and their bills, list_payroll_employees and payroll_year_end for elections and slip gaps. Tie every amount to its run or remittance group.",
  projects:
    "Investigate every supplied finding at the project level: rank_projects and project_profitability for the margin, budget, commitment, and unbilled detail behind each flag. Name the cost, commitment, or unbilled balance driving it and link the project cockpit.",
  cash:
    "Investigate every supplied finding against live liquidity: list_open_items and aging for what is due when, cash_flow for the statement view. Tie each crunch or shortfall week to the bills and receipts behind it.",
};

/** The mission paragraph of the enrichment prompt; packs without an entry keep the close-readiness brief. */
export function packMissionBrief(agentKey: ContinuousCloseAgentKey, today: string): string {
  if (agentKey === "finance") {
    return `Create a current management-ready financial summary even if there are no detector findings. Compare the latest completed fiscal period with prior completed periods. For collection and payment exposure, run both AR and AP aging as of ${today} (today), not at the completed period end, and label that aging date explicitly. Use budget and concentration context when available.`;
  }
  return (
    PACK_MISSIONS[agentKey] ??
    "Create a concise close-readiness brief. Investigate every supplied finding and identify the transaction-level cause where the available tools support it."
  );
}

const PACK_NARRATIVE_TITLES: Partial<Record<ContinuousCloseAgentKey, string>> = {
  collections: "Collections action list",
  payables: "Payables review",
  reconciliation: "Reconciliation review",
  hygiene: "Data hygiene review",
};

/** Default narrative title when the model omits one; finance keeps its title. */
export function packNarrativeTitle(agentKey: ContinuousCloseAgentKey): string {
  if (agentKey === "finance") return "Financial performance summary";
  return PACK_NARRATIVE_TITLES[agentKey] ?? "Accounting close-readiness brief";
}
