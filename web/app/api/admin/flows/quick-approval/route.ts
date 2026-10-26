import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import {
  buildQuickApprovalGraph,
  flowSubjectProfileForOrg,
  lintFlowGraphForSubject,
  listFlowSubjectProfiles,
  quickApprovalAmountField,
  validateFlowSubjectScopeRefs,
} from "@openbooks/engine/flows/module";
import type { Authz } from "@/lib/authz";
import {
  activeUserIds,
  insertQuickApprovalFlow,
  readQuickApprovalSetup,
} from "../../../../../lib/flows/quick-approval-store";
import { flowSubjectFeatureRefusal } from "../../../../../lib/flows/subject-availability";

export const runtime = "nodejs";

/**
 * One-step approval setup — the four-click path to a governed record kind.
 *
 * POST builds a complete, wired, ENABLED flow (on_submit trigger → optional
 * threshold condition → approval gate) through the same lint the designer
 * save path enforces, with the same audited insert the New Flow path
 * writes. GET reports the setup state for one subject kind (the quick flow
 * if present, plus the approver choices) so the dialog can offer removal —
 * which disables the flow through PATCH /api/admin/flows/[id], never a
 * delete, preserving execution history.
 */

const FLOW_SUBJECT_KINDS = listFlowSubjectProfiles().map((profile) => profile.subjectKind) as [
  string,
  ...string[],
];

const approverSchema = z.union([
  z.object({ type: z.literal("user"), userId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("role"), role: z.string().min(1).max(64) }),
]);

const requestBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  subjectKind: z.enum(FLOW_SUBJECT_KINDS),
  threshold: z.number().finite().min(0).max(1_000_000_000_000).optional(),
  approver: approverSchema,
  preventSelfApproval: z.boolean().optional(),
  /** Legal entities the approval applies to; omitted applies organization-wide. */
  subsidiaryIds: z.array(uuidString()).min(1).max(100).optional(),
});

async function legacyGET(req: Request, gate: Authz) {
  const subjectKind = new URL(req.url).searchParams.get("subjectKind") ?? "";
  if (!listFlowSubjectProfiles().some((profile) => profile.subjectKind === subjectKind)) {
    return NextResponse.json({ error: `unknown subject kind "${subjectKind}"` }, { status: 400 });
  }
  const profile = await flowSubjectProfileForOrg(gate.user.orgId, subjectKind);
  if (!profile) {
    return NextResponse.json({ error: `unknown subject kind "${subjectKind}"` }, { status: 400 });
  }
  const setup = await readQuickApprovalSetup(gate.user.orgId, subjectKind);
  const flow = setup.flow;
  const flowGraph = (flow?.graph ?? null) as { subjectScope?: { subsidiaryIds?: unknown } } | null;
  const flowSubsidiaryIds = Array.isArray(flowGraph?.subjectScope?.subsidiaryIds)
    ? flowGraph.subjectScope.subsidiaryIds.map(String)
    : [];
  return NextResponse.json({
    flow: flow
      ? {
          id: String(flow.id),
          name: String(flow.name),
          enabled: Boolean(flow.enabled),
          updatedAt: String(flow.updated_at),
          subsidiaryIds: flowSubsidiaryIds,
        }
      : null,
    subsidiaries: setup.subsidiaries.map((subsidiary) => ({
      id: String(subsidiary.id),
      name: String(subsidiary.name),
    })),
    users: setup.users.map((user) => ({
      id: String(user.id),
      name: String(user.name),
      email: String(user.email),
    })),
    roles: setup.roles.map((role) => ({
      key: String(role.key),
      name: String(role.name),
    })),
    amountField: quickApprovalAmountField(profile),
    subjectLabel: profile.label,
  });
}

export const GET = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  handler: async ({ request, authz }) => legacyGET(request, authz),
});

export const POST = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  scope: "unrestricted",
  body: requestBodySchema,
  handler: async ({ request, body, authz: routeAuthz }) => {
    const gate = routeAuthz;
    const user = gate.user;

    const profile = await flowSubjectProfileForOrg(user.orgId, body.subjectKind);
    if (!profile) {
      return NextResponse.json(
        { error: `unknown subject kind "${body.subjectKind}"` },
        { status: 400 },
      );
    }
    const approverIds = body.approver.type === "user" ? await activeUserIds(user.orgId) : undefined;
    const built = buildQuickApprovalGraph(
      profile,
      {
        approver: body.approver,
        ...(body.threshold !== undefined ? { threshold: body.threshold } : {}),
        ...(body.preventSelfApproval !== undefined
          ? { preventSelfApproval: body.preventSelfApproval }
          : {}),
        ...(body.subsidiaryIds !== undefined ? { subsidiaryIds: body.subsidiaryIds } : {}),
      },
      approverIds,
    );
    if (!built.ok) {
      return NextResponse.json({ error: built.message, code: built.code }, { status: 400 });
    }
    // Selected legal entities are native references, not free text: each
    // must belong to this organization and sit inside the writer's own
    // subsidiary ceiling (this route already requires unrestricted scope,
    // and the check stays explicit for every managed write).
    const scopeRefusal = await validateFlowSubjectScopeRefs(
      user.orgId,
      built.graph,
      gate.allowedSubsidiaryIds,
    );
    if (scopeRefusal) {
      return NextResponse.json({ error: scopeRefusal, code: "bad-subject-scope" }, { status: 400 });
    }
    // The setup promises an enabled flow: prove the generated graph passes
    // the same lint the designer save path enforces before writing anything.
    const lint = lintFlowGraphForSubject(body.subjectKind, built.graph, profile);
    if (!lint.ok) {
      return NextResponse.json({ errors: lint.errors }, { status: 400 });
    }
    const name = body.name?.trim() || `Approval: ${profile.label}`;
    let id: string;
    try {
      id = await insertQuickApprovalFlow({
        orgId: user.orgId,
        actorId: user.id,
        name,
        subjectKind: body.subjectKind,
        graph: built.graph,
        requestId: request.headers.get("X-Request-Id"),
      });
    } catch (error) {
      const refusal = flowSubjectFeatureRefusal(error);
      if (refusal) return refusal;
      throw error;
    }
    return NextResponse.json({ id });
  },
});
