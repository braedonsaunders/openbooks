'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  UrlDrawer,
} from '@openbooks/ui'
import { DrawerTabStrip } from '../../../components/drawer-tab-strip'
import { confirmDialog } from '../../../lib/confirm'
import { useAppAction } from '../../../lib/use-app-action'
import type { EncumbranceDrawerData } from './view'

type EncumbranceTab = 'details' | 'links' | 'appropriation'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  open: 'success',
  closed: 'secondary',
  void: 'outline',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</Label>
      {children}
    </div>
  )
}

/**
 * Encumbrance record drawer — the stored commitment with its derived open
 * balance, linked actuals, and the appropriation comparison.
 *
 * State changes dispatch to their named command routes: create, close, and
 * void to /api/encumbrances/commands under encumbrances.manage, actual
 * linkage to /api/encumbrances/liquidations, which additionally proves
 * gl.post before the body parses. A refusal pins beside the record with the
 * server's own remedy; `res.ok` is checked before any body is parsed.
 */
export function EncumbranceDrawer({ drawer }: { drawer: EncumbranceDrawerData }) {
  const t = useTranslations('nonprofit')
  const router = useRouter()
  const action = useAppAction()
  const [tab, setTab] = useState<EncumbranceTab>('details')

  async function run(url: string, payload: Record<string, unknown>, success: string) {
    return action.execute(
      () => fetchAction(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
      {
        fallbackMessage: t('encumbrances.actionFailed'),
        onOk: async () => {
          toast.success(success)
          router.refresh()
        },
      },
    )
  }

  if (drawer.mode === 'create') {
    return (
      <UrlDrawer open closeHref={drawer.closeHref} size="2xl" title={t('encumbrances.newTitle')} description={t('encumbrances.newDescription')}>
        <ActionAlert error={action.refusal} fallbackMessage={t('encumbrances.actionFailed')} />
        <CreateEncumbranceForm
          drawer={drawer}
          busy={action.busy}
          onSubmit={(payload) => run('/api/encumbrances/commands', { action: 'create', ...payload }, t('encumbrances.created'))}
        />
      </UrlDrawer>
    )
  }

  const { detail } = drawer
  const canManage = drawer.canManage

  return (
    <UrlDrawer
      open
      closeHref={drawer.closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">{detail.encumbranceNumber}</span>
          <span>{`${detail.accountNumber ?? ''} ${detail.accountName}`.trim()}</span>
          <Badge variant={STATUS_VARIANT[detail.status] ?? 'outline'}>{detail.status}</Badge>
        </span>
      }
      description={t('encumbrances.details')}
      subtabs={
        <DrawerTabStrip
          ariaLabel={t('encumbrances.tabsAria')}
          activeKey={tab}
          onSelect={setTab}
          tabs={(
            [
              { key: 'details', label: t('encumbrances.tabs.details') },
              { key: 'links', label: t('encumbrances.tabs.links') },
              { key: 'appropriation', label: t('encumbrances.tabs.appropriation') },
            ] as const
          ).map((item) => ({ key: item.key, label: item.label }))}
        />
      }
    >
      <ActionAlert error={action.refusal} fallbackMessage={t('encumbrances.actionFailed')} />
      {tab === 'details' ? (
        <EncumbranceDetailsTab drawer={drawer} onCommand={(payload, success) => run('/api/encumbrances/commands', payload, success)} busy={action.busy} canManage={canManage} />
      ) : null}
      {tab === 'links' ? (
        <EncumbranceLinksTab drawer={drawer} onLiquidate={(payload, success) => run('/api/encumbrances/liquidations', payload, success)} busy={action.busy} canManage={canManage} />
      ) : null}
      {tab === 'appropriation' ? <EncumbranceAppropriationTab drawer={drawer} /> : null}
    </UrlDrawer>
  )
}

function CreateEncumbranceForm({
  drawer,
  busy,
  onSubmit,
}: {
  drawer: Extract<EncumbranceDrawerData, { mode: 'create' }>
  busy: boolean
  onSubmit: (payload: Record<string, unknown>) => Promise<boolean>
}) {
  const t = useTranslations('nonprofit')
  const [form, setForm] = useState({
    sourceKind: 'manual',
    amount: '',
    accountId: drawer.accountOptions[0]?.id ?? '',
    subsidiaryId: drawer.subsidiaryOptions[0]?.id ?? '',
    fundId: drawer.fundOptions[0]?.id ?? '',
  })
  const set = (key: keyof typeof form) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }))
  if (!drawer.canManage) return <p className="text-sm text-slate-500">{t('encumbrances.manageRequired')}</p>
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('encumbrances.sourceKind')}>
        <Select value={form.sourceKind} onChange={(e) => set('sourceKind')(e.target.value)}>
          {['manual', 'purchase_order'].map((kind) => (
            <option key={kind} value={kind}>{kind}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('encumbrances.amount')}><Input value={form.amount} onChange={(e) => set('amount')(e.target.value)} inputMode="decimal" /></Field>
      <Field label={t('encumbrances.account')}>
        <Select value={form.accountId} onChange={(e) => set('accountId')(e.target.value)}>
          {drawer.accountOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>{`${opt.number ?? ''} ${opt.name}`.trim()}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('encumbrances.subsidiary')}>
        <Select value={form.subsidiaryId} onChange={(e) => set('subsidiaryId')(e.target.value)}>
          {drawer.subsidiaryOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.name}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('encumbrances.fund')}>
        <Select value={form.fundId} onChange={(e) => set('fundId')(e.target.value)}>
          {drawer.fundOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>{`${opt.code} ${opt.name}`.trim()}</option>
          ))}
        </Select>
      </Field>
      <div className="sm:col-span-2">
        <Button disabled={busy} onClick={() => onSubmit(form)}>{t('encumbrances.createAction')}</Button>
      </div>
    </div>
  )
}

function EncumbranceDetailsTab({
  drawer,
  onCommand,
  busy,
  canManage,
}: {
  drawer: Extract<EncumbranceDrawerData, { mode: 'record' }>
  onCommand: (payload: Record<string, unknown>, success: string) => Promise<boolean>
  busy: boolean
  canManage: boolean
}) {
  const t = useTranslations('nonprofit')
  const detail = drawer.detail
  const [reason, setReason] = useState('')

  async function confirmThen(label: string, task: () => Promise<boolean>) {
    if (!(await confirmDialog(label))) return
    await task()
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 p-1 sm:grid-cols-2">
        <Field label={t('encumbrances.amount')}><p className="font-mono text-sm">{detail.amount}</p></Field>
        <Field label={t('encumbrances.openBalance')}><p className="font-mono text-sm">{detail.openBalance}</p></Field>
        <Field label={t('encumbrances.appliedActuals')}><p className="font-mono text-sm">{detail.appliedActuals}</p></Field>
        <Field label={t('encumbrances.subsidiary')}><p className="text-sm">{detail.subsidiaryName}</p></Field>
        <Field label={t('encumbrances.sourceKind')}><p className="text-sm">{detail.sourceKind}</p></Field>
        <Field label={t('encumbrances.status')}><p className="text-sm">{detail.status}</p></Field>
      </div>
      {canManage && detail.status === 'open' ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          <div className="min-w-52 flex-1">
            <Field label={t('encumbrances.reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          </div>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => confirmThen(t('encumbrances.closeAction'), () => onCommand({ action: 'close', encumbranceId: detail.id, reason }, t('encumbrances.closed')))}
          >
            {t('encumbrances.closeAction')}
          </Button>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => confirmThen(t('encumbrances.voidAction'), () => onCommand({ action: 'void', encumbranceId: detail.id, reason }, t('encumbrances.voided')))}
          >
            {t('encumbrances.voidAction')}
          </Button>
        </div>
      ) : null}
      {!canManage ? <p className="text-sm text-slate-500">{t('encumbrances.manageRequired')}</p> : null}
    </div>
  )
}

function EncumbranceLinksTab({
  drawer,
  onLiquidate,
  busy,
  canManage,
}: {
  drawer: Extract<EncumbranceDrawerData, { mode: 'record' }>
  onLiquidate: (payload: Record<string, unknown>, success: string) => Promise<boolean>
  busy: boolean
  canManage: boolean
}) {
  const t = useTranslations('nonprofit')
  const detail = drawer.detail
  const [documentLineId, setDocumentLineId] = useState(drawer.candidates[0]?.documentLineId ?? '')
  return (
    <div className="space-y-4">
      {detail.links.length === 0 ? (
        <p className="text-sm text-slate-500">{t('encumbrances.linksEmpty')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('encumbrances.document')}</TableHead>
              <TableHead>{t('encumbrances.documentStatus')}</TableHead>
              <TableHead>{t('encumbrances.amount')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.links.map((link) => (
              <TableRow key={link.documentLineId}>
                <TableCell className="font-mono text-[13px]">{link.documentNumber}</TableCell>
                <TableCell>{link.documentStatus}</TableCell>
                <TableCell className="text-right font-mono text-[13px]">{link.amount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {canManage && detail.status === 'open' ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          <div className="min-w-52 flex-1">
            <Field label={t('encumbrances.candidateLine')}>
              <Select value={documentLineId} onChange={(e) => setDocumentLineId(e.target.value)}>
                {drawer.candidates.map((candidate) => (
                  <option key={candidate.documentLineId} value={candidate.documentLineId}>
                    {`${candidate.documentNumber} · ${candidate.amount}`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button
            disabled={busy || !documentLineId}
            onClick={() => onLiquidate({ action: 'link', encumbranceId: detail.id, documentLineId }, t('encumbrances.linked'))}
          >
            {t('encumbrances.linkAction')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function EncumbranceAppropriationTab({ drawer }: { drawer: Extract<EncumbranceDrawerData, { mode: 'record' }> }) {
  const t = useTranslations('nonprofit')
  const figures = drawer.detail.figures
  if (!figures) return <p className="text-sm text-slate-500">{t('encumbrances.noAppropriation')}</p>
  const rows: [string, string][] = [
    [t('encumbrances.scenario'), `${figures.scenarioName}`],
    [t('encumbrances.appropriation'), figures.appropriation],
    [t('encumbrances.actuals'), figures.actuals],
    [t('encumbrances.openEncumbrances'), figures.openEncumbrances],
    [t('encumbrances.available'), figures.available],
  ]
  return (
    <Table>
      <TableBody>
        {rows.map(([label, value]) => (
          <TableRow key={label}>
            <TableCell>{label}</TableCell>
            <TableCell className="text-right font-mono text-[13px]">{value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
