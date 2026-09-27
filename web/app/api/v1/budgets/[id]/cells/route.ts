import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApplicationError } from "../../../../../../lib/application/errors";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../lib/api/v1-request";
import { updateBudgetCells, type BudgetCellWrite } from "../../../../../../lib/application/budgets";

const budgetCellBody = z.looseObject({
  accountId: z.string().min(1),
  periodId: z.string().min(1),
  subsidiaryId: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  locationId: z.string().nullable().optional(),
  classId: z.string().nullable().optional(),
  amount: z.string(),
  note: z.string().nullable().optional(),
});
const updateBudgetCellsBody = z.looseObject({
  expectedRevision: z.json().optional(),
  cells: z.array(budgetCellBody),
});

export const runtime = "nodejs";

/** POST /api/v1/budgets/:id/cells */
async function handleV1POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/budgets/:id/cells", async (_auth, context) => {
    const { id } = await params;
    const body = updateBudgetCellsBody.parse(await readV1JsonObject(request));
    if (typeof body.expectedRevision !== "number") {
      throw new ApplicationError("invalid_input", "expectedRevision must be the current scenario revision", 422);
    }
    const outcome = await updateBudgetCells(context, {
      scenarioId: id,
      expectedRevision: body.expectedRevision,
      cells: body.cells as BudgetCellWrite[],
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1POST(request, { params: Promise.resolve(params as never) } as never),
});
