import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { can } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { runBridgeMethod } from '@/lib/apps/store'
const POSTBodySchema1 = z.object({ "method": z.string().optional(), "payload": z.unknown().optional(), "versionId": z.string().optional(), "invocationKey": z.unknown().optional() }).passthrough();


export const runtime = 'nodejs'

/**
 * POST — relay a single bridge call from a sandboxed App frontend. The AppFrame
 * forwards { method, payload, invocationKey } here; this route re-authenticates
 * the real user, enforces apps.use, and (for records) enforces app-granted ∩
 * user permissions before running anything. The sandbox never reaches the DB
 * except through the org-scoped adapters wired in runBridgeMethod.
 *
 * The client generates one invocation key per action and reuses it across that
 * action's retries; the bridge uses it (not the payload hash) as the
 * idempotency key. Writes refuse without it — see requireBridgeInvocationKey.
 */
export const POST = defineRoute({
  permission: 'apps.use',
  feature: 'apps',
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { key: string });
    const gate = routeAuthz;
    const { key } = await params

    const body = routeBody as {
        method?: string
        payload?: unknown
        versionId?: string
        invocationKey?: unknown
      }
    if (typeof body.method !== 'string') {
        return NextResponse.json({ error: 'method required' }, { status: 400 })
      }
    if (body.invocationKey !== undefined && typeof body.invocationKey !== 'string') {
        return NextResponse.json({ error: 'invocationKey must be a string' }, { status: 400 })
      }
    if (
        body.versionId !== undefined &&
        (typeof body.versionId !== 'string' || !isUuid(body.versionId))
      )
        return NextResponse.json({ error: 'Invalid app version' }, { status: 400 })
    const res = await runBridgeMethod({
        orgId: gate.user.orgId,
        user: gate.user,
        key,
        expectedVersionId: body.versionId,
        method: body.method,
        payload: body.payload ?? {},
        invocationKey: typeof body.invocationKey === 'string' ? body.invocationKey : undefined,
        userCan: (perm) => can(gate, perm),
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      })
    if (!res.ok)
        return NextResponse.json(
          { ok: false, error: res.error },
          { status: res.status },
        )
    return NextResponse.json({ ok: true, result: res.result })
  },
});
