import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { getBatchDetail } from "@openbooks/engine/hrm/field-time/reads";
import { FieldTimeError } from "@openbooks/engine/hrm/field-time/errors";
import { handleCrewBatchAction, type CrewBatchAction } from "@/lib/field-time/crew-batch-write";

export const runtime = "nodejs";

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status });
}

function fieldTime(error: unknown) {
  if (error instanceof FieldTimeError) return bad(error.message);
  throw error;
}

async function batchGate(perm: "time.crew.enter" | "time.read" | "time.approve" | "time.manage") {
  return guardFeaturePermission(perm, "fieldTime");
}

/** GET → batch detail with lines and append-only history. */
async function legacyGET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const read = await batchGate("time.read");
  const gate = read instanceof NextResponse ? await batchGate("time.crew.enter") : read;
  if (gate instanceof NextResponse) return gate;
  try {
    return NextResponse.json(
      await getBatchDetail(
        gate.user.orgId,
        {
          actorUserId: gate.user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        },
        id,
      ),
    );
  } catch (error) {
    return fieldTime(error);
  }
}

const lineSchema = z.object({
  employeePartyId: z.string().min(1),
  hours: z.string().min(1),
  timeTypeId: z.string().nullable().optional(),
  projectTaskId: z.string().nullable().optional(),
  costCodeRef: z.string().max(80).nullable().optional(),
  equipmentId: z.string().nullable().optional(),
  equipmentHours: z.string().nullable().optional(),
  memo: z.string().max(2000).nullable().optional(),
});

const LINES_NEEDS = "Lines need the worker and hours on every row";

/**
 * The six batch actions as one body. The action names the branch and
 * the branch names what it needs, so an unknown action and a missing
 * reason are both refused here with the words the foreman reads.
 */
const batchActionBody = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("lines"),
      lines: z.array(lineSchema, { error: LINES_NEEDS }).max(500),
    }),
    z.object({ action: z.literal("submit"), signerName: z.string().nullish() }),
    z.object({ action: z.literal("withdraw"), reason: z.string().nullish() }),
    z.object({ action: z.literal("post") }),
  ],
  { error: "Unknown batch action — use lines, submit, withdraw or post" },
);

export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: ({ request, params }) => legacyGET(request, { params: Promise.resolve(params) }),
});

export const POST = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  body: batchActionBody,
  invalidBodyStatus: 422,
  handler: async ({ params, body }) => {
    const requiredPermission = body.action === "post" ? "time.manage" : "time.crew.enter";
    const gate = await batchGate(requiredPermission);
    if (gate instanceof NextResponse) return gate;
    return handleCrewBatchAction({
      authz: gate,
      batchId: params.id,
      body: body as CrewBatchAction,
    });
  },
});
