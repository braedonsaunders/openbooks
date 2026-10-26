import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockActorIdentity } from "../organization/actor-permissions.ts";
import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FlowEventSource } from "@openbooks/forms-core";
import { db, pinnedTransactionExecutor } from "../platform/db.ts";
import { cancelDispatchRuns, dispatchFailureReason, FlowDispatchError } from "./dispatch-result.ts";
import { getFlowAdapter } from "./registry.ts";
import { parseFlowGraph, runRecordFlows, type RecordFlowsResult } from "./run.ts";

import type { FlowSubmissionPolicy } from "../platform/flow-submission-policy.ts";
export type SubmissionPolicy = FlowSubmissionPolicy;

/** Unattended channel receipts name their active source instead of impersonating a user. */
export async function assertSystemSubmissionSource(input: {
  orgId: string;
  subjectKind: string;
  subjectId: string;
  source: FlowEventSource;
}): Promise<void> {
  if (input.source === "schedule") return;
  if (input.source === "portal" && input.subjectKind === "rma") {
    if (!(await lockAndCheckOrgFeature(db, input.orgId, "customerPortal")))
      throw new FlowDispatchError(
        "Enable Customer portal in Company Settings → Features before submitting portal returns.",
      );
    const source = await db.execute<{ valid: boolean }>(
      sql`select public.flow_portal_return_source_valid(
      d.org_id,d.id,d.custom->'portalRequest') as valid from documents d
      where d.org_id=${input.orgId} and d.id=${input.subjectId}`,
      "objects",
    );
    if (source[0]?.valid) return;
  }
  if (input.source === "sync" && ["cash_sale", "cash_refund"].includes(input.subjectKind)) {
    if (
      !(await lockAndCheckOrgFeature(db, input.orgId, "salesChannels")) ||
      !(await lockAndCheckOrgFeature(db, input.orgId, "cashSales"))
    )
      throw new FlowDispatchError(
        "Enable Sales Channels and Cash sales in Company Settings → Features before submitting channel records.",
      );
    const channel = await db.execute(
      sql`select c.id from sales_channels c join documents d
      on d.org_id=c.org_id and d.source_channel_id=c.id and d.external_source=c.kind
      where d.org_id=${input.orgId} and d.id=${input.subjectId} and d.kind=${input.subjectKind}
        and nullif(btrim(d.external_ref),'') is not null and c.status='active'
      for share of c`,
      "objects",
    );
    if (channel.length === 1) return;
  }
  throw new FlowDispatchError(
    "The submission requires an authorized actor or its native unattended source.",
  );
}

export async function routeSubjectSubmission(input: {
  orgId: string;
  subjectKind: string;
  subjectId: string;
  actorId: string | null;
  source?: FlowEventSource;
  command?: Record<string, unknown>;
  event?:
    | { kind: "on_create"; source?: FlowEventSource }
    | { kind: "on_update"; source?: FlowEventSource; changedFields?: string[] };
}): Promise<{
  submissionId: string;
  gatingRunId: string | null;
  policy: SubmissionPolicy;
  dispatch: RecordFlowsResult;
}> {
  if (!pinnedTransactionExecutor()) {
    throw new Error("Submission routing requires the subject's active transaction.");
  }
  const source = input.event?.source ?? input.source ?? "ui";
  if (input.actorId === null) await assertSystemSubmissionSource({ ...input, source });
  await lockApprovalSubject(input.orgId, input.subjectKind, input.subjectId);
  const actor =
    input.actorId === null ? null : await lockActorIdentity(db, input.orgId, input.actorId);
  if (input.actorId !== null && !actor)
    throw new FlowDispatchError("The submission requires an active authorized acting identity.");
  const adapter = getFlowAdapter(input.subjectKind);
  if (!adapter) {
    throw new FlowDispatchError(
      "This record has no registered Flow subject; configure its native routing before submitting.",
    );
  }
  // Keep the policy set stable through routing and the subject transition.
  // Concurrent submissions share this lock; graph writes wait until commit.
  await db.execute(sql`lock table flows in share mode`);
  const context = await adapter.loadContext(input.subjectId);
  if (!context)
    throw new FlowDispatchError("The submission record is unavailable; reopen it before retrying.");
  context.values = {
    ...context.values,
    event_source: source,
    submissionActorHomeOrgId: actor?.orgId ?? null,
  };
  if (input.command)
    context.values = {
      ...context.values,
      command: input.command,
      commandAction: input.command.action ?? null,
    };
  const flows = await db.execute<{ id: string; graph: unknown }>(
    sql`
    select id,graph from flows where org_id=${input.orgId}
      and subject_kind=${input.subjectKind} and enabled order by id
  `,
    "objects",
  );
  for (const flow of flows) {
    if (!parseFlowGraph(flow.id, flow.graph))
      throw new FlowDispatchError(
        `Flow ${flow.id} has an invalid graph. Open Flows to correct it before submitting this record.`,
      );
  }
  const dispatch = await runRecordFlows(
    input.event ?? { kind: "on_submit", source: input.source ?? "ui" },
    input.subjectKind,
    input.subjectId,
    {
      orgId: input.orgId,
      userId: input.actorId,
      submissionCommand: input.command,
    },
  );
  if (
    dispatch.failed ||
    dispatch.runs.some((run) => run.status === "failed" || run.status === "cancelled") ||
    (dispatch.gatesCreated === 0 && dispatch.runs.some((run) => run.status !== "completed"))
  ) {
    await cancelDispatchRuns(
      input.orgId,
      dispatch.runs.map((run) => run.runId),
      { actorId: input.actorId },
    );
    throw new FlowDispatchError(
      dispatchFailureReason(dispatch) ??
        "Submission routing did not complete; review the record's Flows and retry.",
    );
  }
  const policy: SubmissionPolicy = {
    version: 1,
    trigger: input.event?.kind ?? "on_submit",
    kind: dispatch.gatesCreated > 0 ? "gated" : "ungated",
    flowIds: flows.map((flow) => flow.id),
    runIds: dispatch.runs.map((run) => run.runId).sort(),
  };
  const submissionId = randomUUID();
  const saved = await db.execute(
    sql`insert into flow_submissions(id,org_id,subject_kind,subject_id,actor_id,policy,context,graphs)
    values(${submissionId},${input.orgId},${input.subjectKind},${input.subjectId},${input.actorId},${JSON.stringify(policy)}::jsonb,
      ${JSON.stringify(context.values)}::jsonb,${JSON.stringify(flows)}::jsonb) returning id`,
    "objects",
  );
  if (saved.length !== 1)
    throw new FlowDispatchError(
      "The submission routing receipt was not saved; nothing was released.",
    );
  return {
    submissionId,
    gatingRunId: dispatch.runs.find((run) => run.gatesCreated > 0)?.runId ?? null,
    policy,
    dispatch,
  };
}
