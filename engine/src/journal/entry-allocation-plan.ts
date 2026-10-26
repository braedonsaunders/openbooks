/**
 * Entry-mode allocation plan types: how a saved document's lines split across
 * allocation targets before they are stored. Owned by the journal contracts so
 * the document writer and the allocations planner share them; the allocations
 * module re-exports them.
 */

/** One submitted line plus the entry-mode request fields. */
export interface EntryLineInput {
  accountId: string;
  amount: string;
  quantity?: string | null;
  unit?: string | null;
  unitPrice?: string | null;
  itemId?: string | null;
  description?: string | null;
  taxCodeId?: string | null;
  taxGroupId?: string | null;
  withholdingTreatment?: "labour" | "materials" | "excluded" | null;
  withholdingMaterialsCost?: string | null;
  partyId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  subsidiaryId?: string | null;
  stockLocationId?: string | null;
  extraDims?: Record<string, string | null>;
  custom?: Record<string, unknown>;
  isBillable?: boolean | null;
  /** Work period the line bills; every exploded child bills the same work. */
  workFrom?: string | null;
  workTo?: string | null;
  /** Amortization template and service window; every exploded child defers alike. */
  amortizationTemplateId?: string | null;
  amortizationStartOn?: string | null;
  amortizationEndOn?: string | null;
  /**
   * Marketplace collecting this line's tax. Explosion splits one sale across
   * dimensions, so every child inherits the parent's collector verbatim.
   */
  marketplaceFacilitator?: string | null;
  /** Rule key for an explicit explode request; wins over matching and groups. */
  distributionKey?: string | null;
  /** Stored group this submitted line belongs to (re-save matching). */
  distributionGroupId?: string | null;
  /** Hand-edited children are never regenerated. */
  distributionLocked?: boolean | null;
}

/** A planned output line: stamps resolved, request key consumed. */
export interface PlannedEntryLine {
  accountId: string;
  amount: string;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  itemId: string | null;
  description: string | null;
  taxCodeId: string | null;
  taxGroupId: string | null;
  withholdingTreatment?: "labour" | "materials" | "excluded" | null;
  withholdingMaterialsCost?: string | null;
  /** Marketplace collecting this line's tax; inherited from the exploded parent. */
  marketplaceFacilitator: string | null;
  partyId: string | null;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
  subsidiaryId: string | null;
  stockLocationId: string | null;
  extraDims: Record<string, string | null>;
  custom: Record<string, unknown>;
  isBillable: boolean | null;
  /** Absent preserves the stored work period of the line being re-saved. */
  workFrom?: string | null;
  workTo?: string | null;
  amortizationTemplateId?: string | null;
  amortizationStartOn?: string | null;
  amortizationEndOn?: string | null;
  distributionGroupId: string | null;
  distributionRuleId: string | null;
  distributionVersionId: string | null;
  distributionLocked: boolean;
}

/** Lineage before ids are known; the caller stamps document/child ids. */
export interface PlannedEntryLineage {
  ruleId: string;
  versionId: string;
  definitionHash: string;
  driverId?: string | null;
  driverValue?: string | null;
  driverTotal?: string | null;
  share?: string | null;
  amount: string;
  residual: string;
  /** Index into the plan's lines; the caller maps it to the inserted row id. */
  targetLineIndex: number;
  /** Replaced stored child (regenerations); null on a fresh explode — the
   * entered parent line is ephemeral, replaced wholesale, so entry lineage
   * anchors on the document plus the new child. */
  sourceDocumentLineId?: string | null;
}

export interface EntryPlan {
  lines: PlannedEntryLine[];
  lineage: PlannedEntryLineage[];
  /** True when the line set structurally changed (explode/regenerate/collapse). */
  exploded: boolean;
}
