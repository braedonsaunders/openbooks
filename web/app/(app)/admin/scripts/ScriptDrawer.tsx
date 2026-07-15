'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select, UrlDrawer } from '@openbooks/ui'
import { dateTime } from '../../../../lib/format'

// Enum values with their message keys under admin.scripts, translated at render.
const TRIGGERS: { value: string; labelKey: string }[] = [
  { value: 'before_submit', labelKey: 'triggers.beforeSubmit' },
  { value: 'before_post', labelKey: 'triggers.beforePost' },
  { value: 'after_post', labelKey: 'triggers.afterPost' },
  { value: 'before_void', labelKey: 'triggers.beforeVoid' },
  { value: 'scheduled', labelKey: 'triggers.scheduled' },
]
const KINDS: { value: string; labelKey: string }[] = [
  { value: '', labelKey: 'drawer.allKindsOption' },
  { value: 'vendor_bill', labelKey: 'kinds.vendorBill' },
  { value: 'customer_invoice', labelKey: 'kinds.customerInvoice' },
  { value: 'vendor_payment', labelKey: 'kinds.vendorPayment' },
  { value: 'customer_payment', labelKey: 'kinds.customerPayment' },
  { value: 'expense_report', labelKey: 'kinds.expenseReport' },
  { value: 'journal', labelKey: 'kinds.journal' },
]

const RUN_STATUSES = new Set(['ok', 'aborted', 'error'])

const TEMPLATE = `// ctx = { trigger, document, lines, org } — deep-frozen.
// ob.log(...) records to the run log; ob.abort('reason') vetoes.
// Return { set: { field: value } } to change whitelisted header fields.
function main(ctx) {
  const total = Number(ctx.document.total)
  ob.log('checking', ctx.document.documentNumber, 'total', total)
  if (total > 10000 && !ctx.document.memo) {
    ob.abort('documents over $10,000 need a memo')
  }
}
`

export function NewScriptButton() {
  const t = useTranslations('admin.scripts')
  const router = useRouter()
  return (
    <Button onClick={() => router.push('/admin/scripts?script=new')}>
      <Plus size={15} /> {t('drawer.newScript')}
    </Button>
  )
}

export function ScriptDrawer({ script, runs }: { script: Record<string, any> | null; runs: Record<string, any>[] }) {
  const t = useTranslations('admin.scripts')
  const tCommon = useTranslations('common')
  const creating = !script
  const router = useRouter()
  const [name, setName] = useState<string>(script?.name ?? '')
  const [triggerPoint, setTriggerPoint] = useState<string>(script?.trigger_point ?? 'before_post')
  const [documentKind, setDocumentKind] = useState<string>(script?.document_kind ?? '')
  const [source, setSource] = useState<string>(script?.source ?? TEMPLATE)
  const [timeoutMs, setTimeoutMs] = useState<string>(String(script?.timeout_ms ?? 2000))
  const [sortOrder, setSortOrder] = useState<string>(String(script?.sort_order ?? 100))
  const [isActive, setIsActive] = useState<boolean>(script?.is_active ?? true)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    const res = await fetch('/api/admin/scripts', {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: script?.id,
        name,
        triggerPoint,
        documentKind: documentKind || null,
        source,
        timeoutMs: Number(timeoutMs) || 2000,
        sortOrder: Number(sortOrder) || 100,
        isActive,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('drawer.saveFailed'))
      setBusy(false)
      return
    }
    toast.success(creating ? t('drawer.created') : t('drawer.saved'))
    router.push('/admin/scripts')
    router.refresh()
  }

  return (
    <UrlDrawer
      open
      closeHref="/admin/scripts"
      size="xl"
      title={creating ? t('drawer.newTitle') : script!.name}
      description={t('drawer.description')}
      headerActions={
        <>
          <Button disabled={busy || !name || !source.includes('function main')} onClick={save}>
            {busy
              ? tCommon('actions.saving')
              : creating
                ? t('drawer.createScript')
                : t('drawer.saveScript')}
          </Button>
        </>
      }
      footer={
        <div className="flex w-full items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            {tCommon('labels.active')}
          </label>
        </div>
      }
    >
      <div className="space-y-4 p-1">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5 lg:col-span-2">
            <Label>{tCommon('labels.name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('drawer.namePlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('drawer.trigger')}</Label>
            <Select value={triggerPoint} onChange={(e) => setTriggerPoint(e.target.value)}>
              {TRIGGERS.map((tr) => (
                <option key={tr.value} value={tr.value}>
                  {t(tr.labelKey)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('drawer.documentKind')}</Label>
            <Select value={documentKind} onChange={(e) => setDocumentKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {t(k.labelKey)}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>
            {t('drawer.source')}{' '}
            <span className="font-normal text-slate-400">{t('drawer.sourceHint')}</span>
          </Label>
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            rows={16}
            className="w-full rounded-lg border border-slate-200 bg-slate-950 p-4 font-mono text-[13px] leading-relaxed text-slate-100 outline-none focus:ring-2 focus:ring-teal-500 dark:border-slate-700"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('drawer.timeoutMs')}</Label>
            <Input inputMode="numeric" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('drawer.runOrder')}</Label>
            <Input inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </div>
        </div>

        {runs.length > 0 ? (
          <div className="space-y-2">
            <Label>{t('drawer.recentRuns')}</Label>
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {runs.map((r, i) => (
                <div key={i} className="flex items-start gap-3 px-3 py-2 text-sm">
                  <Badge variant={r.status === 'ok' ? 'success' : r.status === 'aborted' ? 'warning' : 'destructive'}>
                    {RUN_STATUSES.has(r.status) ? t(`drawer.runStatus.${r.status}`) : r.status}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {dateTime(r.at)} · {r.target_kind} · {r.duration_ms}ms
                    </p>
                    {r.error_message ? <p className="text-xs text-red-600 dark:text-red-400">{r.error_message}</p> : null}
                    {Array.isArray(r.logs) && r.logs.length > 0 ? (
                      <pre className="mt-1 overflow-x-auto font-mono text-[11px] text-slate-600 dark:text-slate-300">
                        {r.logs.join('\n')}
                      </pre>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </UrlDrawer>
  )
}
