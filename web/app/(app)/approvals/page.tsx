import { getMoneyFormatter } from '@/lib/money-server'
import { inArray, sql } from 'drizzle-orm'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { worklistGates, type WorklistGate } from '@openbooks/engine/src/flows/index.ts'
import {
  Badge,
  EmptyState,
  PageHeader,
  TabContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@openbooks/ui'
import { CheckCircle2, Send } from 'lucide-react'
import { ListPageLayout } from '../../../components/page-layout'
import { getAuthz, can } from '../../../lib/authz'
import { mergeHref, pickString } from '../../../lib/list-params'
import { approvalRecordHref } from '../../../lib/approvals-links'
import { ApprovalsTable, type ApprovalRow } from './ApprovalsTable'
import { DelegationBanner, OutOfOfficeButton } from './DelegationControls'
import type { DelegateOption } from './GateActions'

export const dynamic = 'force-dynamic'

/**
 * Approval hub — three searchParam-driven tabs over the Flows engine
 * (flow gates):
 *
 *   • mine      — everything I can act on (direct, role, delegated-to-me),
 *                 with counts-by-kind chips, aging, and bulk approve/reject.
 *   • submitted — where MY documents are: who they're pending with, since when.
 *   • all       — org-wide pending items (flows.manage / admin only).
 */

type Tab = 'mine' | 'submitted' | 'all'

// Document kinds with catalog labels — unknown kinds fall back to the raw code.
const KIND_KEYS = [
  'vendor_bill',
  'customer_invoice',
  'expense_report',
  'journal',
  'purchase_order',
  'sales_order',
  'quote',
  'close_run',
]

interface SubmittedRow {
  key: string
  documentNumber: string
  kind: string
  href: string | null
  party: string | null
  amount: string | null
  engineName: string
  pendingWith: string | null
  waitingSince: string
  status: string
}

function iso(d: unknown): string {
  return d ? new Date(d as string | Date).toISOString() : new Date().toISOString()
}

export default async function Approvals({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('approvals')
  const tc = await getTranslations('common')
  const authz = await getAuthz()
  if (!authz) return null
  const user = authz.user
  const orgId = user.orgId
  const canManageFlows = can(authz, 'flows.manage')
  const canSeeAll = canManageFlows

  const sp = await searchParams
  const rawTab = pickString(sp.tab)
  const tab: Tab =
    rawTab === 'submitted' ? 'submitted' : rawTab === 'all' && canSeeAll ? 'all' : 'mine'
  const kindFilter = pickString(sp.kind)

  const kindLabel = (kind: string) =>
    KIND_KEYS.includes(kind) ? t(`kinds.${kind}`) : kind.replace(/_/g, ' ')

  // ---- My approvals (always loaded: the tab label carries the count) -------
  const gates = await worklistGates(orgId, user.id)

  // Flow names for the gate rows (WorklistGate carries only flowId).
  const flowIds = [...new Set(gates.map((g) => g.flowId))]
  const flowNames = new Map<string, string>()
  if (flowIds.length > 0) {
    const rows = await db
      .select({ id: schema.flows.id, name: schema.flows.name })
      .from(schema.flows)
      .where(inArray(schema.flows.id, flowIds))
    for (const r of rows) flowNames.set(r.id, r.name)
  }

  const gateToRow = (g: WorklistGate, assignee: string | null): ApprovalRow => {
    const kind = g.document?.kind ?? g.subjectKind
    return {
      key: `gate:${g.id}`,
      gateId: g.id,
      documentNumber: g.document?.documentNumber ?? g.subjectLabel ?? g.subjectId.slice(0, 8),
      kind,
      kindLabel: kindLabel(kind),
      href:
        g.href ??
        approvalRecordHref(kind, g.subjectId),
      party: g.document?.partyName ?? null,
      amount: g.document ? money(g.document.total) : null,
      approvalTitle: g.title,
      engineName: flowNames.get(g.flowId) ?? '',
      requestedAt: iso(g.createdAt),
      assignee,
      canDelegate: canManageFlows || g.assigneeUserId === user.id,
      quorumAll: g.quorum === 'all',
      signatureRequired: g.signatureRequired,
    }
  }

  const mineRows: ApprovalRow[] = gates
    .map((g) => gateToRow(g, null))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
  const mineCount = mineRows.length

  // ---- All approvals (org-wide; only queried when the tab is open) ---------
  let allRows: ApprovalRow[] = []
  if (tab === 'all' && canSeeAll) {
    const gatesRes = (await db.execute<Record<string, any>>(sql`
      select g.id, g.flow_id as "flowId", g.title, g.quorum, g.created_at as "createdAt",
             g.signature_required as "signatureRequired",
             g.subject_kind as "subjectKind", g.subject_id as "subjectId",
             g.assignee_user_id as "assigneeUserId", g.assignee_role as "assigneeRole",
             u.name as "assigneeName", f.name as "flowName",
             d.document_number as "documentNumber", d.kind as "docKind", d.total,
             p.display_name as "partyName", cp.name as "closePeriodName"
        from flow_gates g
        join flows f on f.id = g.flow_id
        left join users u on u.id = g.assignee_user_id
        left join documents d on d.id = g.subject_id
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
        left join close_runs cr on cr.id = g.subject_id and g.subject_kind = 'close_run'
        left join accounting_periods cp on cp.id = cr.period_id
       where g.org_id = ${orgId} and g.status = 'pending'
       order by g.created_at
    `))

    allRows = gatesRes.rows
      .map((g): ApprovalRow => {
        const kind = String(g.docKind ?? g.subjectKind)
        return {
          key: `gate:${g.id}`,
          gateId: String(g.id),
          documentNumber: g.documentNumber
            ? String(g.documentNumber)
            : g.closePeriodName
              ? String(g.closePeriodName)
              : String(g.subjectId).slice(0, 8),
          kind,
          kindLabel: kindLabel(kind),
          href: approvalRecordHref(kind, String(g.subjectId)),
          party: g.partyName ?? null,
          amount: g.total != null ? money(g.total) : null,
          approvalTitle: String(g.title),
          engineName: String(g.flowName),
          requestedAt: iso(g.createdAt),
          assignee: g.assigneeName ?? g.assigneeRole ?? null,
          canDelegate: canManageFlows,
          quorumAll: g.quorum === 'all',
          signatureRequired: !!g.signatureRequired,
        }
      })
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
  }

  // ---- Submitted by me ------------------------------------------------------
  let submittedRows: SubmittedRow[] = []
  if (tab === 'submitted') {
    const flowRes = (await db.execute<Record<string, any>>(sql`
      select r.id as "runId", f.name as "flowName", r.subject_id as "subjectId",
             coalesce(d.document_number, cp.name) as "documentNumber",
             coalesce(d.kind, case when cr.id is not null then 'close_run' end, r.subject_kind) as kind,
             d.total, coalesce(d.status, cr.status) as "docStatus", p.display_name as "partyName",
             min(g.created_at) as "waitingSince",
             string_agg(distinct coalesce(u.name, g.assignee_role), ', ') as "pendingWith"
        from flow_runs r
        join flows f on f.id = r.flow_id
        join flow_gates g on g.run_id = r.id and g.status = 'pending'
        left join documents d on d.id = r.subject_id
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
        left join close_runs cr on cr.id = r.subject_id and r.subject_kind = 'close_run'
        left join accounting_periods cp on cp.id = cr.period_id
        left join users u on u.id = g.assignee_user_id
       where r.org_id = ${orgId} and r.status = 'waiting'
         and coalesce(d.created_by, cr.started_by) = ${user.id}
       group by r.id, f.name, r.subject_id, d.document_number, d.kind, d.total,
                d.status, cr.id, cr.status, cp.name, p.display_name
       order by min(g.created_at)
    `))

    submittedRows = flowRes.rows
      .map(
        (r): SubmittedRow => ({
          key: `run:${r.runId}`,
          documentNumber: String(r.documentNumber),
          kind: String(r.kind),
          href: approvalRecordHref(String(r.kind), String(r.subjectId)),
          party: r.partyName ?? null,
          amount: r.total != null ? money(r.total) : null,
          engineName: String(r.flowName),
          pendingWith: r.pendingWith ?? null,
          waitingSince: iso(r.waitingSince),
          status: String(r.docStatus),
        }),
      )
      .sort((a, b) => a.waitingSince.localeCompare(b.waitingSince))
  }

  // Delegate targets (row delegation + out-of-office picker).
  const usersRes = (await db.execute<DelegateOption>(sql`
    select id, name from users
     where org_id = ${orgId} and is_active and id <> ${user.id}
     order by name limit 500
  `))
  const delegateUsers = usersRes.rows

  // ---- Kind chips + filter (mine/all tabs) ----------------------------------
  const rowsForTab = tab === 'all' ? allRows : mineRows
  const chipCounts = new Map<string, number>()
  for (const r of rowsForTab) chipCounts.set(r.kind, (chipCounts.get(r.kind) ?? 0) + 1)
  const visibleRows = kindFilter ? rowsForTab.filter((r) => r.kind === kindFilter) : rowsForTab
  const visibleSubmitted = kindFilter
    ? submittedRows.filter((r) => r.kind === kindFilter)
    : submittedRows

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'mine', label: t('tabs.mine'), count: mineCount },
    { key: 'submitted', label: t('tabs.submitted') },
    ...(canSeeAll ? [{ key: 'all' as Tab, label: t('tabs.all') }] : []),
  ]

  const chips =
    tab !== 'submitted' && chipCounts.size > 0 ? (
      <div className="flex flex-wrap items-center gap-1.5">
        {[...chipCounts.entries()].map(([kind, count]) => {
          const active = kindFilter === kind
          return (
            <Link
              key={kind}
              href={mergeHref('/approvals', sp, { kind: active ? undefined : kind }) as any}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
                active
                  ? 'border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800/60',
              )}
            >
              {kindLabel(kind)}
              <span
                className={cn(
                  'tabular-nums',
                  active ? 'text-teal-600 dark:text-teal-400' : 'text-slate-400 dark:text-slate-500',
                )}
              >
                {count}
              </span>
            </Link>
          )
        })}
        {kindFilter ? (
          <Link
            href={mergeHref('/approvals', sp, { kind: undefined }) as any}
            className="text-xs text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
          >
            {tc('labels.all')}
          </Link>
        ) : null}
      </div>
    ) : null

  return (
    <ListPageLayout
      header={
        <div className="space-y-3">
          <PageHeader
            title={t('title')}
            description={t('description')}
            actions={<OutOfOfficeButton users={delegateUsers} />}
          />
          <DelegationBanner users={delegateUsers} />
          <nav className="flex items-center gap-1">
            {tabs.map(({ key, label, count }) => (
              <Link
                key={key}
                href={(key === 'mine' ? '/approvals' : `/approvals?tab=${key}`) as any}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  tab === key
                    ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                )}
              >
                {label}
                {typeof count === 'number' ? (
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-xs tabular-nums',
                      tab === key
                        ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/60 dark:text-teal-300'
                        : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
        </div>
      }
    >
      <TabContent tabKey={tab}>
        {tab === 'submitted' ? (
          visibleSubmitted.length === 0 ? (
            <EmptyState
              icon={<Send />}
              title={t('emptySubmitted.title')}
              description={t('emptySubmitted.description')}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('table.document')}</TableHead>
                  <TableHead>{t('table.kind')}</TableHead>
                  <TableHead>{tc('labels.party')}</TableHead>
                  <TableHead className="text-right">{tc('labels.amount')}</TableHead>
                  <TableHead>{t('table.approval')}</TableHead>
                  <TableHead>{t('table.pendingWith')}</TableHead>
                  <TableHead>{t('table.waitingSince')}</TableHead>
                  <TableHead>{tc('labels.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleSubmitted.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-mono text-[13px] font-semibold">
                      {r.href ? (
                        <Link
                          href={r.href as any}
                          className="text-teal-700 hover:underline dark:text-teal-300"
                        >
                          {r.documentNumber}
                        </Link>
                      ) : (
                        r.documentNumber
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{kindLabel(r.kind)}</Badge>
                    </TableCell>
                    <TableCell>{r.party}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.amount}</TableCell>
                    <TableCell>
                      <span className="text-slate-900 dark:text-slate-100">{r.engineName}</span>
                    </TableCell>
                    <TableCell>{r.pendingWith}</TableCell>
                    <TableCell className="text-slate-500 dark:text-slate-400">
                      {r.waitingSince.slice(0, 10)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.status.replace(/_/g, ' ')}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        ) : rowsForTab.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 />}
            title={tab === 'all' ? t('emptyAll.title') : t('empty.title')}
            description={tab === 'all' ? t('emptyAll.description') : t('empty.description')}
          />
        ) : (
          <div className="space-y-3">
            {chips}
            <ApprovalsTable
              rows={visibleRows}
              users={delegateUsers}
              bulk={tab === 'mine'}
              showAssignee={tab === 'all'}
              actionsEnabled={tab === 'mine' || canManageFlows}
            />
          </div>
        )}
      </TabContent>
    </ListPageLayout>
  )
}
