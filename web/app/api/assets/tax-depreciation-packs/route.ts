import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { installTaxDepreciationPack, taxDepreciationPacks } from '@openbooks/engine/src/tax-depreciation-packs.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'

export const runtime = 'nodejs'

export async function GET() {
  const gate = await guardFeaturePermission('assets.read', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  return NextResponse.json({ packs: taxDepreciationPacks() })
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { code?: string }
  if (!body.code) return NextResponse.json({ error: 'code required' }, { status: 422 })
  try {
    return NextResponse.json(await installTaxDepreciationPack(gate.user.orgId, body.code, gate.user.id))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'install failed' }, { status: 422 })
  }
}
