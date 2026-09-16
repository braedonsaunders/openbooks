import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../lib/api/json";
import { guardAllocations } from "../../../../../lib/allocations-gate";
import {
  EnginePendingError,
  getDimensionValueLabels,
  previewManualDriverVector,
  vectorShares,
} from "../../../../../../engine/src/allocations/a8-shims.ts";
import { getDriver } from "../../../../../../engine/src/allocations/driver-admin.ts";

export const runtime = "nodejs";

const previewBodySchema = z.object({
  driverId: z.string(),
  periodId: z.string().optional(),
  date: z.string().optional(),
});

/**
 * Driver vector preview (A8): period picker (or exact date) → the
 * dimension value → weight table with exact shares. Manual drivers resolve
 * for real here; every other source kind reports `engine_pending` until
 * A2's resolvers land (HTTP 503, never a guessed vector).
 */
export async function POST(req: Request) {
  const gate = await guardAllocations("allocations.read");
  if (gate instanceof NextResponse) return gate;
  const parsedBody = await parseJsonBody(req, previewBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const { driverId, periodId, date } = parsedBody.data;
  if ((periodId === undefined) === (date === undefined)) {
    return NextResponse.json({ error: "provide exactly one of periodId, date" }, { status: 400 });
  }
  try {
    const asOf = periodId !== undefined ? { periodId } : { date: date! };
    const { vector, date: resolved } = await previewManualDriverVector(gate.user.orgId, driverId, asOf);
    const driver = await getDriver(gate.user.orgId, driverId);
    const labels = driver ? await getDimensionValueLabels(gate.user.orgId, driver.dimension, [...vector.keys()]) : new Map();
    const shares = vectorShares(vector);
    return NextResponse.json({
      driverId,
      date: resolved,
      rows: [...vector.entries()].map(([id, value]) => ({
        id,
        label: labels.get(id) ?? id,
        value,
        share: shares.get(id) ?? "0.0000",
      })),
    });
  } catch (error) {
    if (error instanceof EnginePendingError) {
      const status = error.ownerShard === "A8" ? 404 : 503;
      return NextResponse.json(
        { errorCode: "engine_pending", owner: error.ownerShard, detail: error.message },
        { status },
      );
    }
    throw error;
  }
}
