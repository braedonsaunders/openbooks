import Link from 'next/link'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'
import { can, getAuthz } from '../../../lib/authz'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { createDraftJournal, loadJournalDoc } from '../../../lib/journals'
import { JournalDrawer } from './JournalDrawer'
import { NewJournalButton } from './NewJournalButton'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  date: sql`e.posting_date`,
  number: sql`e.entry_number`,
  debits: sql`total_debits`,
} as const

export default async function Journal({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const params = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 50,
    allowedSorts: ['date', 'number', 'debits'] as const,
  })
  const origin = pickString(sp.origin)

  // ?entry= drives the manual-journal drawer over DOCUMENT ids;
  // posted-entry links to /journal/[id] are a separate, untouched surface.
  const entryParam = pickString(sp.entry)
  if (entryParam === 'new') {
    // deep-linkable instant draft: create it server-side, land on its drawer
    const authz = await getAuthz()
    if (!authz) redirect('/login')
    if (!can(authz, 'gl.post')) redirect('/journal')
    const draft = await createDraftJournal(authz.user.orgId, authz.user.id)
    redirect(`/journal?entry=${draft.id}`)
  }

  const where = sql`true
    ${origin ? sql` and e.origin = ${origin}` : sql``}
    ${params.q ? sql` and (e.entry_number ilike ${'%' + params.q + '%'} or e.memo ilike ${'%' + params.q + '%'})` : sql``}`

  const [entries, totalRow, origins] = await Promise.all([
    db.execute(sql`
      select e.id, e.entry_number, e.posting_date, e.memo, e.status, e.origin,
             count(l.id) as line_count,
             sum(case when l.amount > 0 then l.amount else 0 end) as total_debits
        from journal_entries e
        join journal_lines l on l.entry_id = e.id
       where ${where}
       group by e.id
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`}, e.entry_number desc
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`select count(*) as n from journal_entries e where ${where}`) as any,
    db.execute(sql`select origin, count(*) as n from journal_entries group by origin order by count(*) desc`) as any,
  ])
  const total = Number(totalRow.rows[0].n)

  // draft manual journals are documents (not entries yet) — surfaced separately
  const [draftDocs, openJournal, pickers] = await Promise.all([
    db.execute(sql`
      select id, document_number, document_date, memo, total
        from documents
       where kind = 'journal' and status = 'draft'
       order by created_at desc
       limit 20
    `) as any,
    entryParam ? loadJournalDoc(entryParam) : null,
    entryParam
      ? Promise.all([
          db.execute(sql`select id, display_name from parties where is_active order by display_name limit 2000`) as any,
          db.execute(sql`select id, number, name from accounts where is_active and not is_summary order by number nulls last`) as any,
          db.execute(sql`select id, name from departments where is_active order by name`) as any,
          db.execute(sql`select id, name from projects where is_active order by name limit 2000`) as any,
          loadFieldDefs('documents', 'journal'),
          loadFieldDefs('document_lines', 'journal'),
        ])
      : null,
  ])

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Journal"
            description={`${total.toLocaleString()} posted entries · immutable, append-only.`}
            actions={<NewJournalButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search entry number or memo…" />
            <FilterChips
              basePath="/journal"
              currentParams={sp}
              paramKey="origin"
              label="Origin"
              options={origins.rows.map((r: any) => ({ value: r.origin, label: r.origin, count: Number(r.n) }))}
            />
          </div>
        </>
      }
    >
      {draftDocs.rows.length > 0 ? (
        <div className="mb-4 rounded-lg border border-dashed border-slate-200 bg-slate-50/60 p-3 dark:border-slate-700 dark:bg-slate-900/40">
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            Draft journals — not yet posted
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
            <SortTh basePath="/journal" currentParams={sp} column="date" sort={params.sort} dir={params.dir}>Date</SortTh>
            <SortTh basePath="/journal" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>Entry</SortTh>
            <TableHead>Memo</TableHead>
            <TableHead>Origin</TableHead>
            <TableHead className="text-right">Lines</TableHead>
            <SortTh basePath="/journal" currentParams={sp} column="debits" sort={params.sort} dir={params.dir} align="right">Debits</SortTh>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.rows.map((e: any) => (
            <TableRow key={e.id}>
              <TableCell className="whitespace-nowrap">{e.posting_date}</TableCell>
              <TableCell className="font-mono text-[13px] font-semibold">
                <Link href={`/journal/${e.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                  {e.entry_number}
                </Link>
              </TableCell>
              <TableCell className="max-w-md truncate text-slate-500 dark:text-slate-400">{e.memo}</TableCell>
              <TableCell>
                <Badge variant="secondary">{e.origin}</Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">{e.line_count}</TableCell>
              <TableCell className="text-right tabular-nums">{money(e.total_debits)}</TableCell>
              <TableCell>
                <Badge variant={e.status === 'posted' ? 'success' : e.status === 'reversed' ? 'destructive' : 'secondary'}>
                  {e.status}
                </Badge>
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
          headerDefs={pickers[4] as any}
          lineDefs={pickers[5] as any}
        />
      ) : null}
    </ListPageLayout>
  )
}
