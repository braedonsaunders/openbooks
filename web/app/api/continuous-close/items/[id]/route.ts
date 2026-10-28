import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";
import { can } from "../../../../../lib/authz";
import { readableContinuousCloseAgents } from "../../../../../lib/continuous-close";
import { loadWorkItemDetail } from "../../../../../lib/agents/work-item";
import { findingProposalCommand } from "../../../../../lib/agents/proposals";
import { listWorkItemNotes, loadWorkItemAssignment } from "../../../../../lib/agents/assignments";
import { notFound } from "@/lib/api/responses";
import { updateContinuousCloseItem } from "../../../../../lib/continuous-close/item-actions";

const itemParams = z.object({ id: z.string() });
const itemActionBody = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["review", "resolve", "dismiss", "reopen"]),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal("assign"),
    assigneeUserId: z.string().nullable().optional(),
    assigneeRole: z.string().nullable().optional(),
    dueAt: z.string().nullable().optional(),
  }),
  z.object({ action: z.literal("note"), body: z.string() }),
]);

export const GET = defineRoute({
  permission: "assistant.use",
  feature: "continuousClose",
  params: itemParams,
  handler: async ({ authz, params: { id } }) => {
    if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
    const item = await loadWorkItemDetail(
      authz.user.orgId,
      authz.user.id,
      id,
      readableContinuousCloseAgents(authz),
      authz.allowedSubsidiaryIds,
    );
    if (!item) return notFound("record");
    const canWrite = can(authz, "assistant.write");
    const [assignment, notes] = await Promise.all([
      loadWorkItemAssignment(authz, id),
      listWorkItemNotes(authz, id),
    ]);
    return NextResponse.json({
      ok: true,
      item,
      canWrite,
      proposal: canWrite ? findingProposalCommand(authz, item.summary) : null,
      assignment,
      notes,
    });
  },
});

export const PATCH = defineRoute({
  permission: "assistant.write",
  feature: "continuousClose",
  params: itemParams,
  body: itemActionBody,
  handler: async ({ authz, params: { id }, body }) => {
    if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
    const result = await updateContinuousCloseItem(authz, id, body);
    if (!result.ok) {
      if (result.error === "not_found") return notFound("record");
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({
      ok: true,
      ...(result.id ? { id: result.id } : {}),
      ...(result.status ? { status: result.status } : {}),
    });
  },
});
