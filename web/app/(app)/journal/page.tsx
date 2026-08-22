import { getMoneyFormatter } from '@/lib/money-server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { EntityListView } from '../../../components/entity-list-view'
import { buildListDrawerHref, pickString } from '../../../lib/list-params'
import { can, requirePermission } from '../../../lib/authz'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../lib/subsidiaries'
import { createDraftJournal, loadJournalDoc } from '../../../lib/journals'
import { JournalDrawer } from './JournalDrawer'
import { NewJournalButton } from './NewJournalButton'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { customSegmentOptions } from '../../../lib/segments'

export const dynamic = 'force-dynamic'

export default async function Journal({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('journal')
  const authz = await requirePermission('gl.read')
  const sp = await searchParams
  const allowedSubsidiaries = authz.allowedSubsidiaryIds
  const allowedIds = allowedSubsidiaries ? [...allowedSubsidiaries] : []
  const entryVisibility = allowedSubsidiaries
    ? allowedIds.length
      ? sql`and exists (
          select 1 from journal_lines visible
           where visible.entry_id = e.id
             and visible.subsidiary_id = any(${`{${allowedIds.join(',')}}`}::uuid[])
        )`
      : sql`and false`
    : sql``

  // ?entry= drives the manual-journal drawer over DOCUMENT ids;
  // posted-entry links to /journal/[id] are a separate, untouched surface.
  const entryParam = pickString(sp.entry)
  if (entryParam === 'new') {
    // deep-linkable instant draft: create it server-side, land on its drawer
    if (!can(authz, 'gl.post')) redirect('/journal')
    const draft = await createDraftJournal(authz.user.orgId, authz.user.id)
    redirect(`/journal?entry=${draft.id}&mode=edit`)
  }

  // The Journal list shows ONLY actual journal entries — never the GL posting
  // of a bill / invoice / payment / expense (those live in their subledger
  // module). An entry qualifies if its source document is a journal, or it's a
  // GL-native entry with no subledger document (closing, allocation, etc.).
  const journalsOnly = sql`(
    exists (select 1 from documents d where d.posted_entry_id = e.id and d.org_id = e.org_id and d.kind = 'journal')
    or (
      not exists (select 1 from documents d where d.posted_entry_id = e.id and d.org_id = e.org_id)
      and e.origin in ('manual','closing','allocation','revaluation','labor_burden',
                       'depreciation','revenue_recognition','fx_settlement','translation')
    )
  )`
  // draft manual journals are documents (not entries yet) — surfaced separately
  const [draftDocs, openJournal, pickers, postedCount] = await Promise.all([
    db.execute(sql`
      select id, document_number, document_date, memo, total
        from documents
       where org_id = ${authz.user.orgId} and kind = 'journal' and status = 'draft'
         ${allowedSubsidiaries
           ? allowedIds.length
             ? sql`and subsidiary_id = any(${`{${allowedIds.join(',')}}`}::uuid[])`
             : sql`and false`
           : sql``}
       order by created_at desc
       limit 20
    `) as any,
    entryParam ? loadJournalDoc(entryParam, authz.user.orgId).then((journal) => {
      if (!journal || !allowedSubsidiaries) return journal
      return allowedSubsidiaries.has(String(journal.doc.subsidiary_id)) ? journal : null
    }) : null,
    entryParam
      ? Promise.all([
          db.execute(sql`select id, display_name from parties where org_id = ${authz.user.orgId} and is_active order by display_name limit 2000`) as any,
          db.execute(sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and is_active and not is_summary order by number nulls last`) as any,
          db.execute(sql`select id, name from departments where org_id = ${authz.user.orgId} and is_active order by name`) as any,
          db.execute(sql`select id, name from projects where org_id = ${authz.user.orgId} and is_active order by name limit 2000`) as any,
          loadFieldDefs('documents', 'journal'),
          loadFieldDefs('document_lines', 'journal'),
          // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
          isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
            if (!multi) return null
            const options = await subsidiaryOptions()
            return allowedSubsidiaries ? options.filter((option) => allowedSubsidiaries.has(option.id)) : options
          }),
          customSegmentOptions(authz.user.orgId),
        ])
      : null,
    db.execute(sql`select count(*) as n from journal_entries e where e.org_id = ${authz.user.orgId} and ${journalsOnly} ${entryVisibility}`) as any,
  ])
  const total = Number(postedCount.rows[0]?.n ?? 0)
  const resolvedForm = openJournal && pickers
    ? await resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: 'journal',
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: pickers[4] as any,
        lineDefs: pickers[5] as any,
        explicitLayoutId: pickString(sp.form),
      })
    : null

  return (
    <ListPageLayout
      header={<PageHeader title={t('list.title')} description={t('list.description', { count: total })} actions={<NewJournalButton />} />}
    >
      {draftDocs.rows.length > 0 ? (
        <div className="mb-4 rounded-lg border border-dashed border-slate-200 bg-slate-50/60 p-3 dark:border-slate-700 dark:bg-slate-900/40">
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            {t('list.draftsHeading')}
          </p>
          <div className="flex flex-col gap-0.5">
            {draftDocs.rows.map((d: any) => (
              <Link
                key={d.id}
                href={buildListDrawerHref('/journal', sp, 'entry', String(d.id)) as any}
                className="flex items-center gap-3 rounded px-1.5 py-1 text-sm hover:bg-white dark:hover:bg-slate-800/60"
              >
                <span className="font-mono text-[13px] font-semibold text-teal-700 dark:text-teal-300">
                  {d.document_number}
                </span>
                <span className="whitespace-nowrap text-slate-500 dark:text-slate-400">{d.document_date}</span>
                <span className="min-w-0 flex-1 truncate text-slate-500 dark:text-slate-400">{d.memo}</span>
                <span className="tabular-nums">{money(d.total)}</span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
      <EntityListView
        recordType="journal"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={openJournal && pickers ? (
          <JournalDrawer
            journal={openJournal as any}
            initialMode={pickString(sp.mode) === 'edit' ? 'edit' : 'view'}
            parties={pickers[0].rows}
            accounts={pickers[1].rows}
            departments={pickers[2].rows}
            projects={pickers[3].rows}
            subsidiaries={pickers[6] ?? undefined}
            headerDefs={pickers[4] as any}
            lineDefs={pickers[5] as any}
            layout={resolvedForm?.layout}
            segments={pickers[7] as any}
          />
        ) : null}
        emptyAction={<NewJournalButton />}
      />
    </ListPageLayout>
  )
}
