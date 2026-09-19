import type { FlowExecCtx } from "./types.ts";

/**
 * Web-owned approval releases.
 *
 * Most flow subjects can release entirely inside the engine. A few product
 * records orchestrate services that intentionally live in the web package
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
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  ctx: FlowExecCtx;
}

export type FlowApprovalReleaseHandler = (
  args: FlowApprovalReleaseArgs,
) => Promise<void>;

type HookRuntime = typeof globalThis & {
  __openbooksFlowApprovalReleaseHandlers?: Map<
    string,
    FlowApprovalReleaseHandler
  >;
};

const runtime = globalThis as HookRuntime;
const handlers =
  (runtime.__openbooksFlowApprovalReleaseHandlers ??= new Map());

export function registerFlowApprovalReleaseHandler(
  subjectKind: string,
  handler: FlowApprovalReleaseHandler,
): void {
  handlers.set(subjectKind, handler);
}

export async function releaseFlowApproval(
  args: FlowApprovalReleaseArgs,
): Promise<void> {
  const handler = handlers.get(args.subjectKind);
  if (!handler) {
    throw new Error(
      `approval release handler for "${args.subjectKind}" is not registered`,
    );
  }
  await handler(args);
}
