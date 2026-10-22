import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { parseJsonBody } from '@/lib/api/json'
import { notFound } from '@/lib/api/responses'
import { isUuid } from '@openbooks/engine/platform/identifiers'
import { MailboxConfigurationError, takeMailboxOwnership, updateMailbox } from '@openbooks/engine/payables/ap-capture-service'
import { patchMailboxBody } from '../schema'

export const runtime = 'nodejs'

/**
 * Update an inbound AP address. Its legal entity is fixed at creation. An
 * empty signing secret keeps the stored one, `clearSigningSecret` removes it,
 * and `rotateToken` issues a new webhook URL (the old one answers 404).
 *
 * `{ takeOwnership: true, reason }` instead makes the caller the address
 * owner, for example after the owner left; the caller must be able to create
 * bills in the address's entity. The engine audits either change with before
 * and after state.
 */
export const PATCH = defineRoute({
  permission: 'admin.setup.manage',
  feature: { none: 'AP capture is governed by its document-capture configuration, not a feature switch.' },
  params: z.object({ id: z.string() }),
  handler: async ({ request, authz, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    const parsed = await parseJsonBody(request, patchMailboxBody, { status: 422 })
    if (!parsed.ok) return parsed.response
    try {
      if ('takeOwnership' in parsed.data) {
        const owned = await takeMailboxOwnership({
          id,
          reason: parsed.data.reason,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        })
        return NextResponse.json(owned)
      }
      const updated = await updateMailbox({
        ...parsed.data,
        id,
        clearSigningSecret: parsed.data.clearSigningSecret === true,
        rotateToken: parsed.data.rotateToken === true,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      })
      return NextResponse.json(updated)
    } catch (error) {
      if (error instanceof MailboxConfigurationError) {
        return error.status === 404 ? notFound('record') : NextResponse.json({ error: error.message }, { status: error.status })
      }
      throw error
    }
  },
})
