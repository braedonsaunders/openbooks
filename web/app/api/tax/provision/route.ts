import { NextResponse } from 'next/server'
import { isTaxProvisionSelection, provisionTaxPacks } from '@openbooks/engine/src/tax-pack-provisioning.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

/** Provision the full indirect-tax stack (jurisdiction, code + rate, return form,
 *  nexus) for the selected country/state packs. */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate

  const body = (await req.json().catch(() => null)) as { packs?: unknown } | null
  if (!body || !Array.isArray(body.packs) || body.packs.length === 0 || body.packs.length > 60) {
    return NextResponse.json({ error: 'packs must be a non-empty array' }, { status: 400 })
  }
  if (body.packs.some((c) => typeof c !== 'string' || !isTaxProvisionSelection(c))) {
    return NextResponse.json({ error: 'unknown tax setup selection' }, { status: 422 })
  }

  try {
    const result = await provisionTaxPacks(gate.user.orgId, body.packs as string[], gate.user.id)
    return NextResponse.json(result)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'provisioning failed' }, { status: 422 })
  }
}
