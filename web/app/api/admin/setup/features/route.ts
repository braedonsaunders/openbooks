import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { applyFeatureChanges, normalizeFeatureChanges } from '../../../../../lib/features-admin'

const requestBodySchema = z.object({ features: z.record(z.string(), z.boolean()) });


export const dynamic = 'force-dynamic'

/**
 * Toggle optional features on/off for the org. Only registry keys are
 * accepted. Enabling a feature installs its editable baseline configuration;
 * disabling it preserves all existing data and only hides its surfaces.
 *
 * The stored flags, scheduler reconciliation, and baseline provisioning commit
 * as ONE atomic unit: a provisioning or schedule-refresh failure rolls the
 * whole toggle back, so the org can never hold an enabled-but-unprovisioned
 * feature (its surfaces would render against missing defaults) or a stale
 * executable schedule for a disabled scripts feature. Provisioning is
 * idempotent, so retrying a failed toggle converges exactly once.
 *
 * The turn-off blockers are evaluated INSIDE this transaction, under the org's
 * feature-gate fence (`acquireFeatureGateLock`): an operation that could create
 * a blocker — a project activating under the `projects` gate — takes the same
 * fence before changing active state, so the two operations serialize and the
 * outcome is always a refused disable or a refused activation. Evaluating the
 * blockers before the transaction would leave a window where both apply.
 */
async function legacyPUT(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const parsedBody = await parseJsonBody(req, requestBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  const normalized = normalizeFeatureChanges(body.features)
  if (!normalized.ok) {
    return NextResponse.json(normalized.key ? { error: normalized.error, key: normalized.key } : { error: normalized.error }, { status: 422 })
  }
  // The toggle itself — fence, dependency rules, audit, schedule refresh,
  // baseline provisioning — lives in web/lib/features-admin.ts so the
  // assistant/MCP `update_features` command is the same operation.
  const result = await applyFeatureChanges(orgId, gate.user.id, normalized.changes)
  if (!result.ok) {
    const dependencyError: Record<string, unknown> = { ...result }
    delete dependencyError.ok
    return NextResponse.json(dependencyError, { status: result.error === 'not-found' ? 404 : 409 })
  }
  return NextResponse.json({ ok: true })
}

export const PUT = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  body: requestBodySchema,
  handler: async ({ request, body }) => {
    const replayHeaders = new Headers(request.headers);
    replayHeaders.delete("content-length");
    const replayRequest = new Request(request.url, { method: request.method, headers: replayHeaders, body: JSON.stringify(body), signal: request.signal });
    return legacyPUT(replayRequest as never);
  },
});
