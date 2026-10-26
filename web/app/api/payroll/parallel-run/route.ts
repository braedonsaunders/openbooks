import { uuidId } from "@/lib/api/json-schema";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { PayrollError } from "@openbooks/engine/payroll/error";
import {
  comparablePayRuns,
  comparableSlots,
  listParallelRunScope,
  parallelComparisons,
  parallelRunInputsInScope,
  parallelTolerances,
  priorRegisters,
  runParallelComparison,
  suggestedPayRunForRegister,
} from "@openbooks/engine/payroll/parallel-run-store";
import { isUuid } from "../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.strictObject({
  registerId: uuidId,
  payRunDocumentId: uuidId,
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Parallel run: prior-provider reconciliation.
 *
 * Reading is `payroll.read`; running a comparison is `payroll.manage`, because
 * a filed comparison is audit evidence with an actor on it, not a query.
 *
 * Every rule — the classification, the zero-tolerance default, the refusal to
 * report a clean result off an empty or non-intersecting population, and the
 * self-check that must pass before anything is stored — lives in
 * engine/src/payroll/parallel-run.ts and its store. This route only translates
 * HTTP, so a second caller cannot reach a different verdict.
 */

export const GET = defineRoute({
  permission: "payroll.read",
  feature: "payroll",
  handler: async ({ request: req, authz: gate }) => {
    const orgId = gate.user.orgId;
    const params = new URL(req.url).searchParams;
    const registerId = params.get("registerId");

    const { registerIds, runIds, comparisonIds } = await listParallelRunScope(
      orgId,
      gate.allowedSubsidiaryIds,
    );

    const [registers, runs, comparisons, tolerances, slots] = await Promise.all([
      priorRegisters(orgId),
      comparablePayRuns(orgId),
      parallelComparisons(orgId, {
        registerId: registerId && isUuid(registerId) ? registerId : undefined,
      }),
      parallelTolerances(orgId),
      comparableSlots(orgId),
    ]);

    const suggestedRun =
      registerId && isUuid(registerId) ? await suggestedPayRunForRegister(orgId, registerId) : null;
    const visibleSuggested =
      suggestedRun &&
      (runIds === null || runIds.has(suggestedRun)) &&
      (registerIds === null || registerIds.has(registerId ?? ""))
        ? suggestedRun
        : null;

    return NextResponse.json({
      registers:
        registerIds === null ? registers : registers.filter((row) => registerIds.has(row.id)),
      runs: runIds === null ? runs : runs.filter((row) => runIds.has(row.documentId)),
      comparisons:
        comparisonIds === null
          ? comparisons
          : comparisons.filter((row) => comparisonIds.has(row.id)),
      tolerances,
      slots: slots.map((slot) => ({
        fieldKey: slot.fieldKey,
        kind: slot.kind,
        slot: slot.slot,
        label: slot.label,
      })),
      suggestedRun: visibleSuggested,
    });
  },
});

export const POST = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  body: requestBodySchema,
  handler: async ({ authz: gate, body }) => {
    const inScope = await parallelRunInputsInScope(
      gate.user.orgId,
      gate.allowedSubsidiaryIds,
      body.registerId,
      body.payRunDocumentId,
    );
    if (!inScope) return notFound("record");

    try {
      const { comparisonId, comparison } = await runParallelComparison({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        registerId: body.registerId,
        payRunDocumentId: body.payRunDocumentId,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      // The result is returned in full, including `blockedReason` and the
      // tolerances in force. A caller that only reads `status` still cannot
      // mistake "nothing to compare" for "no differences" — they are different
      // values of the same field.
      return NextResponse.json({ comparisonId, comparison });
    } catch (error) {
      if (error instanceof PayrollError) {
        return apiErrorResponse(error, { safeStatus: 422 });
      }
      throw error;
    }
  },
});
