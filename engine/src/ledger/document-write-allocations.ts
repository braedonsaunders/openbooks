import type { EntryLineInput, EntryPlan } from "../journal/entry-allocation-plan.ts";
import { postingLineHooks } from "../journal/posting-line-contributors.ts";
import { isFeatureEnabled } from "../organization/feature-state.ts";
import type { DocumentLineInput, DocumentEditInput } from "./document-input.ts";

/**
 * Entry-mode allocation gate, shared with the data-io import writer. Gate
 * failures propagate instead of silently disabling the path; with the feature
 * off, lines save untouched.
 */
export async function entryAllocationsEnabled(orgId: string): Promise<boolean> {
  return isFeatureEnabled(orgId, "allocationsAtEntry");
}

/**
 * Plan entry-mode distributions for a document save through the allocations
 * planner. Returns null when the feature is off — the submitted lines are then
 * saved untouched.
 */
export async function planDocumentEntryAllocations(args: {
  orgId: string;
  documentId: string;
  kind: string;
  documentDate: string;
  header: Pick<
    DocumentEditInput,
    "departmentId" | "projectId" | "locationId" | "classId" | "subsidiaryId"
  >;
  lines: DocumentLineInput[];
  unsplitDistributionGroups?: string[];
}): Promise<EntryPlan | null> {
  const { orgId } = args;
  if (!(await entryAllocationsEnabled(orgId))) return null;
  return postingLineHooks.require("allocations").planEntryAllocations({
    orgId,
    documentId: args.documentId,
    kind: args.kind,
    documentDate: args.documentDate,
    header: args.header,
    lines: args.lines.map(toEntryLineInput),
    lineIds: args.lines.map((line) => line.lineId ?? null),
    unsplitDistributionGroups: args.unsplitDistributionGroups,
  });
}

/** The planner's view of one submitted line. */
function toEntryLineInput(l: DocumentLineInput): EntryLineInput {
  return {
    accountId: l.accountId!,
    amount: String(l.amount),
    quantity: l.quantity ?? null,
    unit: l.unit ?? null,
    unitPrice: l.unitPrice ?? null,
    itemId: l.itemId ?? null,
    description: l.description ?? null,
    taxCodeId: l.taxCodeId ?? null,
    taxGroupId: l.taxGroupId ?? null,
    withholdingTreatment: l.withholdingTreatment,
    withholdingMaterialsCost: l.withholdingMaterialsCost,
    marketplaceFacilitator: l.marketplaceFacilitator ?? null,
    partyId: l.partyId ?? null,
    departmentId: l.departmentId ?? null,
    projectId: l.projectId ?? null,
    locationId: l.locationId ?? null,
    classId: l.classId ?? null,
    subsidiaryId: null,
    stockLocationId: l.stockLocationId ?? null,
    extraDims: { ...(l.extraDims ?? {}) },
    custom: l.custom ?? {},
    isBillable: null,
    workFrom: l.workFrom,
    workTo: l.workTo,
    amortizationTemplateId: l.amortizationTemplateId ?? null,
    amortizationStartOn: l.amortizationStartOn ?? null,
    amortizationEndOn: l.amortizationEndOn ?? null,
    distributionKey: l.distributionKey ?? null,
    distributionGroupId: l.distributionGroupId ?? null,
    distributionLocked: l.distributionLocked ?? null,
  };
}
