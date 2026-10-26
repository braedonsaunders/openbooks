import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  createAdminFlow,
  listAdminFlows,
  listAdminFlowsForRestrictedScope,
} from "@openbooks/engine/flows/admin";
import { lockActorCommandAuthority } from "@openbooks/engine/organization/actor-command-authority";
import { assertUnrestrictedScope } from "@openbooks/engine/organization/scope";
import { boardAuthority, getBoard } from "@openbooks/engine/schedule-boards/boards";
import { scheduleBoardTimerGraph } from "@openbooks/engine/flows/schedule-board-adapter";
import { emptyAutomationGraph } from "@openbooks/forms-core";
import {
  flowSubjectProfileForOrg,
  lintFlowGraphForSubject,
  listFlowSubjectProfiles,
} from "@openbooks/engine/flows/module";
import type { Authz } from "@/lib/authz";

import { filterFlowRunSubjectsToScope } from "../../flows/_lib";

const FLOW_SUBJECT_KINDS = listFlowSubjectProfiles().map((profile) => profile.subjectKind) as [
  string,
  ...string[],
];
const requestBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    subjectKind: z.enum(FLOW_SUBJECT_KINDS),
    boardId: uuidString().optional(),
    schedulePreset: z.literal("weekday-morning-afternoon").optional(),
  })
  .superRefine((value, ctx) => {
    if (value.schedulePreset && !value.boardId)
      ctx.addIssue({
        code: "custom",
        message: "Choose a board before selecting a delivery timing preset.",
        path: ["schedulePreset"],
      });
    if (value.boardId && value.subjectKind !== "schedule_board")
      ctx.addIssue({
        code: "custom",
        message: "Board context is only valid for schedule board delivery.",
        path: ["boardId"],
      });
  });

export const runtime = "nodejs";

/**
 * Flows collection — list with run stats, create with an empty graph.
 * The graph itself is edited through PATCH /api/admin/flows/[id].
 */

async function legacyGET(gate: Authz) {
  if (gate.allowedSubsidiaryIds === null) {
    return NextResponse.json({ flows: await listAdminFlows(gate.user.orgId) });
  }
  // A subsidiary-restricted caller must not learn org-wide run counts or
  // last-run verdicts: the counts and last-run fields below are computed
  // over in-scope subjects only, with the same subject rule the retry
  // route enforces per run.
  const { flows, runs } = await listAdminFlowsForRestrictedScope(gate.user.orgId);
  const visible = await filterFlowRunSubjectsToScope(
    gate.user.orgId,
    gate.allowedSubsidiaryIds,
    runs.rows,
    gate,
  );
  const byFlow = new Map<string, typeof runs.rows>();
  for (const run of visible) {
    const list = byFlow.get(run.flowId) ?? [];
    list.push(run);
    byFlow.set(run.flowId, list);
  }
  return NextResponse.json({
    flows: flows.map((flow) => {
      const scoped = (byFlow.get(String(flow.id)) ?? []).sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );
      return {
        ...flow,
        run_count: String(scoped.length),
        last_run_status: scoped[0]?.status ?? null,
        last_run_at: scoped[0]?.startedAt ?? null,
      };
    }),
  });
}

export const GET = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  handler: async ({ authz }) => legacyGET(authz),
});

export const POST = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  scope: "unrestricted",
  body: requestBodySchema,
  handler: async ({ request, body, authz: routeAuthz }) =>
    withOrgTransaction(routeAuthz.user.orgId, async () => {
      const gate = routeAuthz;

      const user = gate.user;
      assertUnrestrictedScope(
        await lockActorCommandAuthority(db, user.orgId, user.id, null, "flows.manage"),
      );

      const name = String(body.name ?? "").trim();
      if (!name || name.length > 200) {
        return NextResponse.json({ error: "name required (max 200 chars)" }, { status: 400 });
      }
      const subjectKind = String(body.subjectKind ?? "");
      if (!listFlowSubjectProfiles().some((p) => p.subjectKind === subjectKind)) {
        return NextResponse.json(
          { error: `unknown subject kind "${subjectKind}"` },
          { status: 400 },
        );
      }

      const board = body.boardId
        ? await getBoard({ orgId: user.orgId, actorId: user.id }, body.boardId)
        : null;
      if (board) await boardAuthority({ orgId: user.orgId, actorId: user.id }, board, "manage");
      const graph = board
        ? scheduleBoardTimerGraph(board.id, board.timeZone, !!body.schedulePreset)
        : emptyAutomationGraph();
      // A new flow starts enabled exactly when its initial graph validates:
      // the save path refuses to leave an enabled flow warning-bearing, so
      // create-time enablement must apply the same lint or a fresh flow could
      // never be enabled without edits. An empty draft graph stays disabled
      // (it cannot fire), and the designer banner says so.
      const profile = await flowSubjectProfileForOrg(user.orgId, subjectKind);
      const lint = lintFlowGraphForSubject(subjectKind, graph, profile ?? undefined);
      const id = await createAdminFlow({
        orgId: user.orgId,
        actorId: user.id,
        requestId: request.headers.get("X-Request-Id"),
        name,
        subjectKind,
        enabled: lint.ok,
        graph,
      });
      return NextResponse.json({ id });
    }),
});
