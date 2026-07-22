import Link from 'next/link'
import { Plus } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { Pagination } from '../../../../../components/pagination'
import { SearchInput } from '../../../../../components/search-input'
import { mergeHref } from '../../../../../lib/list-params'

export interface SegmentValueRow {
  id: string
  code: string | null
  name: string
  is_active: boolean
}

interface Props {
  segmentName: string
  rows: SegmentValueRow[]
  total: number
  page: number
  perPage: number
  currentParams: Record<string, string | string[] | undefined>
}

/** The selectable values owned by an open (custom) Segment drawer. */
export async function SegmentValuesTab({
  segmentName,
  rows,
  total,
  page,
  perPage,
  currentParams,
}: Props) {
  const t = await getTranslations('admin.setup')
  const createHref = mergeHref('/admin/setup/segment-definitions', currentParams, {
    setupTab: 'segment-values',
    valueRow: 'new',
  })

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 text-sm text-slate-600 dark:text-slate-300">
          {t('segmentValues.description', { name: segmentName })}
        </p>
        <Button asChild size="sm">
          <Link href={createHref as any}>
            <Plus size={14} />
            {t('segmentValues.new')}
          </Link>
        </Button>
      </div>

      <SearchInput
        placeholder={t('segmentValues.searchPlaceholder')}
        paramKey="segValQ"
        pageParamKey="segValPage"
        className="sm:w-full"
      />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('fields.code')}</TableHead>
              <TableHead>{t('fields.name')}</TableHead>
              <TableHead>{t('fields.isActive')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-slate-500 dark:text-slate-400">
                  {t('segmentValues.empty')}
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((row) => {
              const editHref = mergeHref('/admin/setup/segment-definitions', currentParams, {
                setupTab: 'segment-values',
                valueRow: row.id,
              })
              return (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.code || '—'}</TableCell>
                  <TableCell>
                    <Link
                      href={editHref as any}
                      className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {row.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.is_active ? 'success' : 'outline'}>
                      {row.is_active ? t('statusActive') : t('statusArchived')}
                    </Badge>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <Pagination
          basePath="/admin/setup/segment-definitions"
          currentParams={currentParams}
          total={total}
          page={page}
          perPage={perPage}
          pageParamKey="segValPage"
        />
      </div>
    </div>
  )
}
