import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { getRuleVersion, updateDraftVersion } from "@openbooks/engine/allocations/runtime";
import { allocationWriteErrorResponse, requireRevision, requireRuleId } from "../../../../_lib.ts";
import { notFound } from "@/lib/api/responses";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const bodyObjectSchema = z
  .object({
    expectedRevision: z.string().min(1),
    effectiveFrom: z.string().optional(),
    effectiveTo: z.string().nullable().optional(),
    bookScope: z.enum(["primary", "all_posting", "books"]).optional(),
    bookIds: z.array(uuidString()).optional(),
    documentKinds: z.array(z.string()).nullable().optional(),
    accountScope: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("any") }).strict(),
        z
          .object({
            kind: z.literal("accounts"),
            accountIds: z.array(uuidString()),
          })
          .strict(),
        z
          .object({
            kind: z.literal("account_group"),
            dimension: z.string().min(1),
            groupKey: z.string().min(1),
          })
          .strict(),
      ])
      .optional(),
    dimensionFilters: z
      .object({
        departmentIds: z.array(uuidString()).optional(),
        locationIds: z.array(uuidString()).optional(),
        classIds: z.array(uuidString()).optional(),
        projectIds: z.array(uuidString()).optional(),
        subsidiaryIds: z.array(uuidString()).optional(),
        partyIds: z.array(uuidString()).optional(),
        itemIds: z.array(uuidString()).optional(),
        payComponentIds: z.array(uuidString()).optional(),
        payrollEmployeeIds: z.array(uuidString()).optional(),
        timeTypeIds: z.array(uuidString()).optional(),
        payrollExpensesOnly: z.boolean().optional(),
        extraDims: z.record(z.string(), z.array(z.string())).optional(),
        requireUntagged: z.array(z.enum(["department", "location", "class", "project"])).optional(),
      })
      .strict()
      .optional(),
    applyPolicy: z.enum(["automatic", "suggest", "manual"]).optional(),
    sourceMeasure: z.enum(["period_activity", "period_end_balance", "ytd_activity"]).optional(),
    basisKind: z.enum(["fixed_percent", "driver", "stepped"]).optional(),
    driverId: uuidString().nullable().optional(),
    driverAsOf: z.enum(["period", "document_date", "prior_period"]).optional(),
    // Basis configuration is an opaque JSON column whose shape depends on basisKind.
    basisConfig: z.record(z.string(), z.json()).optional(),
    targetKind: z.enum(["explicit", "dynamic"]).optional(),
    dynamicTarget: z
      .object({
        dimension: z
          .string()
          .regex(/^(department|location|class|project|subsidiary|extra:.+)$/)
          .optional(),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        minWeight: z.string().optional(),
        targetAccountId: uuidString().nullable().optional(),
      })
      .strict()
      .optional(),
    impact: z.enum(["reclass", "net_zero_pair", "report_only"]).optional(),
    offsetAccountId: uuidString().nullable().optional(),
    residualPolicy: z
      .enum(["largest_share", "first_target", "last_target", "explicit_target"])
      .optional(),
    residualTargetId: uuidString().nullable().optional(),
    solveMethod: z.enum(["sequential", "simultaneous"]).optional(),
    runPolicy: z.enum(["manual", "auto_preview", "auto_post"]).optional(),
    runOffsetDays: z.number().int().optional(),
    memoTemplate: z.string().nullable().optional(),
    lineDescriptionTemplate: z.string().nullable().optional(),
  })
  .strict();

/** Draft-editable version fields — everything outside A1's frozen set. */
const DRAFT_FIELDS = [
  "effectiveFrom",
  "effectiveTo",
  "bookScope",
  "bookIds",
  "documentKinds",
  "accountScope",
  "dimensionFilters",
  "applyPolicy",
  "sourceMeasure",
  "basisKind",
  "driverId",
  "driverAsOf",
  "basisConfig",
  "targetKind",
  "dynamicTarget",
  "impact",
  "offsetAccountId",
  "residualPolicy",
  "residualTargetId",
  "solveMethod",
  "runPolicy",
  "runOffsetDays",
  "memoTemplate",
  "lineDescriptionTemplate",
] as const;

/** One version with its explicit targets (Versions tab + drawer). */
async function legacyGET(
  _req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const { id, versionId } = await params;
  const ruleId = requireRuleId(id);
  if (ruleId instanceof NextResponse) return ruleId;
  const versionParam = requireRuleId(versionId);
  if (versionParam instanceof NextResponse) return versionParam;
  try {
    const found = await getRuleVersion(gate.user.orgId, versionParam, gate.allowedSubsidiaryIds);
    if (found.version.ruleId !== ruleId) {
      return notFound("record");
    }
    return NextResponse.json(found);
  } catch (error) {
    return allocationWriteErrorResponse(error);
  }
}

/** Edit a draft version. Only whitelisted definition fields; `expectedRevision` required. */
async function legacyPATCH(
  { params }: { params: Promise<{ id: string; versionId: string }> },
  body: z.output<typeof bodyObjectSchema>,
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const { id, versionId } = await params;
  const ruleId = requireRuleId(id);
  if (ruleId instanceof NextResponse) return ruleId;
  const versionParam = requireRuleId(versionId);
  if (versionParam instanceof NextResponse) return versionParam;
  const patchBody = body as Record<string, unknown> & {
    expectedRevision: string;
  };
  const revision = requireRevision(patchBody);
  if (revision instanceof NextResponse) return revision;
  const patch: Record<string, unknown> = {
    orgId: gate.user.orgId,
    expectedRevision: revision,
    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
  };
  for (const key of DRAFT_FIELDS) {
    if (patchBody[key] !== undefined) patch[key] = patchBody[key];
  }
  try {
    const current = await getRuleVersion(gate.user.orgId, versionParam, gate.allowedSubsidiaryIds);
    if (current.version.ruleId !== ruleId) {
      return notFound("record");
    }
    const updated = await updateDraftVersion(
      versionParam,
      patch as Parameters<typeof updateDraftVersion>[1],
      { actorId: gate.user.id },
    );
    return NextResponse.json({
      version: { ...updated.version, revision: updated.revision },
    });
  } catch (error) {
    return allocationWriteErrorResponse(error);
  }
}

export const GET = defineRoute({
  permission: "allocations.read",
  feature: "allocations",
  params: z.object({ id: z.string(), versionId: z.string() }),
  handler: ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const PATCH = defineRoute({
  permission: "allocations.manage",
  feature: "allocations",
  params: z.object({
    id: z.string().refine((value) => isUuid(value)),
    versionId: z.string().refine((value) => isUuid(value)),
  }),
  invalidParamsNotFound: "record",
  body: bodyObjectSchema,
  handler: ({ params, authz, body }) =>
    legacyPATCH({ params: Promise.resolve(params) }, body, authz),
});
