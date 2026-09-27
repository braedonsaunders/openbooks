import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { applicationContextFromSession } from '@/lib/application/context'
import { runExtensionAction } from '@/lib/application/extension-actions'
import { ApplicationError } from '@/lib/application/errors'
const POSTBodySchema1 = z.object({  }).passthrough();


export const runtime = 'nodejs'
export const POST = defineRoute({
  permission: 'apps.use',
  feature: 'apps',
  body: POSTBodySchema1,
  handler: async ({ request: request, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { key: string });
    const gate = routeAuthz;

    const { key } = await params
    try {
        const result = await runExtensionAction(
          applicationContextFromSession(gate, 'api', crypto.randomUUID()),
          key,
          routeBody,
        )
        return NextResponse.json(result, {
          status: result.ok ? 200 : result.status,
        })
      } catch (error) {
        if (error instanceof ApplicationError)
          return apiErrorResponse(error, { details: { ok: false } })
        throw error
      }
  },
});
