import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import {
  PAYROLL_BANK_FILE_FORMATS,
  payRunBankFilePopulation,
  payrollBankProfiles,
} from '@openbooks/engine/src/payroll-bank-file.ts'
import {
  generatePayRunBankFile,
  listPayRunBankFiles,
  payRunBankFileAudit,
  payRunBankFileEntitlement,
} from '@openbooks/engine/src/payroll-bank-file-artifact.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { SandboxEgressError } from '@openbooks/engine/src/sandbox/guard.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The run's direct-deposit panel.
 *
 * GET is the state the operator needs BEFORE they press anything: whether the
 * run is entitled to a file and, if not, the one reason why; which originator
 * profiles are configured; who is on the EFT rail and who is deliberately not;
 * and every artifact ever produced for this run with its release history.
 * Metadata only — never bytes.
 *
 * POST generates a new immutable artifact. The bytes come from the sibling
 * `[fileId]` route, which is where the release is audited; splitting them
 * means a generate can never be mistaken for a release.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const orgId = gate.user.orgId

  const entitlement = await payRunBankFileEntitlement(orgId, id)
  if (entitlement.refusal?.code === 'notFound') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const [profiles, artifacts, audit] = await Promise.all([
    payrollBankProfiles(orgId),
    listPayRunBankFiles(orgId, id),
    payRunBankFileAudit(orgId, id),
  ])
  // The population is only meaningful once the run's figures are final.
  const population =
    entitlement.runStatus === 'committed' ? await payRunBankFilePopulation(orgId, id) : null

  return NextResponse.json(
    {
      entitlement,
      population,
      profiles,
      artifacts,
      audit,
      formats: Object.fromEntries(
        Object.entries(PAYROLL_BANK_FILE_FORMATS).map(([key, spec]) => [
          key,
          {
            enabled: spec.enabled,
            currency: spec.currency,
            disabledReason: spec.disabledReason ?? null,
          },
        ]),
      ),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

/**
 * Generate a new bank-file artifact. `payroll.run`, not `payroll.read`: this
 * produces an instruction to move money, exactly like printing cheques.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    paymentBankProfileId?: unknown
    supersedeReason?: unknown
  }
  if (typeof body.paymentBankProfileId !== 'string' || !isUuid(body.paymentBankProfileId)) {
    return NextResponse.json({ error: 'paymentBankProfileId is required' }, { status: 422 })
  }

  try {
    const artifact = await generatePayRunBankFile({
      orgId: gate.user.orgId,
      documentId: id,
      actorId: gate.user.id,
      paymentBankProfileId: body.paymentBankProfileId,
      supersedeReason: typeof body.supersedeReason === 'string' ? body.supersedeReason : null,
    })
    return NextResponse.json({ artifact }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof PayrollError || error instanceof SandboxEgressError) {
      return NextResponse.json(
        { error: error.message },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    throw error
  }
}
