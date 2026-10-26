import type { FlowExecCtx } from "./types.ts";

/**
 * Registered approval releases.
 *
 * Most flow subjects can release entirely inside the engine. Engine-owned
 * releases (allocation runs, close runs, comp cycles, change requests,
 * leave requests) register from installEngineSeams. A few product records
 * orchestrate services that intentionally live in the web package
 * (field-ticket rate resolution and project-charge materialization). The
 * engine cannot import web, so the node server registers those handlers at
 * boot, exactly like the existing flow PDF renderer.
 *
 * The handler executes inside decideGate's withOrg transaction. Throwing
 * therefore rolls back the gate decision, every financial side effect, and
 * the record status together.
 */
export interface FlowApprovalReleaseArgs {
  subjectKind: string;
  command?: Record<string, unknown>;
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  approvalRunId?: string;
  ctx: FlowExecCtx;
}

export type FlowApprovalReleaseHandler = (args: FlowApprovalReleaseArgs) => Promise<void>;

type HookRuntime = typeof globalThis & {
  __openbooksFlowApprovalReleaseHandlers?: Map<string, FlowApprovalReleaseHandler>;
};

const runtime = globalThis as HookRuntime;
const handlers = (runtime.__openbooksFlowApprovalReleaseHandlers ??= new Map());

export function registerFlowApprovalReleaseHandler(
  subjectKind: string,
  handler: FlowApprovalReleaseHandler,
): void {
  handlers.set(subjectKind, handler);
}

/** Whether a release handler is registered for this subject kind. */
export function hasFlowApprovalReleaseHandler(subjectKind: string): boolean {
  return handlers.has(subjectKind);
}

export async function releaseFlowApproval(args: FlowApprovalReleaseArgs): Promise<void> {
  const handler = handlers.get(args.subjectKind);
  if (!handler) {
    throw new Error(
      `approval release handler for "${args.subjectKind}" is not registered; ` +
        `engine handlers install via installEngineSeams(), product handlers at web boot`,
    );
  }
  await handler(args);
}

/** Resume a subject's own submission command after its same flow run has
 * completed routing. This is distinct from a human gate decision. */
export interface FlowSubmissionResumeArgs {
  subjectKind: string;
  subjectId: string;
  runId: string;
  mode: "gated" | "automatic";
  ctx: FlowExecCtx;
}
export type FlowSubmissionResumeHandler = (
  args: FlowSubmissionResumeArgs,
) => Promise<{ status: string }>;
const submissionRuntime = globalThis as typeof globalThis & {
  __openbooksFlowSubmissionResumeHandlers?: Map<string, FlowSubmissionResumeHandler>;
};
const submissionHandlers = (submissionRuntime.__openbooksFlowSubmissionResumeHandlers ??=
  new Map());

export function registerFlowSubmissionResumeHandler(
  subjectKind: string,
  handler: FlowSubmissionResumeHandler,
): void {
  submissionHandlers.set(subjectKind, handler);
}
export function hasFlowSubmissionResumeHandler(subjectKind: string): boolean {
  return submissionHandlers.has(subjectKind);
}
export async function resumeFlowSubmission(
  args: FlowSubmissionResumeArgs,
): Promise<{ status: string }> {
  const handler = submissionHandlers.get(args.subjectKind);
  if (!handler)
    throw new Error(
      `Submission resume handler for "${args.subjectKind}" is not registered; install the owning native subject's engine seam before retrying`,
    );
  return handler(args);
}

/** Native commands with a pending projection restore it when their submission is recalled. */
type CommandWithdrawal = {
  orgId: string;
  actorId: string;
  subjectKind: string;
  subjectId: string;
  reason: string;
};
const withdrawalRuntime = globalThis as typeof globalThis & {
  __openbooksFlowCommandWithdrawalHandlers?: Map<
    string,
    (input: CommandWithdrawal) => Promise<void>
  >;
};
const withdrawalHandlers = (withdrawalRuntime.__openbooksFlowCommandWithdrawalHandlers ??=
  new Map());
export function registerFlowCommandWithdrawalHandler(
  kind: string,
  handler: (input: CommandWithdrawal) => Promise<void>,
): void {
  withdrawalHandlers.set(kind, handler);
}
export async function withdrawFlowCommandSubject(input: CommandWithdrawal): Promise<void> {
  await withdrawalHandlers.get(input.subjectKind)?.(input);
}
