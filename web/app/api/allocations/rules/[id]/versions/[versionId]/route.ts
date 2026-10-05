import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { parseJsonBody } from '@/lib/api/json';
import { NextResponse } from 'next/server'
import { getRuleVersion, updateDraftVersion } from '../../../../../../../../engine/src/allocations/index.ts'
import { allocationWriteErrorResponse, requireRevision, requireRuleId } from '../../../../_lib.ts'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

const bodyObjectSchema = z.object({
  expectedRevision: z.string().min(1),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().nullable().optional(),
  bookScope: z.enum(['primary', 'all_posting', 'books']).optional(),
  bookIds: z.array(z.string().uuid()).optional(),
  documentKinds: z.array(z.string()).nullable().optional(),
  accountScope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('any') }).strict(),
    z.object({ kind: z.literal('accounts'), accountIds: z.array(z.string().uuid()) }).strict(),
    z.object({ kind: z.literal('account_group'), dimension: z.string().min(1), groupKey: z.string().min(1) }).strict(),
  ]).optional(),
  dimensionFilters: z.object({
    departmentIds: z.array(z.string().uuid()).optional(),
    locationIds: z.array(z.string().uuid()).optional(),
    classIds: z.array(z.string().uuid()).optional(),
    projectIds: z.array(z.string().uuid()).optional(),
    subsidiaryIds: z.array(z.string().uuid()).optional(),
    partyIds: z.array(z.string().uuid()).optional(),
    itemIds: z.array(z.string().uuid()).optional(),
    payComponentIds: z.array(z.string().uuid()).optional(),
    payrollExpensesOnly: z.boolean().optional(),
    extraDims: z.record(z.string(), z.array(z.string())).optional(),
    requireUntagged: z.array(z.enum(['department', 'location', 'class', 'project'])).optional(),
  }).strict().optional(),
  applyPolicy: z.enum(['automatic', 'suggest', 'manual']).optional(),
  sourceMeasure: z.enum(['period_activity', 'period_end_balance', 'ytd_activity']).optional(),
  basisKind: z.enum(['fixed_percent', 'driver', 'stepped']).optional(),
  driverId: z.string().uuid().nullable().optional(),
  driverAsOf: z.enum(['period', 'document_date', 'prior_period']).optional(),
  // Basis configuration is an opaque JSON column whose shape depends on basisKind.
  basisConfig: z.record(z.string(), z.json()).optional(),
  targetKind: z.enum(['explicit', 'dynamic']).optional(),
  dynamicTarget: z.object({
    dimension: z.string().regex(/^(department|location|class|project|subsidiary|extra:.+)$/).optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    minWeight: z.string().optional(),
    targetAccountId: z.string().uuid().nullable().optional(),
  }).strict().optional(),
  impact: z.enum(['reclass', 'net_zero_pair', 'report_only']).optional(),
  offsetAccountId: z.string().uuid().nullable().optional(),
  residualPolicy: z.enum(['largest_share', 'first_target', 'last_target', 'explicit_target']).optional(),
  residualTargetId: z.string().uuid().nullable().optional(),
  solveMethod: z.enum(['sequential', 'simultaneous']).optional(),
  runPolicy: z.enum(['manual', 'auto_preview', 'auto_post']).optional(),
  runOffsetDays: z.number().int().optional(),
  approvalFlowId: z.string().uuid().nullable().optional(),
  memoTemplate: z.string().nullable().optional(),
  lineDescriptionTemplate: z.string().nullable().optional(),
}).strict();

/** Draft-editable version fields — everything outside A1's frozen set. */
const DRAFT_FIELDS = [
  'effectiveFrom',
  'effectiveTo',
  'bookScope',
  'bookIds',
  'documentKinds',
  'accountScope',
  'dimensionFilters',
  'applyPolicy',
  'sourceMeasure',
  'basisKind',
  'driverId',
  'driverAsOf',
  'basisConfig',
  'targetKind',
  'dynamicTarget',
  'impact',
  'offsetAccountId',
  'residualPolicy',
  'residualTargetId',
  'solveMethod',
  'runPolicy',
  'runOffsetDays',
  'approvalFlowId',
  'memoTemplate',
  'lineDescriptionTemplate',
] as const

/** One version with its explicit targets (Versions tab + drawer). */
async function legacyGET(
  _req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> }, injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const { id, versionId } = await params
  const ruleId = requireRuleId(id)
  if (ruleId instanceof NextResponse) return ruleId
  const versionParam = requireRuleId(versionId)
  if (versionParam instanceof NextResponse) return versionParam
  try {
    const found = await getRuleVersion(gate.user.orgId, versionParam, gate.allowedSubsidiaryIds)
    if (found.version.ruleId !== ruleId) {
      return notFound("record")
    }
    return NextResponse.json(found)
  } catch (error) {
    return allocationWriteErrorResponse(error)
  }
}

/** Edit a draft version. Only whitelisted definition fields; `expectedRevision` required. */
async function legacyPATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> }, injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const { id, versionId } = await params
  const ruleId = requireRuleId(id)
  if (ruleId instanceof NextResponse) return ruleId
  const versionParam = requireRuleId(versionId)
  if (versionParam instanceof NextResponse) return versionParam
  const parsed = await parseJsonBody(req, bodyObjectSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data as Record<string, unknown> & { expectedRevision: string }
  const revision = requireRevision(body)
  if (revision instanceof NextResponse) return revision
  const patch: Record<string, unknown> = {
    orgId: gate.user.orgId,
    expectedRevision: revision,
    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
  }
  for (const key of DRAFT_FIELDS) {
    if (body[key] !== undefined) patch[key] = body[key]
  }
  try {
    const current = await getRuleVersion(gate.user.orgId, versionParam, gate.allowedSubsidiaryIds)
    if (current.version.ruleId !== ruleId) {
      return notFound("record")
    }
    const updated = await updateDraftVersion(
      versionParam,
      patch as Parameters<typeof updateDraftVersion>[1],
      { actorId: gate.user.id },
    )
    return NextResponse.json({ version: { ...updated.version, revision: updated.revision } })
  } catch (error) {
    return allocationWriteErrorResponse(error)
  }
}

export const GET = defineRoute({
  permission: 'allocations.read', feature: "allocations",
  params: z.object({ "id": z.string(), "versionId": z.string() }),
  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const PATCH = defineRoute({
  permission: 'allocations.manage', feature: "allocations",
  params: z.object({ "id": z.string(), "versionId": z.string() }),
  handler: ({ request, params, authz }) => legacyPATCH(request, { params: Promise.resolve(params) }, authz),
});
