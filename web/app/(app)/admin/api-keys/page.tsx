import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { Pagination } from '../../../../components/pagination'
import { isUuid, parseListParams } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'
import { NewKeyButton, KeyDrawer } from './KeyDrawer'

export const dynamic = 'force-dynamic'

export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('api.keys.manage')
  const t = await getTranslations('admin.apiKeys')
  const tHub = await getTranslations('admin.hub')
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'created', allowedSorts: ['created', 'name'] as const, perPage: 50 })
  const keyId = sp.key as string | undefined

  const where = sql`k.org_id = ${authz.user.orgId}
    ${params.q ? sql` and (k.name ilike ${'%' + params.q + '%'} or u.name ilike ${'%' + params.q + '%'} or u.email ilike ${'%' + params.q + '%'})` : sql``}`

  const [keys, totalRow] = await Promise.all([
    db.execute(sql`
      select k.id, k.name, k.description, k.key_prefix, k.key_preview, k.scopes,
             k.is_active, k.expires_at, k.last_used_at, k.created_at,
             u.name as owner_name, u.email as owner_email
        from api_keys k
        join users u on u.id = k.user_id
       where ${where}
       order by k.created_at desc
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select count(*) as n from api_keys k
        join users u on u.id = k.user_id
       where ${where}`) as any,
  ])

  // Org-scoped, UUID-validated lookup with an explicit column list — key_hash
  // never leaves the server (a non-UUID id is simply treated as not found).
  const open = keyId && keyId !== 'new' && isUuid(keyId)
    ? (await db.execute(sql`
        select k.id, k.name, k.description, k.key_prefix, k.key_preview, k.scopes,
               k.is_active, k.expires_at, k.last_used_at, k.created_at,
               u.name as owner_name, u.email as owner_email
          from api_keys k
          join users u on u.id = k.user_id
         where k.id = ${keyId} and k.org_id = ${authz.user.orgId}`) as any)
    : null

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/admin', label: tHub('title') }}
            title={t('title')}
            description={t('description')}
            actions={<NewKeyButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('searchPlaceholder')} />
          </div>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('table.name')}</TableHead>
            <TableHead>{t('table.key')}</TableHead>
            <TableHead>{t('table.owner')}</TableHead>
            <TableHead>{t('table.scopes')}</TableHead>
            <TableHead>{t('table.lastUsed')}</TableHead>
            <TableHead>{t('table.status')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-slate-500 dark:text-slate-400">
                {t('empty')}
              </TableCell>
            </TableRow>
          ) : null}
          {keys.rows.map((k: any) => (
            <TableRow key={k.id}>
              <TableCell>
                <Link href={`/admin/api-keys?key=${k.id}`} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                  {k.name}
                </Link>
              </TableCell>
              <TableCell>
                <code className="font-mono text-[12px] text-slate-500 dark:text-slate-400">
                  {k.key_prefix}…{k.key_preview}
                </code>
              </TableCell>
              <TableCell className="text-slate-500 dark:text-slate-400">
                {k.owner_name} <span className="text-slate-400">· {k.owner_email}</span>
              </TableCell>
              <TableCell className="text-slate-500 dark:text-slate-400">
                {Array.isArray(k.scopes) && k.scopes.length > 0
                  ? t('table.scopesCount', { count: k.scopes.length })
                  : t('table.fullScope')}
              </TableCell>
              <TableCell className="text-slate-500 dark:text-slate-400">
                {k.last_used_at ? dateTime(k.last_used_at) : '—'}
              </TableCell>
              <TableCell>
                <Badge variant={k.is_active ? 'success' : 'outline'}>
                  {k.is_active ? t('statusActive') : t('statusRevoked')}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="mt-3">
        <Pagination basePath="/admin/api-keys" currentParams={sp} total={Number(totalRow.rows[0].n)} page={params.page} perPage={params.perPage} />
      </div>

      {keyId ? <KeyDrawer keyRow={open?.rows[0] ?? null} /> : null}
    </ListPageLayout>
  )
}
