import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import {
  Badge,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { PDF_RECORD_TYPES, PDF_RECORD_TYPE_BY_KEY } from '../../../../lib/pdf-templates/catalog'
import { listPdfTemplates } from '../../../../lib/pdf-templates/store'
import { DuplicateTemplateButton, NewTemplateButton } from './TemplateActions'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('pdfTemplates')
  return { title: t('title') }
}

const PAPER_LABEL: Record<string, string> = { letter: 'Letter', a4: 'A4', legal: 'Legal' }

export default async function PdfTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.customization.manage')
  const t = await getTranslations('pdfTemplates')
  const tCommon = await getTranslations('common')
  const tHub = await getTranslations('admin.hub')
  const sp = await searchParams
  const requestedType = pickString(sp.recordType)
  const recordType =
    requestedType && requestedType in PDF_RECORD_TYPE_BY_KEY ? requestedType : PDF_RECORD_TYPES[0]!.key

  const templates = await listPdfTemplates(authz.user.orgId, recordType)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/admin', label: tHub('title') }}
            title={t('title')}
            description={t('description')}
            actions={<NewTemplateButton recordType={recordType} />}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {PDF_RECORD_TYPES.map((rt) => (
              <Link
                key={rt.key}
                href={`/admin/pdf-templates?recordType=${rt.key}`}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  rt.key === recordType
                    ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500 dark:bg-teal-950/40 dark:text-teal-300'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300'
                }`}
              >
                {rt.label}
              </Link>
            ))}
          </div>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('list.name')}</TableHead>
            <TableHead>{tCommon('labels.status')}</TableHead>
            <TableHead>{t('list.paper')}</TableHead>
            <TableHead className="text-right">{tCommon('labels.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* Always-present baseline: the built-in starter design for this type. */}
          <TableRow>
            <TableCell>
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {t('list.builtInStarter')}
              </span>
              <span className="ml-2 text-xs text-slate-400">{t('list.starterHint')}</span>
            </TableCell>
            <TableCell>
              <Badge variant="outline">{t('list.builtIn')}</Badge>{' '}
              {templates.some((tp) => tp.isDefault) ? null : (
                <Badge variant="default">{t('list.isDefault')}</Badge>
              )}
            </TableCell>
            <TableCell>
              <span className="text-sm text-slate-600 dark:text-slate-300">
                {PAPER_LABEL.letter} · {t('editor.portrait')}
              </span>
            </TableCell>
            <TableCell className="text-right">
              <NewTemplateButton recordType={recordType} asDuplicateOfStarter />
            </TableCell>
          </TableRow>
          {templates.map((tp) => (
            <TableRow key={tp.id}>
              <TableCell>
                <Link
                  href={`/admin/pdf-templates/${tp.id}`}
                  className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                >
                  {tp.name}
                </Link>
                {tp.description ? (
                  <span className="ml-2 text-xs text-slate-400">{tp.description}</span>
                ) : null}
              </TableCell>
              <TableCell>
                <Badge variant={tp.isActive ? 'success' : 'outline'}>
                  {tp.isActive ? tCommon('labels.active') : tCommon('labels.inactive')}
                </Badge>{' '}
                {tp.isDefault ? <Badge variant="default">{t('list.isDefault')}</Badge> : null}
              </TableCell>
              <TableCell>
                <span className="text-sm text-slate-600 dark:text-slate-300">
                  {PAPER_LABEL[tp.paperSize] ?? tp.paperSize} ·{' '}
                  {tp.orientation === 'landscape' ? t('editor.landscape') : t('editor.portrait')}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <DuplicateTemplateButton templateId={tp.id} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ListPageLayout>
  )
}
