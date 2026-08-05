'use client'

import { Fragment, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Calculator, CheckCircle2, ChevronDown, ChevronRight, Send } from 'lucide-react'
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@openbooks/ui'
import { useMoney } from '../../../../../components/money-provider'
import { RunStatusBadge, runDisplayStatus } from '../../PayrollWorkspace'

export interface RunHeader {
  document_id: string
  document_number: string
  document_status: string
  currency: string
  schedule_name: string | null
  period_start: string
  period_end: string
  pay_date: string
  tax_year: number
  run_status: 'draft' | 'calculated' | 'committed'
  gross_total: string
  net_total: string
  employer_cost_total: string
  employee_count: number
}

export interface StubRow {
  id: string
  employee_party_id: string
  employee_name: string
  province: string
  gross: string
  net_pay: string
  employer_cost: string
  vacation_accrued: string
  pensionable_earnings: string
  insurable_earnings: string
  factors: Record<string, string>
  lines: {
    stub_id: string
    kind: 'earning' | 'deduction' | 'employer_contribution'
    description: string
    hours: string | null
    rate: string | null
    amount: string
    sequence: number
    component_code: string | null
    project_name: string | null
    department_name: string | null
  }[]
}

/** Statutory splits surfaced as stub-roster columns, read off the factors trace. */
function statutory(stub: StubRow) {
  const f = stub.factors ?? {}
  // C/C2 = employee CPP, EI = employee EI, T/TB = periodic + bonus tax.
  return { cpp: add(f.C, f.C2), ei: f.EI ?? '0', tax: add(f.T, f.TB) }
}

function add(a?: string, b?: string): string {
  const n = (Number(a ?? 0) || 0) + (Number(b ?? 0) || 0)
  return n.toFixed(2)
}

export function RunDetail(props: { run: RunHeader; stubs: StubRow[]; canRun: boolean }) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const { money } = useMoney()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const run = props.run
  const currency = run.currency
  const fmt = (value: string | null | undefined) => money(value ?? '0', { currency })

  const docDraft = run.document_status === 'draft'
  const canCalculate = props.canRun && docDraft && run.run_status !== 'committed'
  const canCommit = props.canRun && docDraft && run.run_status === 'calculated'
  const canPost =
    props.canRun && run.run_status === 'committed' && (run.document_status === 'draft' || run.document_status === 'approved')

  async function act(action: 'calculate' | 'commit') {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      if (action === 'calculate' && Array.isArray(j.errors) && j.errors.length > 0) {
        for (const item of j.errors as { employee: string; message: string }[]) {
          toast.warning(`${item.employee}: ${item.message}`)
        }
      }
      toast.success(t(`run.${action}Done`))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function post() {
    setBusy(true)
    try {
      const res = await fetch('/api/documents/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'post', documentId: run.document_id }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      toast.success(t('run.postDone'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function toggle(stubId: string) {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(stubId)) next.delete(stubId)
      else next.add(stubId)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600 dark:text-slate-300">
          <RunStatusBadge status={runDisplayStatus(run)} />
          <span>
            {t('columns.payDate')}: <span className="font-medium tabular-nums">{run.pay_date}</span>
          </span>
          <span>
            {t('columns.gross')}: <span className="font-medium tabular-nums">{fmt(run.gross_total)}</span>
          </span>
          <span>
            {t('columns.net')}: <span className="font-medium tabular-nums">{fmt(run.net_total)}</span>
          </span>
          <span>
            {t('run.employerCost')}: <span className="font-medium tabular-nums">{fmt(run.employer_cost_total)}</span>
          </span>
          <span>
            {t('columns.employees')}: <span className="font-medium tabular-nums">{run.employee_count}</span>
          </span>
        </div>
        {props.canRun && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => act('calculate')} disabled={busy || !canCalculate}>
              <Calculator size={14} aria-hidden /> {t('run.calculate')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => act('commit')} disabled={busy || !canCommit}>
              <CheckCircle2 size={14} aria-hidden /> {t('run.commit')}
            </Button>
            <Button size="sm" onClick={post} disabled={busy || !canPost}>
              <Send size={14} aria-hidden /> {t('run.post')}
            </Button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>{t('run.stub.employee')}</TableHead>
              <TableHead>{t('run.stub.province')}</TableHead>
              <TableHead className="text-right">{t('columns.gross')}</TableHead>
              <TableHead className="text-right">{t('run.stub.cpp')}</TableHead>
              <TableHead className="text-right">{t('run.stub.ei')}</TableHead>
              <TableHead className="text-right">{t('run.stub.tax')}</TableHead>
              <TableHead className="text-right">{t('columns.net')}</TableHead>
              <TableHead className="text-right">{t('run.employerCost')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.stubs.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-slate-500 dark:text-slate-400">
                  {t('run.empty')}
                </TableCell>
              </TableRow>
            )}
            {props.stubs.map((stub) => {
              const expanded = open.has(stub.id)
              const s = statutory(stub)
              const factorEntries = Object.entries(stub.factors ?? {}).sort(([a], [b]) => a.localeCompare(b))
              return (
                <Fragment key={stub.id}>
                  <TableRow className="cursor-pointer" onClick={() => toggle(stub.id)}>
                    <TableCell className="text-slate-400">
                      {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                    </TableCell>
                    <TableCell className="font-medium">{stub.employee_name}</TableCell>
                    <TableCell>{stub.province}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(stub.gross)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.cpp)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.ei)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.tax)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(stub.net_pay)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(stub.employer_cost)}</TableCell>
                  </TableRow>
                  {expanded && (
                    <TableRow>
                      <TableCell colSpan={9} className="bg-slate-50 dark:bg-slate-950/40">
                        <div className="grid gap-4 py-2 lg:grid-cols-2">
                          <div>
                            <h4 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                              {t('run.stub.lines')}
                            </h4>
                            <table className="w-full text-sm">
                              <tbody>
                                {stub.lines.map((line, index) => (
                                  <tr key={index} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                                    <td className="py-1 pr-2 text-slate-500 dark:text-slate-400">
                                      {t(`run.lineKind.${line.kind}`)}
                                    </td>
                                    <td className="py-1 pr-2">
                                      {line.description}
                                      {(line.project_name || line.department_name) && (
                                        <span className="ml-1 text-xs text-slate-400">
                                          {[line.project_name, line.department_name].filter(Boolean).join(' · ')}
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-1 pr-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                                      {line.hours ? `${line.hours} × ${fmt(line.rate)}` : ''}
                                    </td>
                                    <td
                                      className={cn(
                                        'py-1 text-right tabular-nums',
                                        line.kind === 'deduction' && 'text-red-600 dark:text-red-400',
                                      )}
                                    >
                                      {line.kind === 'deduction' ? `−${fmt(line.amount)}` : fmt(line.amount)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div>
                            <h4 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                              {t('run.stub.trace')}
                            </h4>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
                              {factorEntries.map(([key, value]) => (
                                <Fragment key={key}>
                                  <dt className="font-mono text-xs text-slate-500 dark:text-slate-400">{key}</dt>
                                  <dd className="text-right tabular-nums">{value}</dd>
                                </Fragment>
                              ))}
                            </dl>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
