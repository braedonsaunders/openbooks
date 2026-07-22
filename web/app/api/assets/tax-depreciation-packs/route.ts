import { NextResponse } from 'next/server'
import { installTaxDepreciationPack, taxDepreciationPacks } from '@openbooks/engine/src/tax-depreciation-packs.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

export async function GET() {
  const gate = await guardPermission('assets.read')
  if (gate instanceof NextResponse) return gate
  return NextResponse.json({ packs: taxDepreciationPacks() })
}

export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as { code?: string }
  if (!body.code) return NextResponse.json({ error: 'code required' }, { status: 422 })
  try {
    return NextResponse.json(await installTaxDepreciationPack(gate.user.orgId, body.code, gate.user.id))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'install failed' }, { status: 422 })
  }
}
