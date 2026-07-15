import { getTranslations } from 'next-intl/server'
import { Badge } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { parseListParams } from '../../../lib/list-params'
import { requirePermission } from '../../../lib/authz'
import { loadApiSchema, type ApiRecordTypeSchema } from '../../../lib/api/schema-registry'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('apiDocs')
  return { title: t('metaTitle') }
}

const METHOD_STYLES: Record<string, string> = {
  get: 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
  post: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  patch: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  delete: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
}

export default async function ApiDocsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('api.keys.manage')
  const t = await getTranslations('apiDocs')
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'name', allowedSorts: ['name'] as const, perPage: 100 })

  const schema = await loadApiSchema(authz.user.orgId)

  const filtered = params.q
    ? schema.filter((rt) =>
        rt.label.toLowerCase().includes(params.q!.toLowerCase()) ||
        rt.key.toLowerCase().includes(params.q!.toLowerCase()) ||
        rt.description.toLowerCase().includes(params.q!.toLowerCase()))
    : schema

  return (
    <ListPageLayout
      header={
        <>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {t('title')}
          </h1>
          <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            {t('description')}
          </p>
          <div className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-2 text-sm">
              <Badge variant="secondary">v1</Badge>
              <code className="font-mono text-[13px] text-slate-600 dark:text-slate-300">
                {t('baseUrl')}
              </code>
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400">
              <p>{t('auth.title')}: <code className="font-mono text-[12px]">Authorization: Bearer ob_live_…</code></p>
              <p className="mt-1">{t('auth.description')}</p>
            </div>
          </div>
          <div className="mt-3">
            <SearchInput placeholder={t('searchPlaceholder')} />
          </div>
        </>
      }
    >
      <div className="space-y-8">
        {filtered.map((rt: ApiRecordTypeSchema) => (
          <section key={rt.key} className="rounded-lg border border-slate-200 dark:border-slate-800">
            <div className="border-b border-slate-200 bg-slate-50/60 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
              <div className="flex items-center gap-3">
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {rt.label}
                </h2>
                {rt.dynamic ? <Badge variant="secondary">{t('customBadge')}</Badge> : null}
                <code className="font-mono text-[12px] text-slate-400">{rt.path}</code>
              </div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{rt.description}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {rt.operations.map((op) => (
                  <span
                    key={op}
                    className={`rounded px-2 py-0.5 font-mono text-[11px] font-semibold uppercase ${METHOD_STYLES[op === 'list' ? 'get' : op] ?? ''}`}
                  >
                    {op === 'list' ? 'GET' : op.toUpperCase()}
                  </span>
                ))}
                <span className="text-[11px] text-slate-400">
                  {t('requires')} <code className="font-mono">{rt.readPermission}</code>
                  {rt.writePermission ? (
                    <> · {t('writesRequire')} <code className="font-mono">{rt.writePermission}</code></>
                  ) : null}
                </span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-400 dark:border-slate-800">
                    <th className="px-4 py-2 font-medium">{t('fields.field')}</th>
                    <th className="px-4 py-2 font-medium">{t('fields.type')}</th>
                    <th className="px-4 py-2 font-medium">{t('fields.required')}</th>
                    <th className="px-4 py-2 font-medium">{t('fields.description')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rt.fields.map((f) => (
                    <tr key={f.name} className="border-b border-slate-100 last:border-0 dark:border-slate-800/50">
                      <td className="px-4 py-2 font-mono text-[12px] text-slate-700 dark:text-slate-300">
                        {f.name}
                        {f.custom ? <span className="ml-1.5 text-[10px] text-teal-600 dark:text-teal-400">custom</span> : null}
                      </td>
                      <td className="px-4 py-2 font-mono text-[12px] text-slate-500 dark:text-slate-400">{f.type}</td>
                      <td className="px-4 py-2">
                        {f.required ? <Badge variant="warning">{t('fields.yes')}</Badge> : null}
                      </td>
                      <td className="px-4 py-2 text-slate-500 dark:text-slate-400">{f.description ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Endpoint examples */}
            <div className="space-y-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
              {rt.operations.includes('list') ? (
                <div className="flex items-start gap-2 text-[12px]">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono font-semibold uppercase ${METHOD_STYLES.get}`}>
                    GET
                  </span>
                  <code className="font-mono text-slate-600 dark:text-slate-300">
                    {rt.path}?page=1&perPage=25&q=
                  </code>
                </div>
              ) : null}
              {rt.operations.includes('get') ? (
                <div className="flex items-start gap-2 text-[12px]">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono font-semibold uppercase ${METHOD_STYLES.get}`}>
                    GET
                  </span>
                  <code className="font-mono text-slate-600 dark:text-slate-300">
                    {rt.path}/{'{id}'}
                  </code>
                </div>
              ) : null}
              {rt.operations.includes('create') ? (
                <div className="flex items-start gap-2 text-[12px]">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono font-semibold uppercase ${METHOD_STYLES.post}`}>
                    POST
                  </span>
                  <code className="font-mono text-slate-600 dark:text-slate-300">{rt.path}</code>
                </div>
              ) : null}
              {rt.operations.includes('update') ? (
                <div className="flex items-start gap-2 text-[12px]">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono font-semibold uppercase ${METHOD_STYLES.patch}`}>
                    PATCH
                  </span>
                  <code className="font-mono text-slate-600 dark:text-slate-300">
                    {rt.path}/{'{id}'}
                  </code>
                </div>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </ListPageLayout>
  )
}
