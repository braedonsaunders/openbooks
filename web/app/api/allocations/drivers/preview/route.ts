import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  DriverAdminError,
  getDimensionValueLabels,
  vectorShares,
} from "@openbooks/engine/allocations/driver-admin";
import {
  DriverNotAvailableError,
  previewDriverVector,
} from "@openbooks/engine/allocations/drivers";
import { allocationServiceDeps } from "@openbooks/engine/allocations/service";

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
async function legacyPOST(body: z.output<typeof previewBodySchema>, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  const { driverId, periodId, date } = body;
  if ((periodId === undefined) === (date === undefined)) {
    return NextResponse.json({ error: "provide exactly one of periodId, date" }, { status: 400 });
  }
  try {
    const asOf = periodId !== undefined ? { periodId } : { date: date! };
    const result = await previewDriverVector(
      {
        orgId: gate.user.orgId,
        driverId,
        asOf,
        actorId: gate.user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      },
      allocationServiceDeps(),
    );
    const labels = await getDimensionValueLabels(
      gate.user.orgId,
      result.driver.dimension,
      result.vector.map((entry) => entry.key),
    );
    const shares = vectorShares(
      new Map(result.vector.map((entry) => [entry.key, entry.value] as [string, string])),
    );
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
      return apiErrorResponse(error, { safeStatus: 422 });
    }
    if (error instanceof DriverAdminError) {
      return apiErrorResponse(error);
    }
    throw error;
  }
}

export const POST = defineRoute({
  permission: "allocations.read",
  feature: "allocations",
  scope: "unrestricted",
  body: previewBodySchema,
  handler: ({ authz, body }) => legacyPOST(body, authz),
});
