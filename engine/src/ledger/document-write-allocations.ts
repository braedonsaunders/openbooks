import { sql } from "drizzle-orm";
import { WithholdingMaterialsCostError } from "../allocations/withholding-cost.ts";
import { resolveAccountGroups } from "../records/account-groups.ts";
import {
  EntryAllocationError,
  loadEntryRuleByKey,
  planEntryDistributions,
  type EntryDocumentContext,
  type EntryLineInput,
  type EntryPlan,
  type StoredEntryGroup,
} from "../allocations/entry.ts";
import { listEntryRulesInEffect } from "../allocations/match.ts";
import type { RuleInEffect } from "../allocations/types.ts";
import { db } from "../platform/db.ts";
import { normalizeMoney } from "../money/money.ts";
import { isFeatureEnabled } from "../organization/feature-state.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
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
 * Plan entry-mode distributions for a document save: resolve explicit
 * distributionKeys (unknown/inactive/wrong-mode keys are clear 422s),
 * load the entry rules in effect on the document date, preload the account
 * groups referenced by their scopes, snapshot the stored groups for re-save
 * matching, and run the pure kernel planner. Returns null when the feature
 * is off — the submitted lines are then saved untouched.
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
  const asOf = args.documentDate;

  const explicitRules = await resolveExplicitEntryRules(orgId, args.lines, asOf);

  const rules = await listEntryRulesInEffect({ orgId, mode: "entry", asOf });

  const resolveAccountGroup = await entryAccountGroupResolver(orgId, rules, explicitRules);
  const existingGroups = await loadStoredEntryGroups(orgId, args.documentId);

  for (const [index, line] of args.lines.entries()) {
    if (
      line.lineId &&
      line.distributionGroupId &&
      !existingGroups.has(line.distributionGroupId) &&
      (line.withholdingMaterialsCost != null || line.withholdingTreatment != null)
    ) {
      throw new DocumentEditError(
        422,
        `Line ${index + 1}: the stored distribution cannot be resolved; reload the bill before changing withholding inputs`,
      );
    }
  }

  // Header-default dims feed the match coordinate when a line leaves them blank.
  const headerRow = (
    await db.execute<{
      departmentId: string | null;
      projectId: string | null;
      locationId: string | null;
      classId: string | null;
      subsidiaryId: string | null;
    }>(
      sql`
      select department_id as "departmentId", project_id as "projectId",
             location_id as "locationId", class_id as "classId",
             subsidiary_id as "subsidiaryId"
        from documents where id = ${args.documentId} and org_id = ${orgId}
    `,
      "objects",
    )
  )[0];
  const docContext: EntryDocumentContext = {
    kind: args.kind,
    departmentId: args.header.departmentId ?? headerRow?.departmentId ?? null,
    projectId: args.header.projectId ?? headerRow?.projectId ?? null,
    locationId: args.header.locationId ?? headerRow?.locationId ?? null,
    classId: args.header.classId ?? headerRow?.classId ?? null,
    subsidiaryId: args.header.subsidiaryId ?? headerRow?.subsidiaryId ?? null,
    unsplitDistributionGroups: args.unsplitDistributionGroups,
  };
  const entryLines: EntryLineInput[] = args.lines.map(toEntryLineInput);
  try {
    return planEntryDistributions(docContext, entryLines, rules, {
      explicitRules,
      existingGroups,
      resolveAccountGroup,
    });
  } catch (error) {
    if (error instanceof EntryAllocationError || error instanceof WithholdingMaterialsCostError)
      throw new DocumentEditError(422, error.message);
    throw error;
  }
}

/** Rules named by explicit distributionKeys, refused by name when unknown, of another mode, or inactive. */
async function resolveExplicitEntryRules(
  orgId: string,
  lines: DocumentLineInput[],
  asOf: string,
): Promise<Map<string, RuleInEffect>> {
  const keys = [
    ...new Set(
      lines
        .map((l) => l.distributionKey)
        .filter((k): k is string => typeof k === "string" && k.length > 0),
    ),
  ];
  const explicitRules = new Map<string, RuleInEffect>();
  for (const key of keys) {
    const lookup = await loadEntryRuleByKey(orgId, key, asOf);
    if (lookup.status === "not_found") {
      throw new DocumentEditError(
        422,
        `distributionKey "${key}" does not match an allocation rule`,
      );
    }
    if (lookup.status === "wrong_mode") {
      throw new DocumentEditError(
        422,
        `distributionKey "${key}" is a ${lookup.mode} rule — only entry rules can split document lines`,
      );
    }
    if (lookup.status === "inactive") {
      throw new DocumentEditError(
        422,
        `distributionKey "${key}" is not active with a published version in effect`,
      );
    }
    explicitRules.set(key, lookup.rule);
  }
  return explicitRules;
}

// Account-group scopes resolve through one preloaded membership map per
// referenced (dimension, groupKey) pair, keeping the matcher itself db-free.
async function entryAccountGroupResolver(
  orgId: string,
  rules: RuleInEffect[],
  explicitRules: Map<string, RuleInEffect>,
): Promise<((dimension: string, groupKey: string) => Set<string>) | undefined> {
  const needs = new Map<string, { dimension: string; groupKey: string }>();
  for (const r of [...rules, ...explicitRules.values()]) {
    const scope = r.version.accountScope;
    if (scope.kind === "account_group") {
      needs.set(JSON.stringify([scope.dimension, scope.groupKey]), {
        dimension: scope.dimension,
        groupKey: scope.groupKey,
      });
    }
  }
  let resolveAccountGroup: ((dimension: string, groupKey: string) => Set<string>) | undefined;
  if (needs.size > 0) {
    const memberships = new Map<string, Set<string>>();
    for (const need of needs.values()) {
      const resolved = await resolveAccountGroups(need.dimension, orgId);
      const members = new Set<string>();
      for (const [accountId, ref] of resolved.byAccount) {
        if (ref.key === need.groupKey) members.add(accountId);
      }
      memberships.set(JSON.stringify([need.dimension, need.groupKey]), members);
    }
    resolveAccountGroup = (dimension, groupKey) =>
      memberships.get(JSON.stringify([dimension, groupKey])) ?? new Set<string>();
  }
  return resolveAccountGroup;
}

// Stored groups for re-save matching: group-level lock is ANY locked
// child, and the total is normalized so the planner's exact comparison
// cannot trip on numeric scale. Manual groups keep their nullable rule
// stamps and exact operator-entered costs through subsequent saves.
async function loadStoredEntryGroups(
  orgId: string,
  documentId: string,
): Promise<Map<string, StoredEntryGroup>> {
  const existingGroups = new Map<string, StoredEntryGroup>();
  const stored = await db.execute<{
    groupId: string;
    ruleId: string | null;
    versionId: string | null;
    locked: boolean;
    total: string;
    memberIds: string[];
  }>(
    sql`
    select distribution_group_id as "groupId",
           min(distribution_rule_id::text)::uuid as "ruleId",
           min(distribution_version_id::text)::uuid as "versionId",
           bool_or(distribution_locked) as "locked",
           sum(amount)::text as "total",
           array_agg(id order by line_number) as "memberIds"
      from document_lines
     where document_id = ${documentId} and org_id = ${orgId}
       and distribution_group_id is not null
     group by distribution_group_id
  `,
    "objects",
  );
  for (const row of stored) {
    existingGroups.set(row.groupId, {
      groupId: row.groupId,
      ruleId: row.ruleId,
      versionId: row.versionId,
      locked: row.locked === true,
      total: normalizeMoney(row.total),
      memberIds: row.memberIds ?? [],
    });
  }
  return existingGroups;
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
