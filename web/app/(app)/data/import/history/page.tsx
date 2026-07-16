import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import Link from 'next/link'
import { ListPageLayout } from '../../../../../components/page-layout'
import { requirePermission } from '../../../../../lib/authz'
import { dateTime } from '../../../../../lib/format'

export const dynamic = 'force-dynamic'

interface JobRow {
  id: string
  resource_key: string
  resource_label: string | null
  format: string
  file_name: string | null
  status: string
  total_rows: number
  created_count: number
  updated_count: number
  failed_count: number
  created_at: string
  actor_name: string | null
}

export default async function ImportHistoryPage() {
  const authz = await requirePermission('data.import')
  const t = await getTranslations('data')

  const result = (await db.execute(sql`
    select j.id, j.resource_key, j.resource_label, j.format, j.file_name, j.status,
           j.total_rows, j.created_count, j.updated_count, j.failed_count, j.created_at,
           u.name as actor_name
      from import_jobs j
      left join users u on u.id = j.created_by
     where j.org_id = ${authz.user.orgId}
     order by j.created_at desc
     limit 200`)) as unknown as { rows: JobRow[] }
  const jobs = result.rows

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('history.title')}
          description={t('history.description')}
          actions={
            <Button asChild>
              <Link href="/data/import">{t('nav.import')}</Link>
            </Button>
          }
        />
      }
    >
      {jobs.length === 0 ? (
        <EmptyState title={t('history.empty')} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('history.when')}</TableHead>
              <TableHead>{t('history.resource')}</TableHead>
              <TableHead>{t('history.format')}</TableHead>
              <TableHead>{t('history.status')}</TableHead>
              <TableHead className="text-right">{t('history.rows')}</TableHead>
              <TableHead>{t('history.by')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <TableRow key={j.id}>
                <TableCell className="whitespace-nowrap">{dateTime(j.created_at)}</TableCell>
                <TableCell>
                  <div className="font-medium">{j.resource_label ?? j.resource_key}</div>
                  {j.file_name && <div className="text-xs text-muted-foreground">{j.file_name}</div>}
                </TableCell>
                <TableCell className="uppercase">{j.format}</TableCell>
                <TableCell>
                  <Badge variant={j.status === 'failed' ? 'outline' : 'success'}>{j.status}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">+{j.created_count}</span>
                  {' / '}
                  <span className="text-sky-600 dark:text-sky-400">~{j.updated_count}</span>
                  {j.failed_count > 0 && (
                    <>
                      {' / '}
                      <span className="text-rose-600 dark:text-rose-400">✕{j.failed_count}</span>
                    </>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{j.actor_name ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ListPageLayout>
  )
}
