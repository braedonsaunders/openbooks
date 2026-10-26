import {
  gateDecisionCapability,
  worklistGateKindCounts,
  worklistGates,
  type GateSubsidiaryScope,
  type WorklistAudience,
  type WorklistGate,
} from "./gates.ts";

export type { WorklistAudience } from "./gates.ts";
export type UnifiedApproval = { kind: "flow_gate"; id: string; gate: WorklistGate };
export interface WorklistScope {
  roles?: Iterable<string>;
  allowedSubsidiaryIds?: GateSubsidiaryScope;
}
export interface WorklistPage {
  limit: number;
  offset: number;
  kind?: string;
  query?: string;
  overdue?: boolean;
}
export interface WorklistPageScope extends WorklistScope {
  /** Gate + gateless-document legs ride the flows approval grant. */
  includeFlows?: boolean;
  /**
   * `caller` (the default): the caller's own worklist. `organization`: every
   * pending, live item in the organization inside the caller's legal-entity
   * boundary, whatever its assignee and whoever submitted it.
   */
  audience?: WorklistAudience;
}
export interface WorklistPageResult {
  /** The requested global page in merge order. */
  items: UnifiedApproval[];
  /** Exact filtered total across all legs (drives pagination). */
  total: number;
  /** Exact UNFILTERED per-kind counts (drives kind chips). */
  kindCounts: Map<string, number>;
}
const sum = (counts: Map<string, number>) =>
  [...counts.values()].reduce((total, count) => total + count, 0);

/** All approval decisions are native Flow gates; module records never form a
 * parallel approval queue or an alternate decision path. */
export async function worklistApprovals(
  orgId: string,
  userId: string,
  scope: WorklistScope = {},
): Promise<UnifiedApproval[]> {
  return (await worklistGates(orgId, userId, scope.roles, scope.allowedSubsidiaryIds)).map(
    (gate) => ({ kind: "flow_gate", id: gate.id, gate }),
  );
}
export async function worklistApprovalsCount(
  orgId: string,
  userId: string,
  scope: WorklistPageScope = {},
): Promise<number> {
  if (scope.includeFlows === false) return 0;
  return sum(
    await worklistGateKindCounts(
      orgId,
      userId,
      scope.roles,
      scope.allowedSubsidiaryIds,
      undefined,
      undefined,
      undefined,
      scope.audience ?? "caller",
    ),
  );
}
export async function worklistApprovalsPage(
  orgId: string,
  userId: string,
  scope: WorklistPageScope = {},
  page: WorklistPage,
): Promise<WorklistPageResult> {
  if (scope.includeFlows === false) return { items: [], total: 0, kindCounts: new Map() };
  const audience = scope.audience ?? "caller";
  const [rows, counts, kindCounts] = await Promise.all([
    worklistGates(orgId, userId, scope.roles, scope.allowedSubsidiaryIds, {
      prefix: page.offset + page.limit,
      ...page,
      audience,
    }),
    worklistGateKindCounts(
      orgId,
      userId,
      scope.roles,
      scope.allowedSubsidiaryIds,
      page.kind,
      page.query,
      page.overdue,
      audience,
    ),
    worklistGateKindCounts(
      orgId,
      userId,
      scope.roles,
      scope.allowedSubsidiaryIds,
      undefined,
      page.query,
      page.overdue,
      audience,
    ),
  ]);
  return {
    items: rows
      .slice(page.offset, page.offset + page.limit)
      .map((gate) => ({ kind: "flow_gate", id: gate.id, gate })),
    total: sum(counts),
    kindCounts,
  };
}
export async function worklistGatesAwaitingAnotherApprover(
  orgId: string,
  userId: string,
  roles?: Iterable<string>,
  allowedSubsidiaryIds?: GateSubsidiaryScope,
): Promise<string[]> {
  const blocked: string[] = [];
  for (const gate of await worklistGates(orgId, userId, roles, allowedSubsidiaryIds))
    if ((await gateDecisionCapability(gate.id, userId)).sodBlocked) blocked.push(gate.id);
  return blocked;
}
export async function worklistApprovalById(
  orgId: string,
  userId: string,
  scope: WorklistScope,
  sourceId: string,
): Promise<UnifiedApproval | null> {
  const gate = (
    await worklistGates(orgId, userId, scope.roles, scope.allowedSubsidiaryIds, {
      prefix: 1,
      gateId: sourceId,
    })
  )[0];
  return gate ? { kind: "flow_gate", id: gate.id, gate } : null;
}
