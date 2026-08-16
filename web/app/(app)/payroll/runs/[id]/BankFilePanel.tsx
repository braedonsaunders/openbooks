'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Banknote,
  Copy,
  FileDown,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { promptDialog } from '../../../../../lib/prompt'
import { dateTime } from '../../../../../lib/format'

/**
 * Direct deposit — the operator's view of a control, not a download button.
 *
 * The dangerous states in payroll direct deposit are not errors, they are
 * plausible-looking successes: a second file released to the bank alongside the
 * first pays everybody twice, a cheque employee credited here is paid twice,
 * and a file whose total disagrees with the payday reconciles to nothing. So
 * this panel leads with the things an operator has to see BEFORE pressing
 * anything — who is on the file, who is deliberately not, what the control
 * total is, and whether these exact bytes have already left the building —
 * and treats generating a replacement as an explained act rather than a retry.
 */

interface Exclusion {
  employeePartyId: string
  employeeName: string
  amount: string
  reason: 'profile' | 'party' | 'default' | 'eftFallback'
}

interface Artifact {
  id: string
  format: 'cpa005' | 'nacha'
  sequenceNumber: number
  fileNumber: string
  fileCreationNumber: number | null
  fileIdModifier: string | null
  filename: string
  contentHash: string
  sizeBytes: number
  entryCount: number
  controlTotal: string
  currency: string
  excludedCheque: Exclusion[]
  excludedTotal: string
  status: 'generated' | 'released' | 'superseded'
  generatedAt: string
  firstReleasedAt: string | null
  lastReleasedAt: string | null
  releaseCount: number
  supersedeReason: string | null
}

interface Profile {
  id: string
  name: string
  format: 'cpa005' | 'nacha'
  currency: string | null
  configured: boolean
}

interface AuditEntry {
  id: string
  event: string
  artifactId: string
  actorName: string | null
  at: string
  changes: Record<string, unknown>
}

interface PanelState {
  entitlement: {
    entitled: boolean
    refusal: { code: string; reason: string } | null
    runStatus: string
    currency: string
    payDate: string
  }
  population: {
    entries: { employeePartyId: string; employeeName: string; amount: string }[]
    total: string
    excludedCheque: Exclusion[]
    excludedTotal: string
  } | null
  profiles: Profile[]
  artifacts: Artifact[]
  audit: AuditEntry[]
  formats: Record<string, { enabled: boolean; currency: string; disabledReason: string | null }>
}

export function BankFilePanel({
  documentId,
  canRun,
  fmt,
}: {
  documentId: string
  canRun: boolean
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')
  // The message catalogue is owned elsewhere; until these keys land the panel
  // renders its English source text rather than raw key paths.
  const tx = useCallback(
    (key: string, fallback: string) => (t.has(key as never) ? (t(key as never) as string) : fallback),
    [t],
  )

  const [state, setState] = useState<PanelState | null>(null)
  const [profileId, setProfileId] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/payroll/runs/${documentId}/bank-file`)
    if (!res.ok) return
    const data = (await res.json()) as PanelState
    setState(data)
    setProfileId((current) => current || (data.profiles.find((p) => p.configured)?.id ?? ''))
  }, [documentId])

  useEffect(() => {
    void load()
  }, [load])

  if (!state) return null

  const { entitlement, population, profiles, artifacts, formats } = state
  const live = artifacts.filter((a) => a.status !== 'superseded')
  const usable = profiles.filter((p) => formats[p.format]?.enabled)
  const disabledFormats = Object.entries(formats).filter(([, spec]) => !spec.enabled)

  async function generate() {
    if (!profileId) return
    let supersedeReason: string | null = null
    if (live.length > 0) {
      supersedeReason = await promptDialog({
        title: tx(
          'wizard.bankFile.regenerateTitle',
          'Replace the existing direct-deposit file?',
        ),
        label: tx(
          'wizard.bankFile.regenerateLabel',
          'Why is a replacement needed? The existing file stays on record and is marked superseded. If it has already gone to the bank, do not send both.',
        ),
        placeholder: tx('wizard.bankFile.regeneratePlaceholder', 'e.g. bank rejected the first transmission'),
        confirmLabel: tx('wizard.bankFile.regenerateConfirm', 'Generate replacement'),
      })
      if (!supersedeReason) return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${documentId}/bank-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentBankProfileId: profileId, supersedeReason }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'failed')
      toast.success(
        tx('wizard.bankFile.generated', 'Direct-deposit file generated') +
          ` — ${body.artifact.fileNumber}`,
      )
      await load()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function download(artifact: Artifact) {
    setBusy(true)
    try {
      // POST, not a link: every release is counted and audited, and a browser
      // prefetch must not be able to fire one.
      const res = await fetch(`/api/payroll/runs/${documentId}/bank-file/${artifact.id}`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'failed')
      }
      const url = URL.createObjectURL(await res.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = artifact.filename
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      await load()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const exclusionReason = (reason: Exclusion['reason']) =>
    tx(
      `wizard.bankFile.exclusion.${reason}`,
      reason === 'profile'
        ? 'Paid by cheque (payroll override)'
        : reason === 'party'
          ? 'Paid by cheque (employee preference)'
          : reason === 'eftFallback'
            ? 'Set to EFT but has no approved bank details — paid by cheque'
            : 'No bank details on file — paid by cheque',
    )

  return (
    <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="flex items-start gap-3">
          <Banknote className="mt-0.5 h-5 w-5 text-teal-600 dark:text-teal-400" aria-hidden />
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {tx('wizard.bankFile.title', 'Direct deposit')}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {tx(
                'wizard.bankFile.hint',
                'The file instructs the bank to credit each EFT employee. Once generated it is frozen, hashed and numbered; every download is recorded.',
              )}
            </p>
          </div>
        </div>
        {canRun && entitlement.entitled && usable.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              aria-label={tx('wizard.bankFile.profile', 'Originating bank profile')}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              {usable.map((profile) => (
                <option key={profile.id} value={profile.id} disabled={!profile.configured}>
                  {profile.name}
                  {profile.configured ? '' : ` — ${tx('wizard.bankFile.notConfigured', 'not configured')}`}
                </option>
              ))}
            </select>
            <Button size="sm" disabled={busy || !profileId} onClick={() => void generate()}>
              {busy ? (
                <Loader2 size={14} className="animate-spin" aria-hidden />
              ) : live.length > 0 ? (
                <RefreshCw size={14} aria-hidden />
              ) : (
                <FileDown size={14} aria-hidden />
              )}
              {live.length > 0
                ? tx('wizard.bankFile.regenerate', 'Generate replacement')
                : tx('wizard.bankFile.generate', 'Generate file')}
            </Button>
          </div>
        )}
      </header>

      <div className="space-y-4 p-4">
        {/* The one reason this run cannot have a file, named. */}
        {!entitlement.entitled && entitlement.refusal && (
          <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {entitlement.refusal.reason}
          </p>
        )}

        {/* Two live files for one payday is the dangerous state. Say so. */}
        {live.length > 1 && (
          <p className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {tx(
              'wizard.bankFile.multipleLive',
              'This pay run has more than one file that has not been superseded. Send exactly ONE to the bank — releasing both pays every employee twice.',
            )}
          </p>
        )}

        {usable.length === 0 && entitlement.entitled && (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
            {tx(
              'wizard.bankFile.noProfile',
              'No originating bank profile is set up for payroll. Add one in Setup → Payment operations: the originator id, routing and company identification are assigned by your bank and are never defaulted.',
            )}
          </p>
        )}

        {disabledFormats.map(([key, spec]) => (
          <p
            key={key}
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-400"
          >
            {spec.disabledReason}
          </p>
        ))}

        {/* Who is on the file, and who is deliberately not. */}
        {population && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Fact label={tx('wizard.bankFile.onFile', 'On the file (EFT)')}>
              {tx('wizard.bankFile.employees', '{n} employees').replace(
                '{n}',
                String(population.entries.length),
              )}
            </Fact>
            <Fact label={tx('wizard.bankFile.controlTotal', 'Control total')}>
              {fmt(population.total)}
            </Fact>
            <Fact label={tx('wizard.bankFile.onPaper', 'Paid by cheque instead')}>
              {tx('wizard.bankFile.employees', '{n} employees').replace(
                '{n}',
                String(population.excludedCheque.length),
              )}
              {' · '}
              {fmt(population.excludedTotal)}
            </Fact>
          </div>
        )}

        {population && population.excludedCheque.length > 0 && (
          <details className="rounded-lg border border-slate-200 dark:border-slate-800">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              {tx('wizard.bankFile.excludedTitle', 'Not on the file — reconcile these against the payday')}
            </summary>
            <div className="border-t border-slate-100 px-3 py-2 dark:border-slate-800">
              <ul className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
                {population.excludedCheque.map((row) => (
                  <li key={row.employeePartyId} className="flex flex-wrap justify-between gap-2">
                    <span>{row.employeeName}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {exclusionReason(row.reason)}
                    </span>
                    <span className="tabular-nums">{fmt(row.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}

        {/* The artifacts. Nothing is ever removed from this list. */}
        {artifacts.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tx('wizard.bankFile.file', 'File')}</TableHead>
                  <TableHead className="text-right">{tx('wizard.bankFile.amount', 'Control total')}</TableHead>
                  <TableHead>{tx('wizard.bankFile.status', 'Status')}</TableHead>
                  <TableHead>{tx('wizard.bankFile.released', 'Released')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {artifacts.map((artifact) => (
                  <TableRow
                    key={artifact.id}
                    className={cn(artifact.status === 'superseded' && 'opacity-60')}
                  >
                    <TableCell>
                      <div className="font-medium text-slate-800 dark:text-slate-100">
                        {artifact.fileNumber}
                      </div>
                      <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                        {artifact.filename}
                      </div>
                      <div className="flex items-center gap-1 font-mono text-[11px] text-slate-400 dark:text-slate-500">
                        <ShieldCheck size={11} aria-hidden />
                        sha256 {artifact.contentHash.slice(0, 16)}…
                        <button
                          type="button"
                          className="rounded p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800"
                          aria-label={tx('wizard.bankFile.copyHash', 'Copy sha256')}
                          onClick={() => {
                            void navigator.clipboard.writeText(artifact.contentHash)
                            toast.success(tx('wizard.bankFile.hashCopied', 'sha256 copied'))
                          }}
                        >
                          <Copy size={11} aria-hidden />
                        </button>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="tabular-nums">{fmt(artifact.controlTotal)}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {tx('wizard.bankFile.credits', '{n} credits').replace(
                          '{n}',
                          String(artifact.entryCount),
                        )}
                        {artifact.fileIdModifier ? ` · id ${artifact.fileIdModifier}` : ''}
                        {artifact.fileCreationNumber ? ` · no. ${artifact.fileCreationNumber}` : ''}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          artifact.status === 'superseded'
                            ? 'secondary'
                            : artifact.status === 'released'
                              ? 'success'
                              : 'default'
                        }
                      >
                        {tx(`wizard.bankFile.state.${artifact.status}`, artifact.status)}
                      </Badge>
                      {artifact.supersedeReason && (
                        <div className="mt-1 max-w-[16rem] text-[11px] text-slate-500 dark:text-slate-400">
                          {artifact.supersedeReason}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500 dark:text-slate-400">
                      {artifact.releaseCount === 0
                        ? tx('wizard.bankFile.neverReleased', 'Never downloaded')
                        : `${artifact.releaseCount}× · ${dateTime(artifact.lastReleasedAt)}`}
                    </TableCell>
                    <TableCell className="text-right">
                      {canRun && (
                        <Button
                          size="sm"
                          variant={artifact.status === 'superseded' ? 'ghost' : 'outline'}
                          disabled={busy}
                          onClick={() => void download(artifact)}
                        >
                          <FileDown size={14} aria-hidden />
                          {tx('wizard.bankFile.download', 'Download')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {state.audit.length > 0 && (
          <details className="rounded-lg border border-slate-200 dark:border-slate-800">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              {tx('wizard.bankFile.auditTitle', 'Activity — who generated and who downloaded')}
            </summary>
            <ul className="space-y-1 border-t border-slate-100 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
              {state.audit.map((entry) => (
                <li key={entry.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {tx(`wizard.bankFile.event.${entry.event}`, entry.event)}
                    {' · '}
                    {String(entry.changes.fileNumber ?? '')}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">
                    {entry.actorName ?? '—'} · {dateTime(entry.at)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
      <div className="text-[11px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
        {label}
      </div>
      <div className="font-medium text-slate-800 tabular-nums dark:text-slate-100">{children}</div>
    </div>
  )
}
