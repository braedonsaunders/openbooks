import { sql } from "drizzle-orm";
import { db, pinnedTransactionExecutor } from "./db.ts";
import type { FlowSubmissionPolicy } from "./flow-submission-policy.ts";

export interface ApprovalSubmission {
  orgId: string;
  actorId: string;
  subjectKind: string;
  subjectId: string;
  command?: Record<string, unknown>;
}
export interface ApprovalRoutingReceipt {
  submissionId: string;
  gatingRunId: string | null;
  policy: FlowSubmissionPolicy;
}
type ApprovalRouter = (input: ApprovalSubmission) => Promise<ApprovalRoutingReceipt>;
type DecisionReader = (input: ApprovalDecision) => Promise<ApprovalDecisionEvidence | null>;
type ApprovalCanceller = (input: ApprovalCancellation) => Promise<void>;
type CommandRouter = (input: NativeApprovalCommand) => Promise<boolean>;
type SubjectFence = (orgId: string, subjectId: string) => Promise<void>;
type RoutingRuntime = typeof globalThis & {
  __openbooksApprovalRouting?: {
    router?: ApprovalRouter;
    decisionReader?: DecisionReader;
    canceller?: ApprovalCanceller;
    commandRouter?: CommandRouter;
    subjectFences?: Map<string, SubjectFence>;
  };
};
const runtime = globalThis as RoutingRuntime;
const routing = (runtime.__openbooksApprovalRouting ??= {});

/** Composition supplies the sole tenant Flow engine; absence grants no release authority. */
export function registerApprovalRouter(handler: ApprovalRouter): void {
  routing.router = handler;
}
export async function routeNativeApproval(
  input: ApprovalSubmission,
): Promise<ApprovalRoutingReceipt> {
  if (!routing.router)
    throw new Error("Native Flow routing is unavailable. Retry after application initialization.");
  return routing.router(input);
}

export interface ApprovalDecision {
  orgId: string;
  actorId: string;
  subjectKind: string;
  subjectId: string;
  outcome: "approved" | "rejected";
  approvalRunId?: string;
}
export interface ApprovalDecisionEvidence {
  allowsSelfApproval: boolean;
}
export function registerApprovalDecisionReader(handler: DecisionReader): void {
  routing.decisionReader = handler;
}
export async function readNativeApprovalDecision(
  input: ApprovalDecision,
): Promise<ApprovalDecisionEvidence | null> {
  if (!routing.decisionReader)
    throw new Error(
      "Native Flow decision verification is unavailable. Retry after application initialization.",
    );
  return routing.decisionReader(input);
}

type ApprovalCancellation = Omit<ApprovalSubmission, "actorId"> & { actorId: string | null };
export function registerApprovalCanceller(handler: ApprovalCanceller): void {
  routing.canceller = handler;
}
export async function cancelNativeApprovals(input: ApprovalCancellation): Promise<void> {
  if (!routing.canceller)
    throw new Error(
      "Native Flow cancellation is unavailable. Retry after application initialization.",
    );
  await routing.canceller(input);
}

export interface NativeApprovalCommand extends ApprovalSubmission {
  command: Record<string, unknown>;
  approvalRunId?: string;
}
export function registerApprovalCommandRouter(handler: CommandRouter): void {
  routing.commandRouter = handler;
}
/** True means configured gates are pending; false permits the owning native command to continue. */
export async function requestNativeCommandApproval(input: NativeApprovalCommand): Promise<boolean> {
  if (!routing.commandRouter)
    throw new Error(
      "Native Flow command routing is unavailable. Retry after application initialization.",
    );
  return routing.commandRouter(input);
}

/** Composition supplies aggregate fences that must precede a subject's own lock. */
export function registerApprovalSubjectFence(kind: string, fence: SubjectFence): void {
  (routing.subjectFences ??= new Map()).set(kind, fence);
}

/** Acquire before subject rows, Flow runs, or gates; all policies share one transaction fence. */
export async function lockApprovalSubject(
  orgId: string,
  subjectKind: string,
  subjectId: string,
): Promise<void> {
  if (!pinnedTransactionExecutor())
    throw new Error("Approval subject locking requires the native transaction.");
  await routing.subjectFences?.get(subjectKind)?.(orgId, subjectId);
  const identity = JSON.stringify([
    "openbooks:flow-subject-decision",
    orgId,
    subjectKind,
    subjectId,
  ]);
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity},0))`);
}
