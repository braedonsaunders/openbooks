import { apiErrorResponse } from '@/lib/api/error-response'
import { invalidInput } from '../../../../lib/application/errors'
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { installTaxDepreciationPack, taxDepreciationPacks } from '@openbooks/engine/src/tax-returns/depreciation-packs.ts'
import { guardUnrestrictedScope } from '../../../../lib/authz'
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
  // Tax depreciation packs install the org-wide regime every entity's
  // assets depreciate under.
  const unrestricted = guardUnrestrictedScope(gate)
  if (unrestricted) return unrestricted
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { code?: string }
  if (!body.code) return NextResponse.json({ error: 'code required' }, { status: 422 })
  try {
    return NextResponse.json(await installTaxDepreciationPack(gate.user.orgId, body.code, gate.user.id))
  } catch (error) {
    // installTaxDepreciationPack signals request-state validation (exact
    // decimals, known pack codes) with bare Errors carrying curated operator
    // text; only those travel as 422s with their message, everything named
    // sanitizes.
    if (error instanceof Error && error.constructor === Error) return apiErrorResponse(invalidInput(error.message))
    return apiErrorResponse(error, { safeStatus: 422 })
  }
}
