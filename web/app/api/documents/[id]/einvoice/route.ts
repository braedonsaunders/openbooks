import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { ScopeNotFoundError, subsidiaryVisibleFilter } from '@openbooks/engine/organization/scope'
import {
  EInvoiceConfigurationError, EInvoiceRefusal, EINVOICE_PROFILES, isEInvoiceProfileKey,
  issueNativeEInvoice, loadNativeEInvoice, validateEInvoice,
  type EInvoiceProfileKey,
} from '@openbooks/engine/einvoice'
import { defineRoute } from '@/lib/api/route'
import { can } from '@/lib/authz'
import { isDocKindEnabled } from '@/lib/documents'
import { contentDisposition } from '@/lib/export'
import { rendererUnavailableResponse } from '@/lib/api/pdf-renderer'
import { loadPdfRecordValues } from '@/lib/pdf-templates/values'
import { loadRecordDesignatedTemplateName, resolvePdfTemplate } from '@/lib/pdf-templates/store'
import { mergeAndPrintPdf } from '@/lib/pdf-templates/render'
import { assertEInvoicePdfDesign, eInvoicePdfValues } from '@/lib/pdf-templates/einvoice'

export const runtime = 'nodejs'
const params = z.object({ id: z.string().uuid() })
const profile = z.custom<EInvoiceProfileKey>(value => typeof value === 'string' && isEInvoiceProfileKey(value), 'Choose a supported e-invoice profile.')
const issueBody = z.object({ profile, buyerReference: z.string().trim().min(1).max(200).nullable().optional() }).strict()
const querySchema = z.object({ profile: profile.optional(), buyerReference: z.string().trim().max(200).optional(), validate: z.enum(['1']).optional(), issued: z.string().uuid().optional() }).strict()

function refusal(error: unknown): NextResponse | null {
  const renderer = rendererUnavailableResponse(error)
  if (renderer) return renderer
  if (error instanceof EInvoiceRefusal) return NextResponse.json({ error: error.message, findings: error.findings }, { status: 422 })
  if (error instanceof EInvoiceConfigurationError) return NextResponse.json({ error: error.message }, { status: 422 })
  return null
}

/** Archive downloads are independent of current seller or recipient configuration. */
export const GET = defineRoute({
  permission: 'ar.read', feature: 'einvoicing', params,
  handler: async ({ request, authz, params: { id } }) => {
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success) return NextResponse.json({ error: query.error.issues[0]?.message ?? 'Invalid e-invoice request.' }, { status: 400 })
    return withOrgTransaction(authz.user.orgId, async () => {
      const tx = db
      const document = (await tx.execute<{ kind: string; status: string; configuredProfile: string | null; buyerReference: string | null }>(sql`
        select d.kind,d.status,coalesce(c.einvoice_profile,s.default_profile) as "configuredProfile",
          coalesce(d.reference_number,c.einvoice_buyer_reference) as "buyerReference"
        from documents d
        left join customer_roles c on c.org_id=d.org_id and c.party_id=d.party_id
        left join einvoice_settings s on s.org_id=d.org_id and s.subsidiary_id=d.subsidiary_id
        where d.org_id=${authz.user.orgId} and d.id=${id} and d.kind in ('customer_invoice','customer_credit')
          ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)} for share of d`)).rows[0]
      if (!document || !(await isDocKindEnabled(authz.user.orgId, document.kind))) throw new ScopeNotFoundError()
      if (query.data.issued) {
        const archive = (await tx.execute<{ content: Uint8Array; fileName: string; mediaType: string; sha256: string }>(sql`
          select content,file_name as "fileName",media_type as "mediaType",content_sha256 as sha256
          from einvoice_documents where org_id=${authz.user.orgId} and document_id=${id} and id=${query.data.issued}`)).rows[0]
        if (!archive) throw new ScopeNotFoundError()
        const extension = archive.mediaType === 'application/pdf' ? 'pdf' : 'xml'
        return new NextResponse(new Uint8Array(archive.content), { headers: {
          'Content-Type': archive.mediaType,
          'Content-Disposition': contentDisposition('attachment', archive.fileName.replace(/\.(pdf|xml)$/i, ''), extension),
          'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-EInvoice-SHA256': archive.sha256,
        } })
      }
      const archives = (await tx.execute<{ id: string; profile: string; fileName: string; issuedAt: string; sha256: string; buyerReference: string | null }>(sql`
        select id,profile,file_name as "fileName",issued_at::text as "issuedAt",content_sha256 as sha256,buyer_reference as "buyerReference"
        from einvoice_documents where org_id=${authz.user.orgId} and document_id=${id} order by issued_at,id`)).rows
      const metadata = {
        profiles: Object.values(EINVOICE_PROFILES).map(({ key, label, hybridPdf }) => ({ key, label, hybridPdf })),
        configuredProfile: document.configuredProfile, buyerReference: document.buyerReference,
        canIssue: document.status === 'posted' && can(authz, 'documents.manage'), archives,
      }
      if (!query.data.validate) return NextResponse.json(metadata)
      try {
        const loaded = await loadNativeEInvoice(tx, { orgId: authz.user.orgId, actorId: authz.user.id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }, id,
          { profile: query.data.profile, buyerReference: query.data.buyerReference === undefined ? undefined : query.data.buyerReference || null })
        const findings = validateEInvoice(loaded.invoice)
        if (EINVOICE_PROFILES[loaded.invoice.profile].hybridPdf) {
          const template = await resolvePdfTemplate(authz.user.orgId, document.kind, null,
            await loadRecordDesignatedTemplateName(authz.user.orgId, document.kind, id))
          if (!template) throw new EInvoiceConfigurationError('Choose an active invoice design in PDF Templates before issuing Factur-X / ZUGFeRD.')
          assertEInvoicePdfDesign(template, loaded.invoice)
        }
        return NextResponse.json({ ...metadata, profile: loaded.invoice.profile, findings, valid: !findings.some(finding => finding.severity === 'fatal') })
      } catch (error) {
        if (error instanceof EInvoiceConfigurationError) return NextResponse.json({ ...metadata, valid: false, error: error.message, findings: [] })
        throw error
      }
    })
  },
})

/** The native issuance command seals and audits the original bytes before download. */
export const POST = defineRoute({
  permission: 'documents.manage', feature: 'einvoicing', params, body: issueBody,
  handler: async ({ authz, params: { id }, body }) => {
    try {
      const document = (await db.execute<{ kind: string }>(sql`
        select d.kind from documents d where d.org_id=${authz.user.orgId} and d.id=${id}
          and d.kind in ('customer_invoice','customer_credit') ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}`)).rows[0]
      if (!document || !(await isDocKindEnabled(authz.user.orgId, document.kind))) throw new ScopeNotFoundError()
      const issued = await issueNativeEInvoice({ orgId: authz.user.orgId, actorId: authz.user.id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }, id, body,
        async invoice => {
          const template = await resolvePdfTemplate(authz.user.orgId, document.kind, null,
            await loadRecordDesignatedTemplateName(authz.user.orgId, document.kind, id))
          const record = await loadPdfRecordValues(document.kind, authz.user.orgId, id, authz.allowedSubsidiaryIds)
          if (!template || !record) throw new EInvoiceConfigurationError('The native invoice PDF design or invoice values are unavailable. Review PDF Templates before issuing this invoice.')
          assertEInvoicePdfDesign(template, invoice)
          return mergeAndPrintPdf(template, await eInvoicePdfValues(invoice, record.values))
        })
      return NextResponse.json({ id: issued.id, fileName: issued.fileName, sha256: issued.sha256, downloadUrl: `/api/documents/${id}/einvoice?issued=${issued.id}` }, { status: 201 })
    } catch (error) {
      const response = refusal(error)
      if (response) return response
      throw error
    }
  },
})
