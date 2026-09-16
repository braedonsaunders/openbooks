import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../lib/api/json";
import { guardAllocations } from "../../../../../lib/allocations-gate";
import {
  DriverAdminError,
  getDimensionValueLabels,
  vectorShares,
} from "../../../../../../engine/src/allocations/driver-admin.ts";
import {
  DriverNotAvailableError,
  previewDriverVector,
} from "../../../../../../engine/src/allocations/drivers.ts";
import { allocationServiceDeps } from "../../../../../../engine/src/allocations/service.ts";

export const runtime = "nodejs";

const previewBodySchema = z.object({
  driverId: z.string(),
  periodId: z.string().optional(),
  date: z.string().optional(),
});

/**
 * Driver vector preview (A8): period picker (or exact date) → the
 * dimension value → weight table with exact shares, resolved by A2's
 * previewDriverVector with the engine ReportDriverRunner for
 * report_definition drivers. Drivers that cannot be computed (no GL
 * activity, empty manual table, report refused) answer 422 with the
 * reason — never a guessed vector.
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
    const result = await previewDriverVector(
      { orgId: gate.user.orgId, driverId, asOf, actorId: gate.user.id },
      allocationServiceDeps(),
    );
    const labels = await getDimensionValueLabels(
      gate.user.orgId,
      result.driver.dimension,
      result.vector.map((entry) => entry.key),
    );
    const shares = vectorShares(new Map(result.vector.map((entry) => [entry.key, entry.value] as [string, string])));
    return NextResponse.json({
      driverId,
      // The temporal contract the vector was measured under (mode, window,
      // bound column) — null for non-report drivers.
      temporal: result.temporal,
      // The as-of actually read: the input date itself, or the period end
      // A2 resolves a period to (GL kinds aggregate the month window).
      date: periodId !== undefined ? result.to : date,
      rows: result.vector.map((entry) => ({
        id: entry.key,
        label: labels.get(entry.key) ?? entry.key,
        value: entry.value,
        share: shares.get(entry.key) ?? "0.0000",
      })),
    });
  } catch (error) {
    if (error instanceof DriverNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof DriverAdminError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
