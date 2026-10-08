import { z } from 'zod'
import { getTranslations } from 'next-intl/server'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { can } from '@/lib/authz'
import { getResource } from '@/lib/data-io/resources'
import { templateCsv, templateFields, templateFilename, templateXlsx, type TemplateField } from '@/lib/data-io/templates'

export const runtime = 'nodejs'

/**
 * GET /api/data/templates/{resource}?format=xlsx|csv — a blank import file
 * whose header row is the resource's importable field keys. Available to
 * operators who may import that resource.
 */
export const GET = defineRoute({
  permission: 'data.import',
  feature: { none: 'Import templates follow each resource’s own feature and write-permission checks.' },
  params: z.object({ resource: z.string().min(1).max(200) }),
  handler: async ({ request, authz, params }) => {
    const format = new URL(request.url).searchParams.get('format') === 'csv' ? 'csv' : 'xlsx'
    const resource = await getResource(authz.user.orgId, params.resource, authz.allowedSubsidiaryIds)
    if (!resource || !resource.descriptor.supportsImport) return notFound('record')
    if (!can(authz, resource.descriptor.writePermission)) {
      return NextResponse.json({ error: `The ${resource.descriptor.writePermission} permission is required to import this resource.` }, { status: 403 })
    }
    const fields = templateFields(await resource.fields())
    const filename = templateFilename(resource.descriptor.key, format)
    const headers = { 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' }
    if (format === 'csv') {
      return new Response(templateCsv(fields), { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8' } })
    }
    const t = await getTranslations('data.templates')
    const note = (field: TemplateField) => [
      field.label,
      field.required ? t('required') : t('optional'),
      field.reference ? t('reference', { resource: field.reference.resource, by: field.reference.by })
        : field.options.length ? t('options', { options: field.options.join(', ') })
        : t(`kind.${field.kind}`),
    ].join('\n')
    const body = await templateXlsx(resource.descriptor.label, fields, note)
    return new Response(new Uint8Array(body), { headers: { ...headers, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })
  },
})
