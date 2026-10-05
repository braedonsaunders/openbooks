import { defineRoute } from '@/lib/api/route'
import { uuidId } from '../../../../lib/api/json'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  activateGrant,
  closeGrant,
  closeOutGrant,
  createGrant,
  createGrantDrawdown,
  createGrantReport,
  satisfyGrantBarrier,
  submitGrantDrawdown,
  submitGrantReport,
} from '@openbooks/engine/src/nonprofit/grants.ts'

export const runtime = 'nodejs'

const sponsorKind = z.enum(['government', 'foundation', 'corporate'])
const determination = z.enum(['contribution_unconditional', 'contribution_conditional', 'exchange'])
const drawdownKind = z.enum(['advance', 'reimbursement', 'final'])

/**
 * Non-posting grant commands. Route-level grants.manage is proven before the
 * body parses; every action below writes grant records only and posts no
 * journal — posting lives on the sibling postings route, which additionally
 * proves gl.post. Exhaustive switch: an action the schema admits but the
 * handler does not name fails closed instead of falling through.
 */
const grantCommandBody = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'),
    code: z.string(),
    name: z.string(),
    sponsorPartyId: uuidId,
    sponsorKind,
    determination,
    barrier: z.string().nullable().optional(),
    rightOfReturn: z.boolean().optional(),
    awardAmount: z.string(),
    periodFrom: z.string(),
    periodTo: z.string(),
    indirectRate: z.string().optional(),
    indirectBase: z.enum(['direct_costs', 'modified_total_direct']).optional(),
    mtdcExclusionAccountGroupId: uuidId.nullable().optional(),
    mtdcSubawardAccountGroupId: uuidId.nullable().optional(),
    mtdcSubawardThreshold: z.string().nullable().optional(),
    costShareRequired: z.boolean().optional(),
    costShareAmount: z.string().optional(),
    fundId: uuidId,
    allowableAccountGroupId: uuidId,
  }),
  z.strictObject({ action: z.literal('activate'), grantId: uuidId }),
  z.strictObject({ action: z.literal('satisfyBarrier'), grantId: uuidId, evidence: z.string() }),
  z.strictObject({
    action: z.literal('createDrawdown'),
    grantId: uuidId,
    amount: z.string(),
    kind: drawdownKind,
  }),
  z.strictObject({ action: z.literal('submitDrawdown'), drawdownId: uuidId }),
  z.strictObject({
    action: z.literal('createReport'),
    grantId: uuidId,
    title: z.string(),
    dueOn: z.string(),
  }),
  z.strictObject({ action: z.literal('submitReport'), reportId: uuidId }),
  z.strictObject({ action: z.literal('closeOut'), grantId: uuidId }),
  z.strictObject({ action: z.literal('close'), grantId: uuidId }),
])

export const POST = defineRoute({
  permission: 'grants.manage',
  feature: 'grantManagement',
  scope: 'unrestricted',
  body: grantCommandBody,
  handler: async ({ authz, body }) => {
    const orgId = authz.user.orgId
    const actorId = authz.user.id
    switch (body.action) {
      case 'create': {
        const { action: _action, ...fields } = body
        return NextResponse.json({ ok: true, grant: await createGrant({ ...fields, orgId, actorId }) })
      }
      case 'activate':
        return NextResponse.json({ ok: true, grant: await activateGrant({ orgId, grantId: body.grantId, actorId }) })
      case 'satisfyBarrier':
        return NextResponse.json({
          ok: true,
          grant: await satisfyGrantBarrier({ orgId, grantId: body.grantId, evidence: body.evidence, actorId }),
        })
      case 'createDrawdown':
        return NextResponse.json({
          ok: true,
          drawdown: await createGrantDrawdown({ orgId, grantId: body.grantId, amount: body.amount, kind: body.kind, actorId }),
        })
      case 'submitDrawdown':
        return NextResponse.json({
          ok: true,
          drawdown: await submitGrantDrawdown({ orgId, drawdownId: body.drawdownId, actorId }),
        })
      case 'createReport':
        return NextResponse.json({
          ok: true,
          report: await createGrantReport({ orgId, grantId: body.grantId, title: body.title, dueOn: body.dueOn, actorId }),
        })
      case 'submitReport':
        return NextResponse.json({
          ok: true,
          report: await submitGrantReport({ orgId, reportId: body.reportId, actorId }),
        })
      case 'closeOut':
        return NextResponse.json({ ok: true, grant: await closeOutGrant({ orgId, grantId: body.grantId, actorId }) })
      case 'close':
        return NextResponse.json({ ok: true, grant: await closeGrant({ orgId, grantId: body.grantId, actorId }) })
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  },
})
