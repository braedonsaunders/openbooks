import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../../../lib/application/errors";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../lib/api/v1-request";
import { updateBudgetCells, type BudgetCellWrite } from "../../../../../../lib/application/budgets";

export const runtime = "nodejs";

/** POST /api/v1/budgets/:id/cells */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/budgets/:id/cells", async (_auth, context) => {
    const { id } = await params;
    const body = await readV1JsonObject(request);
    if (typeof body.expectedRevision !== "number") {
      throw new ApplicationError("invalid_input", "expectedRevision must be the current scenario revision", 422);
    }
    const outcome = await updateBudgetCells(context, {
      scenarioId: id,
      expectedRevision: body.expectedRevision,
      cells: Array.isArray(body.cells) ? body.cells as BudgetCellWrite[] : [],
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}
