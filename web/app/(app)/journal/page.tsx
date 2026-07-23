import { getMoneyFormatter } from '@/lib/money-server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { Eye } from 'lucide-react'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { parseListParams, pickString } from '../../../lib/list-params'
import { can, requirePermission } from '../../../lib/authz'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../lib/subsidiaries'
import { createDraftJournal, loadJournalDoc } from '../../../lib/journals'
import { JournalDrawer } from './JournalDrawer'
import { NewJournalButton } from './NewJournalButton'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { customSegmentOptions } from '../../../lib/segments'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  date: sql`e.posting_date`,
  number: sql`e.entry_number`,
  debits: sql`total_debits`,
} as const

// journal_entries.origin enum → message key under journal.origins.*
// (unknown/custom origins render verbatim).
const ORIGIN_KEYS: Record<string, string> = {
  manual: 'manual',
  closing: 'closing',
  allocation: 'allocation',
  revaluation: 'revaluation',
  labor_burden: 'laborBurden',
  depreciation: 'depreciation',
  revenue_recognition: 'revenueRecognition',
  fx_settlement: 'fxSettlement',
  translation: 'translation',
}

// journal_entries.status enum → common.status.* key (unknown values render verbatim).
const STATUS_KEYS: Record<string, string> = {
  posted: 'posted',
  reversed: 'reversed',
  draft: 'draft',
  voided: 'voided',
}

export default async function Journal({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('journal')
  const tc = await getTranslations('common')
  const authz = await requirePermission('gl.read')
  const sp = await searchParams
  const params = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 50,
    allowedSorts: ['date', 'number', 'debits'] as const,
  })
  const origin = pickString(sp.origin)
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
  const lineVisibility = allowedSubsidiaries
    ? allowedIds.length
      ? sql`and l.subsidiary_id = any(${`{${allowedIds.join(',')}}`}::uuid[])`
      : sql`and false`
    : sql``

  // ?entry= drives the manual-journal drawer over DOCUMENT ids;
  // posted-entry links to /journal/[id] are a separate, untouched surface.
  const entryParam = pickString(sp.entry)
  if (entryParam === 'new') {
    // deep-linkable instant draft: create it server-side, land on its drawer
    if (!can(authz, 'gl.post')) redirect('/journal')
    const draft = await createDraftJournal(authz.user.orgId, authz.user.id)
    redirect(`/journal?entry=${draft.id}`)
  }

  // The Journal list shows ONLY actual journal entries — never the GL posting
  // of a bill / invoice / payment / expense (those live in their subledger
  // module). An entry qualifies if its source document is a journal, or it's a
  // GL-native entry with no subledger document (closing, allocation, etc.).
  const journalsOnly = sql`(
    exists (select 1 from documents d where d.posted_entry_id = e.id and d.kind = 'journal')
    or (
      not exists (select 1 from documents d where d.posted_entry_id = e.id)
      and e.origin in ('manual','closing','allocation','revaluation','labor_burden',
                       'depreciation','revenue_recognition','fx_settlement','translation')
    )
  )`
  const where = sql`${journalsOnly}
    ${entryVisibility}
    ${origin ? sql` and e.origin = ${origin}` : sql``}
    ${params.q ? sql` and (e.entry_number ilike ${'%' + params.q + '%'} or e.memo ilike ${'%' + params.q + '%'})` : sql``}`

  const [entries, totalRow, origins] = await Promise.all([
    db.execute(sql`
      select e.id, e.entry_number, e.posting_date, e.memo, e.status, e.origin,
             count(l.id) as line_count,
             sum(case when l.amount > 0 then l.amount else 0 end) as total_debits,
             (select d.id from documents d where d.posted_entry_id = e.id and d.kind = 'journal' limit 1) as source_document_id
        from journal_entries e
        join journal_lines l on l.entry_id = e.id ${lineVisibility}
       where ${where}
       group by e.id
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`}, e.entry_number desc
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`select count(*) as n from journal_entries e where ${where}`) as any,
    db.execute(sql`select e.origin, count(*) as n from journal_entries e where ${journalsOnly} ${entryVisibility} group by e.origin order by count(*) desc`) as any,
  ])
  const total = Number(totalRow.rows[0].n)

  // draft manual journals are documents (not entries yet) — surfaced separately
  const [draftDocs, openJournal, pickers] = await Promise.all([
    db.execute(sql`
      select id, document_number, document_date, memo, total
        from documents
       where kind = 'journal' and status = 'draft'
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
  ])
  const resolvedForm = openJournal && pickers
    ? await resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: 'journal',
        userRoles: [authz.user.role],
        headerDefs: pickers[4] as any,
        lineDefs: pickers[5] as any,
        explicitLayoutId: pickString(sp.form),
      })
    : null

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description', { count: total })}
            actions={<NewJournalButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips
              basePath="/journal"
              currentParams={sp}
              paramKey="origin"
              label={t('list.originFilter')}
              options={origins.rows.map((r: any) => ({
                value: r.origin,
                label: ORIGIN_KEYS[r.origin] ? t(`origins.${ORIGIN_KEYS[r.origin]}`) : r.origin,
                count: Number(r.n),
              }))}
            />
          </div>
        </>
      }
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
                href={`/journal?entry=${d.id}`}
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
      <Table>
        <TableHeader>
          <TableRow>
            <SortTh basePath="/journal" currentParams={sp} column="date" sort={params.sort} dir={params.dir}>{tc('labels.date')}</SortTh>
            <SortTh basePath="/journal" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>{t('list.columns.entry')}</SortTh>
            <TableHead>{tc('labels.memo')}</TableHead>
            <TableHead>{t('list.columns.origin')}</TableHead>
            <TableHead className="text-right">{tc('labels.lines')}</TableHead>
            <SortTh basePath="/journal" currentParams={sp} column="debits" sort={params.sort} dir={params.dir} align="right">{t('list.columns.debits')}</SortTh>
            <TableHead>{tc('labels.status')}</TableHead>
            <TableHead className="w-16 px-2 text-center">{tc('labels.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.rows.map((e: any) => (
            <TableRow key={e.id}>
              <TableCell className="whitespace-nowrap">{e.posting_date}</TableCell>
              <TableCell className="font-mono text-[13px] font-semibold">
                {/* Manual journals open the editable JournalDrawer (?entry=<docId>);
                    GL-native entries with no source document open the read-only
                    entry flyout (?txn=<entryId>) — never the bare full page. */}
                <Link
                  href={e.source_document_id ? `/journal?entry=${e.source_document_id}` : `/journal?txn=${e.id}`}
                  className="text-teal-700 hover:underline dark:text-teal-300"
                  scroll={false}
                >
                  {e.entry_number}
                </Link>
              </TableCell>
              <TableCell className="max-w-md truncate text-slate-500 dark:text-slate-400">{e.memo}</TableCell>
              <TableCell>
                <Badge variant="secondary">
                  {ORIGIN_KEYS[e.origin] ? t(`origins.${ORIGIN_KEYS[e.origin]}`) : e.origin}
                </Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">{e.line_count}</TableCell>
              <TableCell className="text-right tabular-nums">{money(e.total_debits)}</TableCell>
              <TableCell>
                <Badge variant={e.status === 'posted' ? 'success' : e.status === 'reversed' ? 'destructive' : 'secondary'}>
                  {STATUS_KEYS[e.status] ? tc(`status.${STATUS_KEYS[e.status]}`) : e.status}
                </Badge>
              </TableCell>
              <TableCell className="w-11">
                <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
                  <Link
                    href={e.source_document_id ? `/journal?entry=${e.source_document_id}` : `/journal?txn=${e.id}`}
                    aria-label={tc('actions.open')}
                    title={tc('actions.open')}
                    scroll={false}
                  >
                    <Eye size={14} />
                  </Link>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="mt-3">
        <Pagination basePath="/journal" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
      </div>
      {openJournal && pickers ? (
        <JournalDrawer
          journal={openJournal as any}
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
    </ListPageLayout>
  )
}
