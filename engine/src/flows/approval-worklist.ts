import { pinnedTransactionExecutor } from "../platform/db.ts";
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
export type GateDecisionCapability = Awaited<ReturnType<typeof gateDecisionCapability>>;
/** Evaluates one gate's capability; a surface may pass a request-memoized gateDecisionCapability. */
export type GateCapabilityEvaluator = (
  gateId: string,
  userId: string,
) => Promise<GateDecisionCapability>;

/**
 * Native decision checks a worklist surface runs at once on the pool. Each
 * check is a short chain of reads, so a long worklist resolves in a fraction
 * of the serial time while leaving most of the connection pool to the rest
 * of the request. Inside a pinned transaction (one pg client) they run one
 * at a time.
 */
const CAPABILITY_CONCURRENCY = 4;

/**
 * The viewer's decision capability for each gate, through the native
 * per-gate check (gateDecisionCapability) and keyed by gate id. Checks run
 * concurrently up to CAPABILITY_CONCURRENCY; the first failure rejects the
 * whole read.
 */
export async function gateDecisionCapabilities(
  gateIds: readonly string[],
  userId: string,
  evaluate: GateCapabilityEvaluator = gateDecisionCapability,
): Promise<Map<string, GateDecisionCapability>> {
  const unique = [...new Set(gateIds)];
  const capabilities = new Map<string, GateDecisionCapability>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < unique.length) {
      const gateId = unique[next++]!;
      capabilities.set(gateId, await evaluate(gateId, userId));
    }
  };
  const lanes = pinnedTransactionExecutor() ? 1 : CAPABILITY_CONCURRENCY;
  await Promise.all(Array.from({ length: Math.min(lanes, unique.length) }, () => worker()));
  return capabilities;
}

export async function worklistGatesAwaitingAnotherApprover(
  orgId: string,
  userId: string,
  roles?: Iterable<string>,
  allowedSubsidiaryIds?: GateSubsidiaryScope,
  evaluate?: GateCapabilityEvaluator,
): Promise<string[]> {
  const gates = await worklistGates(orgId, userId, roles, allowedSubsidiaryIds);
  const capabilities = await gateDecisionCapabilities(
    gates.map((gate) => gate.id),
    userId,
    evaluate,
  );
  return gates.filter((gate) => capabilities.get(gate.id)?.sodBlocked === true).map((g) => g.id);
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
