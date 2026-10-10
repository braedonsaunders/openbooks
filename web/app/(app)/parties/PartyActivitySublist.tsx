'use client'

/**
 * The customer drawer's Activities tab — the reference composition for every
 * drawer sublist (see components/drawer-sublist).
 */
import { DrawerSublist, SublistAddButton, SublistEmpty, SublistLoading, SublistPager } from '../../../components/drawer-sublist'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useViewerFormat } from '@/lib/viewer-format'
import { CalendarDays } from 'lucide-react'
import { toast } from 'sonner'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { useAppAction } from '@/lib/use-app-action'
import { readApiErrorMessage } from '@/lib/api-error'
import { Badge, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'

interface ActivityRow {
  id: string
  kind: 'task' | 'call' | 'event' | 'email' | 'note'
  status: 'planned' | 'in_progress' | 'completed' | 'cancelled'
  subject: string
  activity_date: string
}

interface ActivityResponse {
  rows: ActivityRow[]
  total: number
  page: number
  perPage: number
  kinds: ActivityRow['kind'][]
  statuses: ActivityRow['status'][]
}

/** Exported for the refusal-path regression test: the drawer mounts it by tab. */
export function ActivitySublist({ partyId, canManage }: { partyId: string; canManage: boolean }) {
  const { dateTime } = useViewerFormat()
  const t = useTranslations('parties.drawer')
  const tcrm = useTranslations('crm')
  const tc = useTranslations('common')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { busy, execute } = useAppAction()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ key: string; value: ActivityResponse } | null>(null)
  const [loading, setLoading] = useState(true)
  const requestKey = JSON.stringify([partyId, q.trim(), kind, status, page])
  const visibleData = data?.key === requestKey ? data.value : null

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      const params = new URLSearchParams({ page: String(page) })
      if (q.trim()) params.set('q', q.trim())
      if (kind) params.set('kind', kind)
      if (status) params.set('status', status)
      fetch(`/api/parties/${partyId}/activities?${params}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(await readApiErrorMessage(response, tc('feedback.loadFailed')))
          const payload = (await response.json()) as ActivityResponse
          if (!controller.signal.aborted) setData({ key: requestKey, value: payload })
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          toast.error(error instanceof Error ? error.message : tc('feedback.loadFailed'))
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, q ? 200 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [kind, page, partyId, q, requestKey, status, tc])

  const pages = Math.max(1, Math.ceil((visibleData?.total ?? 0) / (visibleData?.perPage ?? 15)))
  // Activities are full CRM records with their own editor, so Add mints the
  // draft already linked to this account and hands off to that editor —
  // carrying `drawerReturn` so Close lands back on this flyout rather than
  // stranding the user on the activities list. The row links do the same.
  const activityHref = (id: string) => {
    const current = searchParams.toString()
    const back = current ? `${pathname}?${current}` : pathname
    return `/crm/activities?activity=${id}&drawerReturn=${encodeURIComponent(back)}`
  }
  const addActivity = async () => {
    let createdId: string | null = null
    const ok = await execute<{ id?: string }>(
      async () => {
        const result = await fetchAction<{ id?: string }>('/api/crm/activities/draft', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subjectKind: 'account', subjectId: partyId }),
        })
        if (result.ok) createdId = result.data?.id ?? null
        return result
      },
      { fallbackMessage: tc('feedback.saveFailed') },
    )
    if (ok && createdId) router.push(activityHref(createdId))
  }

  return (
    <DrawerSublist
      title={tcrm('activities.title')}
      description={tcrm('activities.description')}
      icon={<CalendarDays size={16} />}
      action={canManage ? <SublistAddButton label={t('addActivity')} disabled={busy} onClick={addActivity} /> : undefined}
      search={{ value: q, onChange: (value) => { setQ(value); setPage(1) }, placeholder: tcrm('activities.search') }}
      filters={(
        <>
          <Select value={kind} onChange={(event) => { setKind(event.target.value); setPage(1) }} className="w-auto min-w-40" aria-label={tcrm('fields.activityType')}>
            <option value="">{t('allTypes')}</option>
            {(visibleData?.kinds ?? []).map((value) => <option key={value} value={value}>{tcrm(`activityKinds.${value}`)}</option>)}
          </Select>
          <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }} className="w-auto min-w-40" aria-label={tcrm('fields.status')}>
            <option value="">{t('allStatuses')}</option>
            {(visibleData?.statuses ?? []).map((value) => <option key={value} value={value}>{tcrm(`activityStatuses.${value}`)}</option>)}
          </Select>
        </>
      )}
      footer={visibleData?.rows.length ? (
        <SublistPager count={t('activityCount', { count: visibleData.total })} page={page} pages={pages} onPage={setPage} disabled={loading} />
      ) : null}
    >
      {loading && !visibleData ? (
        <SublistLoading />
      ) : !visibleData?.rows.length ? (
        <SublistEmpty icon={<CalendarDays size={22} />} text={tcrm('activities.emptyDescription')} />
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>{tcrm('fields.subject')}</TableHead><TableHead>{tcrm('fields.activityType')}</TableHead>
            <TableHead>{tcrm('fields.status')}</TableHead><TableHead>{tcrm('fields.date')}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {visibleData.rows.map((row) => (
              <TableRow key={row.id} className={loading ? 'opacity-60' : undefined}>
                <TableCell><Link href={activityHref(row.id)} className="font-semibold text-teal-700 hover:underline dark:text-teal-300">{row.subject}</Link></TableCell>
                <TableCell>{tcrm(`activityKinds.${row.kind}`)}</TableCell>
                <TableCell><Badge variant={row.status === 'completed' ? 'success' : 'outline'}>{tcrm(`activityStatuses.${row.status}`)}</Badge></TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{dateTime(new Date(row.activity_date))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </DrawerSublist>
  )
}
