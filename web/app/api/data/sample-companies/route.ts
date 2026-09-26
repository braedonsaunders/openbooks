import { apiErrorResponse } from '@/lib/api/error-response'
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import {
  SampleCompanyError,
  SampleCompanyProvisioningError,
  createSampleCompany,
  sampleCompanyProvisioningBody,
  sampleCompanyStatuses,
} from '@openbooks/engine/src/sample-companies/service.ts'
import { getAuthz, can } from '../../../../lib/authz'
import { FEATURES, featureRequirements } from '../../../../lib/features'
import { INDUSTRY_BY_KEY } from '../../../../lib/industries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function authorized() {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can(authz, 'data.import') && !can(authz, 'admin.setup.manage')) {
    return NextResponse.json({ error: 'missing permission: data.import' }, { status: 403 })
  }
  return authz
}

function industryFeatureSet(industryKey: string): Record<string, boolean> {
  const industry = INDUSTRY_BY_KEY.get(industryKey)
  if (!industry) throw new SampleCompanyError(`unknown industry: ${industryKey}`)
  const features = Object.fromEntries(
    FEATURES.map((feature) => [
      feature.key,
      industry.features[feature.key] ?? feature.defaultEnabled,
    ]),
  )
  // The Features switchboard's parent/dependency hierarchy also governs
  // sample tenants. Normalize to a fixed point before persisting the clone.
  let changed = true
  while (changed) {
    changed = false
    for (const feature of FEATURES) {
      if (featureRequirements(feature).some((required) => !features[required]) && features[feature.key]) {
        features[feature.key] = false
        changed = true
      }
    }
  }
  return features
}

export async function GET() {
  const gate = await authorized()
  if (gate instanceof NextResponse) return gate
  return NextResponse.json({ profiles: await sampleCompanyStatuses(gate.user.homeUserId) })
}

export async function POST(req: Request) {
  const gate = await authorized()
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { industry?: unknown }
  if (typeof body.industry !== 'string' || !INDUSTRY_BY_KEY.has(body.industry)) {
    return NextResponse.json({ error: 'unknown-industry' }, { status: 422 })
  }
  try {
    const result = await createSampleCompany({
      industryKey: body.industry,
      memberUserId: gate.user.homeUserId,
      sourceOrgId: gate.user.orgId,
      memberName: gate.user.name,
      features: industryFeatureSet(body.industry),
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    // A staged provisioning failure is a named, actionable refusal —
    // the fixed per-stage code and message reach the operator while the full
    // cause stays in the server log. Anything else keeps the previous shape:
    // known validation refusals stay 409, unknown failures stay a generic
    // 500 with no internal detail in the body.
    if (error instanceof SampleCompanyProvisioningError) {
      console.error(`[sample-company] provisioning failed at stage ${error.stage}`, error.cause ?? error)
      return NextResponse.json(sampleCompanyProvisioningBody(error), { status: 500 })
    }
    if (error instanceof SampleCompanyError) {
      return apiErrorResponse(error, { safeStatus: 409 })
    }
    console.error('[sample-company] provisioning failed', error)
    return apiErrorResponse(error)
  }
}
