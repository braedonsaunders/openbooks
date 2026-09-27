import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json"
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  PAYROLL_BANK_FILE_FORMATS,
  payRunBankFilePopulation,
  payrollBankProfiles,
} from '@openbooks/engine/src/payroll/bank-file.ts'
import {
  generatePayRunBankFile,
  listPayRunBankFiles,
  payRunBankFileAudit,
  payRunBankFileEntitlement,
} from '@openbooks/engine/src/payroll/bank-file-artifact.ts'
import { PayrollError } from "@openbooks/engine/src/payroll/error.ts";
import { SandboxEgressError } from '@openbooks/engine/src/organization/sandbox-guard.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.strictObject({
  paymentBankProfileId: z.string().uuid(),
  supersedeReason: z.string().trim().max(500).nullable().optional(),
})



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
export const GET = defineRoute({
  permission: 'payroll.read',
  feature: 'payroll',
  params: z.object({ "id": z.string() }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const orgId = gate.user.orgId

    // The entitlement service intentionally has no caller concept. Resolve the
    // run's legal entity here, before it can disclose entitlement/refusal
    // details or enumerate artifacts, and fail closed exactly like a missing
    // run for a restricted subsidiary.
    const owned = (await db.execute<{ subsidiaryId: string | null }>(sql`
      select d.subsidiary_id as "subsidiaryId"
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${id}`)).rows[0]
    if (!owned) return notFound("record")
    const denied = guardSubsidiaryScope(gate, owned.subsidiaryId)
    if (denied) return denied

    const entitlement = await payRunBankFileEntitlement(orgId, id, gate.allowedSubsidiaryIds)
    if (entitlement.refusal?.code === 'notFound') {
      return notFound("record")
    }

    const [profiles, artifacts, audit] = await Promise.all([
      payrollBankProfiles(orgId),
      listPayRunBankFiles(orgId, id, gate.allowedSubsidiaryIds),
      payRunBankFileAudit(orgId, id, undefined, gate.allowedSubsidiaryIds),
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

  },
})

/**
 * Generate a new bank-file artifact. `payroll.run`, not `payroll.read`: this
 * produces an instruction to move money, exactly like printing cheques.
 */
export const POST = defineRoute({
  permission: 'payroll.run',
  feature: 'payroll',
  params: z.object({ "id": z.string() }),
  handler: async ({ request: req, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const owned = (await db.execute<{ subsidiaryId: string | null }>(sql`
      select d.subsidiary_id as "subsidiaryId"
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${gate.user.orgId} and r.document_id = ${id}`)).rows[0]
    if (!owned) return notFound("record")
    const denied = guardSubsidiaryScope(gate, owned.subsidiaryId)
    if (denied) return denied

    const parsedBody = await parseJsonBody(req, requestBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data

    try {
      const artifact = await generatePayRunBankFile({
        orgId: gate.user.orgId,
        documentId: id,
        actorId: gate.user.id,
        paymentBankProfileId: body.paymentBankProfileId,
        supersedeReason: body.supersedeReason?.trim() || null,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      })
      return NextResponse.json({ artifact }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      if (error instanceof PayrollError || error instanceof SandboxEgressError) {
        const refusal = await apiErrorResponse(error, { safeStatus: 409 })
        refusal.headers.set('Cache-Control', 'no-store')
        return refusal
      }
      throw error
    }

  },
})
