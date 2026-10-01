import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { readAuditEvent } from '@/lib/audit-reader'

export const runtime = 'nodejs'

export const GET = defineRoute({
  permission: 'admin.audit.read',
  feature: { none: 'The company audit log is an always-available administrative control.' },
  scope: 'unrestricted',
  params: z.object({ id: z.uuid() }),
  handler: async ({ authz, params }) => {
    const event = await readAuditEvent(authz.user.orgId, params.id)
    if (!event) return notFound('audit event')
    return NextResponse.json(event, { headers: { 'Cache-Control': 'private, no-store' } })
  },
})
