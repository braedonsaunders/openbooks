import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'
import { NewScriptButton, ScriptDrawer } from './ScriptDrawer'

export const dynamic = 'force-dynamic'

export default async function Scripts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('scripts.manage')
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'name', allowedSorts: ['name'] as const, perPage: 50 })
  const trigger = pickString(sp.trigger)
  const scriptId = pickString(sp.script)

  const where = sql`true
    ${trigger ? sql` and trigger_point = ${trigger}` : sql``}
    ${params.q ? sql` and name ilike ${'%' + params.q + '%'}` : sql``}`

  const [scripts, triggers, open, runs] = await Promise.all([
    db.execute(sql`
      select s.*, (select count(*) from script_runs r where r.script_id = s.id) as run_count,
             (select max(r.at) from script_runs r where r.script_id = s.id) as last_run
        from user_scripts s where ${where}
       order by s.trigger_point, s.sort_order, s.name limit ${params.perPage}
    `) as any,
    db.execute(sql`select trigger_point, count(*) as n from user_scripts group by 1`) as any,
    scriptId && scriptId !== 'new'
      ? (db.execute(sql`select * from user_scripts where id = ${scriptId}`) as any)
      : null,
    scriptId && scriptId !== 'new'
      ? (db.execute(sql`
          select status, error_message, logs, duration_ms, at, target_kind
            from script_runs where script_id = ${scriptId} order by at desc limit 20`) as any)
      : null,
  ])

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Scripts"
            description="Real JavaScript, run in a sandbox at document trigger points — validate, mutate whitelisted fields, or veto with ob.abort(). Every run is recorded."
            actions={<NewScriptButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search scripts…" />
            <FilterChips
              basePath="/admin/scripts"
              currentParams={sp}
              paramKey="trigger"
              label="Trigger"
              options={triggers.rows.map((r: any) => ({ value: r.trigger_point, label: r.trigger_point.replace('_', ' '), count: Number(r.n) }))}
            />
          </div>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Script</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead className="text-right">Runs</TableHead>
            <TableHead>Last run</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {scripts.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-slate-500 dark:text-slate-400">
                No scripts yet — automate a document workflow.
              </TableCell>
            </TableRow>
          ) : null}
          {scripts.rows.map((s: any) => (
            <TableRow key={s.id}>
              <TableCell>
                <a href={`/admin/scripts?script=${s.id}`} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                  {s.name}
                </a>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{String(s.trigger_point).replace('_', ' ')}</Badge>
              </TableCell>
              <TableCell className="text-slate-500 dark:text-slate-400">{s.document_kind ?? 'all'}</TableCell>
              <TableCell className="text-right tabular-nums">{s.run_count}</TableCell>
              <TableCell className="text-slate-500 dark:text-slate-400">{s.last_run ? dateTime(s.last_run) : ''}</TableCell>
              <TableCell>
                <Badge variant={s.is_active ? 'success' : 'outline'}>{s.is_active ? 'active' : 'disabled'}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {scriptId ? <ScriptDrawer script={open?.rows[0] ?? null} runs={runs?.rows ?? []} /> : null}
    </ListPageLayout>
  )
}
