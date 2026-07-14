'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select, UrlDrawer } from '@openbooks/ui'
import { dateTime } from '../../../../lib/format'

const TRIGGERS = ['before_submit', 'before_post', 'after_post', 'before_void', 'scheduled']
const KINDS = ['', 'vendor_bill', 'customer_invoice', 'vendor_payment', 'customer_payment', 'expense_report', 'journal']

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
  const router = useRouter()
  return (
    <Button onClick={() => router.push('/admin/scripts?script=new')}>
      <Plus size={15} /> New script
    </Button>
  )
}

export function ScriptDrawer({ script, runs }: { script: Record<string, any> | null; runs: Record<string, any>[] }) {
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
      toast.error(data.error ?? 'Could not save the script')
      setBusy(false)
      return
    }
    toast.success(creating ? 'Script created' : 'Script saved')
    router.push('/admin/scripts')
    router.refresh()
  }

  return (
    <UrlDrawer
      open
      closeHref="/admin/scripts"
      size="xl"
      title={creating ? 'New script' : script!.name}
      description="Sandboxed JavaScript (QuickJS) — no filesystem, network, or database access."
      footer={
        <div className="flex w-full items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            Active
          </label>
          <Button disabled={busy || !name || !source.includes('function main')} onClick={save}>
            {busy ? 'Saving…' : creating ? 'Create script' : 'Save script'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-1">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5 lg:col-span-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="AP policy: big bills need a memo" />
          </div>
          <div className="space-y-1.5">
            <Label>Trigger</Label>
            <Select value={triggerPoint} onChange={(e) => setTriggerPoint(e.target.value)}>
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {t.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Document kind</Label>
            <Select value={documentKind} onChange={(e) => setDocumentKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k === '' ? 'All kinds' : k.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>
            Source <span className="font-normal text-slate-400">— must define function main(ctx)</span>
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
            <Label>Timeout (ms)</Label>
            <Input inputMode="numeric" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Run order</Label>
            <Input inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </div>
        </div>

        {runs.length > 0 ? (
          <div className="space-y-2">
            <Label>Recent runs</Label>
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {runs.map((r, i) => (
                <div key={i} className="flex items-start gap-3 px-3 py-2 text-sm">
                  <Badge variant={r.status === 'ok' ? 'success' : r.status === 'aborted' ? 'warning' : 'destructive'}>
                    {r.status}
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
