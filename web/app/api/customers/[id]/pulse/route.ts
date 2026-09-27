import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { can } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { loadCustomerPulse, pulseSectionsFor } from '../../../../../lib/customer-pulse'
import { notFound } from "@/lib/api/responses";
import { z } from 'zod'

export const GET = defineRoute({
  public: 'session',
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => {
  // The pulse is a combined payload across domains, so EITHER-read no longer
  // opens the whole response: each section is gated by its own permission
  // (AR/credit/payments on ar.read, pipeline/activity on
  // crm.accounts.read, project rollup on projects.read) and sections the
  // caller cannot see are omitted. The route still requires at least one of
  // the three — a caller with none gets a 403 naming the remedy.
  const sections = pulseSectionsFor((perm) => can(authz, perm))
  if (!sections) {
    return NextResponse.json(
      { error: 'missing permission: crm.accounts.read, ar.read or projects.read' },
      { status: 403 },
    )
  }

  const { id } = params
  if (!isUuid(id)) return notFound("record")

  const data = await loadCustomerPulse(id, authz.user.orgId, authz.allowedSubsidiaryIds, sections)
  if (!data) return notFound("record")

  return NextResponse.json(data)
  },
})
