import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { isContinuousCloseAgentKey } from '@openbooks/engine/src/continuous-close/continuous-close.ts'
import { CONTINUOUS_CLOSE_DETECTOR_SPECS } from '@openbooks/engine/src/agents/continuous-close-config.ts'
import { canonicalDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'
import { moneyRefusal } from '@openbooks/engine/src/money/decimal-refusal.ts'
import { guardPermission, guardUnrestrictedScope } from '../../../../../../lib/authz'
import { CONTINUOUS_CLOSE_DISABLED_REMEDY, saveOrgAiAgentSettings } from '../../../../../../lib/assistant/ai-config'

const detectorKeys = [...new Set(CONTINUOUS_CLOSE_DETECTOR_SPECS.map((spec) => spec.detectorKey))] as [string, ...string[]];
const materialityThresholdSchema = z.string().superRefine((value, ctx) => {
  if (canonicalDecimal(value, 4) === null) ctx.addIssue({ code: 'custom', message: moneyRefusal('Materiality threshold', value) })
})
const requestBodySchema = z.object({
  agentKey: z.string().optional(), enabled: z.boolean(), automaticRuns: z.boolean(), cadence: z.enum(["daily", "weekly"]),
  materialityThreshold: materialityThresholdSchema,
  detectors: z.array(z.object({ detectorKey: z.enum(detectorKeys), enabled: z.boolean(), materialityThreshold: materialityThresholdSchema.nullable(), parameters: z.record(z.string(), z.number()) })),
  analysis: z.object({ rootCauseAnalysis: z.boolean(), recommendations: z.boolean(), narrative: z.boolean(), modelTier: z.enum(["fast", "smart"]), maxToolSteps: z.number().int().min(4).max(30) }),
  notification: z.object({ mode: z.enum(["findings_only", "digest", "immediate"]), roleIds: z.array(z.string().uuid()).max(100), userIds: z.array(z.string().uuid()).max(100) }).nullable().optional(),
});


export const runtime = 'nodejs'

/** Persist one agent's schedule and detector controls without touching provider secrets. */
async function legacyPUT(request: Request, { params }: { params: Promise<{ agentKey: string }> }) {
  const gate = await guardPermission('admin.ai.manage')
  if (gate instanceof NextResponse) return gate
  const scopeDenied = guardUnrestrictedScope(gate)
  if (scopeDenied) return scopeDenied
  const { agentKey } = await params
  if (!isContinuousCloseAgentKey(agentKey)) {
    return NextResponse.json({ error: 'invalid_agent' }, { status: 404 })
  }
  let body: Record<string, unknown>
  try {
    const parsedBody = await parseJsonBody(request, requestBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    body = parsedBody.data
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  try {
    const policy = await saveOrgAiAgentSettings(gate.user.orgId, gate.user.id, {
      ...body,
      agentKey,
    })
    return NextResponse.json(policy)
  } catch (error) {
    // Same refusal as the bulk form: 409 with the remedy, not a bare code.
    if ((error as Error).message === 'feature_disabled') {
      return NextResponse.json({ error: CONTINUOUS_CLOSE_DISABLED_REMEDY }, { status: 409 })
    }
    return apiErrorResponse(error)
  }
}

export const PUT = defineRoute({
  permission: "admin.ai.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  scope: "unrestricted",
  params: z.object({ "agentKey": z.string() }),
  body: requestBodySchema,
  handler: async ({ request, body, params }) => {
    const replayHeaders = new Headers(request.headers);
    replayHeaders.delete("content-length");
    const replayRequest = new Request(request.url, { method: request.method, headers: replayHeaders, body: JSON.stringify(body), signal: request.signal });
    return legacyPUT(replayRequest as never, { params: Promise.resolve(params as never) } as never);
  },
});
