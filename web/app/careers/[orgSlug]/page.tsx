import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db, withBypassContext } from '@openbooks/engine/src/platform/db.ts'
import { isFeatureEnabled } from '../../../lib/features'
import { orgSlugFor, resolveOrgBySlug } from '../../../lib/recruiting-public'
import { CareersApplyForm } from './CareersApplyForm'

export const dynamic = 'force-dynamic'

/**
 * Internal career page — public, outside the app shell: plain, accessible,
 * mobile-first. Lists the org's published postings for open requisitions
 * (read-only aggregate rows: title, requisition number, published date —
 * never internal funnel state), with a detail section and the apply form
 * writing an application with consent capture. Brand reads the org name.
 * An unknown or ambiguous slug 404s; a switched-off surface 404s.
 */
export default async function CareersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { orgSlug } = await params
  const sp = await searchParams
  const t = await getTranslations('hrm')
  const org = await resolveOrgBySlug(decodeURIComponent(orgSlug))
  if (!org) notFound()
  if (!(await isFeatureEnabled(org.orgId, 'hrmRecruiting'))) notFound()
  if (!(await isFeatureEnabled(org.orgId, 'hrmJobBoards'))) notFound()

  const postings = await withBypassContext(async () => {
    const rows = (
      await db.execute<{ postingId: string; requisitionNumber: string; title: string; publishedAt: string | null }>(sql`
        select p.id as "postingId", r.requisition_number as "requisitionNumber",
               r.title, p.published_at as "publishedAt"
          from hrm_job_postings p
          join hrm_requisitions r on r.org_id = p.org_id and r.id = p.requisition_id
         where p.org_id = ${org.orgId} and p.status = 'published' and r.status = 'open'
         order by p.published_at desc
      `)
    ).rows
    return rows
  })

  const selected = sp.posting ? postings.find((posting) => posting.postingId === sp.posting) : null
  if (sp.posting && !selected) notFound()

  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-white px-6 py-10">
      <p className="text-xs uppercase tracking-widest text-slate-400">
        {t('public.careers.kicker', { org: org.name })}
      </p>
      <h1 className="mt-1 text-xl font-semibold">{t('public.careers.title')}</h1>
      {postings.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">{t('public.careers.empty')}</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {postings.map((posting) => (
            <li key={posting.postingId} className="rounded-md border p-4">
              <a
                href={`/careers/${orgSlugFor(org.name)}?posting=${posting.postingId}`}
                className="text-sm font-medium underline"
              >
                {posting.title}
              </a>
              <p className="mt-1 text-xs text-slate-500">
                {posting.requisitionNumber}
                {posting.publishedAt ? ` · ${posting.publishedAt.slice(0, 10)}` : ''}
              </p>
              {selected?.postingId === posting.postingId && (
                <CareersApplyForm postingId={posting.postingId} />
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
