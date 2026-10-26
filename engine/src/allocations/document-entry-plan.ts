import { sql } from "drizzle-orm";
import type { EntryAllocationRequest } from "../journal/posting-line-contributors.ts";
import { normalizeMoney } from "../money/money.ts";
import { db } from "../platform/db.ts";
import { resolveAccountGroups } from "../records/account-groups.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import {
  EntryAllocationError,
  loadEntryRuleByKey,
  planEntryDistributions,
  type EntryDocumentContext,
  type EntryLineInput,
  type EntryPlan,
  type StoredEntryGroup,
} from "./entry.ts";
import { listEntryRulesInEffect } from "./match.ts";
import type { RuleInEffect } from "./types.ts";
import { WithholdingMaterialsCostError } from "./withholding-cost.ts";

/**
 * Plan entry-mode distributions for a document save: resolve explicit
 * distributionKeys (unknown/inactive/wrong-mode keys are clear 422s),
 * load the entry rules in effect on the document date, preload the account
 * groups referenced by their scopes, snapshot the stored groups for re-save
 * matching, and run the pure kernel planner. The caller runs it only with
 * entry-mode allocation switched on.
 */
export async function planDocumentEntryAllocations(
  args: EntryAllocationRequest,
): Promise<EntryPlan> {
  const { orgId } = args;
  const asOf = args.documentDate;

  const explicitRules = await resolveExplicitEntryRules(orgId, args.lines, asOf);

  const rules = await listEntryRulesInEffect({ orgId, mode: "entry", asOf });

  const resolveAccountGroup = await entryAccountGroupResolver(orgId, rules, explicitRules);
  const existingGroups = await loadStoredEntryGroups(orgId, args.documentId);

  for (const [index, line] of args.lines.entries()) {
    if (
      args.lineIds[index] &&
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
  try {
    return planEntryDistributions(docContext, args.lines, rules, {
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
  lines: EntryLineInput[],
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
