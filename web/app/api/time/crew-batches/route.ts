import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { can } from "@/lib/authz";
import { createBatch } from "@openbooks/engine/hrm/field-time/crew";
import { listCrewBatches } from "@openbooks/engine/hrm/field-time/reads";
import { FieldTimeError } from "@openbooks/engine/hrm/field-time/errors";

export const runtime = "nodejs";

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status });
}

function fieldTime(error: unknown) {
  if (error instanceof FieldTimeError) return bad(error.message);
  throw error;
}

/** GET → batch list (?status=&projectId=). Time readers and foremen both land here. */
async function legacyGET(req: Request) {
  const read = await guardFeaturePermission("time.read", "fieldTime");
  const gate =
    read instanceof NextResponse
      ? await guardFeaturePermission("time.crew.enter", "fieldTime")
      : read;
  if (gate instanceof NextResponse) return gate;
  const url = new URL(req.url);
  try {
    const batches = await listCrewBatches(
      gate.user.orgId,
      {
        status: url.searchParams.get("status"),
        projectId: url.searchParams.get("projectId"),
      },
      { actorUserId: gate.user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
    );
    return NextResponse.json({ batches });
  } catch (error) {
    return fieldTime(error);
  }
}

/** A batch is opened for one foreman on one project day. */
const NEEDS = "A batch needs the foreman, the project and the worked day";

const createSchema = z.object({
  foremanPartyId: z.string({ error: NEEDS }).min(1, NEEDS),
  projectId: z.string({ error: NEEDS }).min(1, NEEDS),
  workedOn: z.string({ error: NEEDS }).min(1, NEEDS),
  notes: z.string().max(2000).nullable().optional(),
});

/** POST → open a batch for a foreman on a project day. */
async function legacyPOST(body: z.output<typeof createSchema>, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const { user } = gate;
  try {
    const id = await createBatch({
      orgId: user.orgId,
      actorUserId: user.id,
      foremanPartyId: body.foremanPartyId,
      projectId: body.projectId,
      workedOn: body.workedOn,
      notes: body.notes ?? null,
      canManageAll: can(gate, "time.manage"),
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json({ id });
  } catch (error) {
    return fieldTime(error);
  }
}

export const GET = defineRoute({
  public: "session",

  handler: ({ request }) => legacyGET(request),
});

export const POST = defineRoute({
  permission: "time.crew.enter",
  feature: "fieldTime",
  body: createSchema,
  invalidBodyStatus: 422,
  handler: ({ body, authz }) => legacyPOST(body, authz),
});
