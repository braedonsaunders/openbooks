import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from 'next/server'

import { saveSetupAgentPolicy } from '../../../../../../lib/setup/agents'
import { CONTINUOUS_CLOSE_DETECTOR_SPECS } from '@openbooks/engine/src/agents/continuous-close-config.ts'
import { canonicalDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'
import { moneyRefusal } from '@openbooks/engine/src/money/decimal-refusal.ts'

const detectorKeys = [...new Set(CONTINUOUS_CLOSE_DETECTOR_SPECS.map((spec) => spec.detectorKey))] as [string, ...string[]];
const materialityThresholdSchema = z.string().superRefine((value, ctx) => {
  if (canonicalDecimal(value, 4) === null) ctx.addIssue({ code: 'custom', message: moneyRefusal('Materiality threshold', value) })
})
const requestBodySchema = z.object({
  agentKey: z.string().optional(),
  enabled: z.boolean(), automaticRuns: z.boolean(), cadence: z.enum(["daily", "weekly"]),
  materialityThreshold: materialityThresholdSchema,
  detectors: z.array(z.object({ detectorKey: z.enum(detectorKeys), enabled: z.boolean(), materialityThreshold: materialityThresholdSchema.nullable(), parameters: z.record(z.string(), z.number()) })),
  analysis: z.object({ rootCauseAnalysis: z.boolean(), recommendations: z.boolean(), narrative: z.boolean(), modelTier: z.enum(["fast", "smart"]), maxToolSteps: z.number().int().min(4).max(30) }),
  notification: z.object({ mode: z.enum(["findings_only", "digest", "immediate"]), roleIds: z.array(z.string().uuid()).max(100), userIds: z.array(z.string().uuid()).max(100) }).nullable().optional(),
});


export const dynamic = 'force-dynamic'

/**
 * PUT /api/admin/setup/agents/[agentKey] — persist one pack's schedule and
 * detector controls. Thin adapter over the shared setup policy command (the
 * provider page's per-agent PUT calls the same command behind its own key);
 * the audit row is written there, not here.
 */


export const PUT = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  scope: "unrestricted",
  params: z.object({ "agentKey": z.string() }),
  body: requestBodySchema,
  handler: async ({ body, params, authz: routeAuthz }) => {

    const gate = routeAuthz



    const { agentKey } = params


    try {
      const policy = await saveSetupAgentPolicy(gate.user.orgId, gate.user.id, agentKey, body)
      return NextResponse.json(policy)
    } catch (error) {
      const message = (error as Error).message
      if (message === 'invalid_agent') return NextResponse.json({ error: 'invalid_agent' }, { status: 404 })
      if (message === 'feature_disabled') return NextResponse.json({ error: 'feature_disabled' }, { status: 409 })
      return NextResponse.json({ error: message }, { status: 422 })
    }
  },
});
