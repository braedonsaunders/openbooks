'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowRight, FileDown } from 'lucide-react'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  FieldLabel,
  Input,
  Select,
  Skeleton,
  cn,
} from '@openbooks/ui'
import type { YearEndFilingSection } from '@openbooks/engine/src/payroll-yearend.ts'
import type { PayrollFilingSlipData } from '@openbooks/engine/src/payroll-filing-registry.ts'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { useMoney } from '../../../../components/money-provider'
import { payrollSlipFacsimile } from '../../../../lib/payroll-slip-facsimile'
import { renderTaxFormFacsimileBody } from '../../../../lib/tax-form-facsimile-html'
import {
  FilingCorrectionSection,
  FilingLifecycleBar,
  FilingStatusBadge,
  useFilingLifecycle,
  type FilingLifecycle,
  type FilingRowReview,
} from './filing-amendments'

export type FilingRow = Record<string, string | number | null>

export const sectionKey = (section: YearEndFilingSection) => `${section.country}:${section.key}`

/** Per-row issue-declaration key, so two issue filings never share state. */
const issueKey = (section: YearEndFilingSection, row: FilingRow) =>
  `${section.country}:${section.key}:${String(row[section.data.rowKey] ?? '')}`

const fileHref = (section: YearEndFilingSection, year: number) =>
  `/api/payroll/year-end/file?country=${encodeURIComponent(section.country)}`
  + `&filing=${encodeURIComponent(section.key)}&year=${year}`

/**
 * The shared filing machinery every filing surface composes — the year-end
 * page, the Separations surface and the termination run's Finish step all
 * render the SAME registry-declared sections, the same population table, the
 * same issue-declaration state (the ROE's reason for issue), the same
 * electronic-file download, and the same slip drawer through the shared
 * form-faithful facsimile pathway. One composition, three homes.
 */
export function useFilingIssues(year: number) {
  // Issue declarations (the ROE's reason for issue) are the employer's own
  // statement: nothing is preselected, and a row without one stays out of
  // the file.
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [comments, setComments] = useState<Record<string, string>>({})
  const [downloadError, setDownloadError] = useState<Record<string, string>>({})
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null)

  const issueSelection = (section: YearEndFilingSection): string => {
    if (!section.issue) return ''
    const idColumn = section.issue.idColumn
    return section.data.rows
      .filter((row) => reasons[issueKey(section, row)])
      .map((row) => [
        String(row[idColumn] ?? ''),
        reasons[issueKey(section, row)],
        encodeURIComponent(comments[issueKey(section, row)] ?? ''),
      ].join(':'))
      .join(',')
  }

  const issueSelectionCount = (section: YearEndFilingSection): number => {
    if (!section.issue) return 0
    return section.data.rows.filter((row) => reasons[issueKey(section, row)]).length
  }

  /** Fetch-based download so a refusal (422) lands as a callout, not a JSON tab. */
  async function downloadFile(section: YearEndFilingSection) {
    const key = sectionKey(section)
    const selection = issueSelection(section)
    const selectedCount = issueSelectionCount(section)
    setDownloadError((prev) => ({ ...prev, [key]: '' }))
    if (section.issue && selectedCount > section.issue.maxSelection) {
      setDownloadError((prev) => ({
        ...prev,
        [key]: `Select no more than ${section.issue!.maxSelection} employees for this filing`,
      }))
      return
    }
    setDownloadBusy(key)
    try {
      const res = section.issue
        ? await fetch('/api/payroll/year-end/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              country: section.country,
              filing: section.key,
              year,
              [section.issue.param]: selection,
            }),
          })
        : await fetch(fileHref(section, year))
      if (!res.ok) {
        let message = res.statusText
        try {
          message = ((await res.json()) as { error?: string }).error ?? message
        } catch {
          /* non-JSON body — keep the status text */
        }
        throw new Error(message)
      }
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${section.key}-${year}`
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      setDownloadError((prev) => ({ ...prev, [key]: (e as Error).message }))
    } finally {
      setDownloadBusy(null)
    }
  }

  return {
    reasons,
    comments,
    issueKey,
    issueSelection,
    downloadBusy,
    downloadError,
    downloadFile,
    setReason: (section: YearEndFilingSection, row: FilingRow, value: string) =>
      setReasons((prev) => ({ ...prev, [issueKey(section, row)]: value })),
    setComment: (section: YearEndFilingSection, row: FilingRow, value: string) =>
      setComments((prev) => ({ ...prev, [issueKey(section, row)]: value })),
  }
}

export type FilingIssues = ReturnType<typeof useFilingIssues>

/** One named group of sections on a filing surface (Annual, Quarterly, …). */
export interface FilingGroup {
  key: string
  label?: string
  /** Group-level field help, rendered in the house `?` popover. */
  help?: React.ReactNode
  sections: YearEndFilingSection[]
}

/**
 * A whole filing surface: tax-year picker, one selectable card per declared
 * filing (grouped under headed sections when the surface splits cadences),
 * the selected filing's population table, and the slip drawer.
 */
export function FilingWorkspace({
  year,
  currentYear,
  path,
  groups,
  emptyTitle,
  amendments = false,
}: {
  year: number
  /** Organization business year — not the UTC calendar year. */
  currentYear: number
  /** The surface's own route, for the year picker ("/payroll/year-end"). */
  path: string
  groups: FilingGroup[]
  emptyTitle: string
  /**
   * Show the original → amended → cancelled lifecycle (filing history, per-row
   * delta, correction actions).
   *
   * Off by default and passed only by the year-end cockpit. Separation
   * documents were deliberately moved OFF the year-end surface and their
   * corrections belong to the agency's own separation workflow — the CA pack's
   * ROE declaration refuses an amendment here by name for exactly that reason.
   */
  amendments?: boolean
}) {
  const t = useTranslations('payroll.filings')
  const router = useRouter()
  const { money } = useMoney()
  const years = Array.from({ length: 6 }, (_, i) => currentYear - i)
  const sections = groups.flatMap((group) => group.sections)

  const defaultSection = sections.find((s) => s.data.rows.length > 0) ?? sections[0] ?? null
  const [selectedKey, setSelectedKey] = useState<string>(defaultSection ? sectionKey(defaultSection) : '')
  const selected = sections.find((s) => sectionKey(s) === selectedKey) ?? defaultSection

  const issues = useFilingIssues(year)
  const [openRow, setOpenRow] = useState<FilingRow | null>(null)
  // One lifecycle fetch per selected filing — the correction review is a
  // per-row recompute and is not worth doing for filings nobody is looking at.
  const lifecycle = useFilingLifecycle(selected ?? null, year, amendments)
  const [issueBusy, setIssueBusy] = useState(false)
  const [issueError, setIssueError] = useState<string | null>(null)

  async function recordOriginal(section: YearEndFilingSection, note: string) {
    setIssueError(null)
    setIssueBusy(true)
    try {
      const res = await fetch('/api/payroll/year-end/amendments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country: section.country, filing: section.key, year, revision: 'original', note,
        }),
      })
      const body = (await res.json()) as { error?: string; fileRefusal?: string | null }
      if (!res.ok) throw new Error(body.error ?? res.statusText)
      // A filing with no electronic file is legitimately recorded — but the
      // pack's reason there is none is surfaced, never swallowed.
      if (body.fileRefusal) setIssueError(body.fileRefusal)
      lifecycle.refresh()
    } catch (e) {
      setIssueError((e as Error).message)
    } finally {
      setIssueBusy(false)
    }
  }

  if (sections.length === 0) {
    return <EmptyState title={emptyTitle} />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div>
          <FieldLabel htmlFor="filing-tax-year" containerClassName="mb-1">
            {t('yearLabel')}
          </FieldLabel>
          <Select
            id="filing-tax-year"
            value={String(year)}
            onChange={(e) => router.push(`${path}?year=${e.target.value}` as never)}
            className="w-32"
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </Select>
        </div>
      </div>

      {/* The filing registry enumeration: one card per pack-declared filing,
          under the surface's headed cadence groups. */}
      {groups.filter((group) => group.sections.length > 0).map((group) => (
        <section key={group.key} className="space-y-2">
          {group.label && (
            <FieldLabel
              help={group.help}
              fieldName={group.label}
              className="text-sm font-semibold text-slate-800 dark:text-slate-100"
            >
              {group.label}
            </FieldLabel>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {group.sections.map((section) => {
              const key = sectionKey(section)
              const active = selected != null && sectionKey(selected) === key
              const headlineTotal = section.data.totals?.find((total) => total.money)
              return (
                <Card
                  key={key}
                  onClick={() => {
                    setOpenRow(null)
                    setSelectedKey(key)
                  }}
                  className={cn(
                    'p-4',
                    active && 'border-teal-500 ring-1 ring-teal-500 dark:border-teal-400 dark:ring-teal-400',
                  )}
                  aria-pressed={active}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {section.label}
                    </div>
                    <Badge variant="outline">{section.country}</Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>{t('rowCount', { count: section.data.rows.length })}</span>
                    {headlineTotal && section.data.rows.length > 0 && (
                      <span className="tabular-nums">
                        {headlineTotal.label}: <span className="font-medium text-slate-700 dark:text-slate-200">{money(headlineTotal.value)}</span>
                      </span>
                    )}
                    {!section.installed && <Badge variant="outline">{t('notInstalled')}</Badge>}
                  </div>
                </Card>
              )
            })}
          </div>
        </section>
      ))}

      {selected && (
        <FilingSection
          key={sectionKey(selected)}
          section={selected}
          year={year}
          issues={issues}
          onOpenRow={(row) => setOpenRow(row)}
          lifecycle={amendments ? lifecycle.state : null}
          reviewByRow={lifecycle.reviewByRow}
          lifecycleBusy={issueBusy}
          lifecycleError={issueError}
          onRecordOriginal={(note) => void recordOriginal(selected, note)}
        />
      )}

      {selected && openRow && (
        <SlipDrawer
          section={selected}
          row={openRow}
          year={year}
          issues={issues}
          lifecycle={
            amendments && lifecycle.state.status === 'ready' ? lifecycle.state.lifecycle : null
          }
          review={lifecycle.reviewByRow.get(String(openRow[selected.data.rowKey] ?? '')) ?? null}
          onIssued={() => lifecycle.refresh()}
          onClose={() => setOpenRow(null)}
        />
      )}
    </div>
  )
}

/** The selected filing: registry-declared columns/totals in the house table. */
export function FilingSection({
  section,
  year,
  issues,
  onOpenRow,
  lifecycle = null,
  reviewByRow,
  lifecycleBusy = false,
  lifecycleError = null,
  onRecordOriginal,
}: {
  section: YearEndFilingSection
  year: number
  issues: FilingIssues
  onOpenRow: (row: FilingRow) => void
  /** Null on surfaces that do not carry the amendment lifecycle. */
  lifecycle?: ReturnType<typeof useFilingLifecycle>['state'] | null
  reviewByRow?: Map<string, FilingRowReview>
  lifecycleBusy?: boolean
  lifecycleError?: string | null
  onRecordOriginal?: (note: string) => void
}) {
  const t = useTranslations('payroll.filings')
  const { money } = useMoney()
  const key = sectionKey(section)
  const downloadBusy = issues.downloadBusy === key
  const downloadError = issues.downloadError[key] ?? ''
  const issueSelection = issues.issueSelection(section)

  const cell = (row: FilingRow, columnKey: string): string => {
    const column = section.data.columns.find((c) => c.key === columnKey)
    const value = row[columnKey]
    if (value == null || value === '') return '—'
    return column?.money ? money(String(value)) : String(value)
  }

  const columns: PagedColumn<FilingRow>[] = section.data.columns.map((column) => ({
    key: column.key,
    header: column.label,
    align: column.align === 'right' ? 'right' : undefined,
    search: column.key === section.data.columns[0]?.key
      ? (row: FilingRow) => String(row[column.key] ?? '')
      : undefined,
    cell: (row: FilingRow) => cell(row, column.key),
  }))
  // Where the lifecycle is on, each row carries its filing STATE beside its
  // figures — filed, changed since filing, cancelled — so an operator sees at
  // a glance which slips need a correction without opening any of them.
  if (lifecycle) {
    columns.push({
      key: '__filingStatus',
      header: t.has('lifecycle.statusColumn' as never)
        ? t('lifecycle.statusColumn' as never)
        : 'Filing status',
      cell: (row: FilingRow) => {
        const review = reviewByRow?.get(String(row[section.data.rowKey] ?? ''))
        if (!review) return <span className="text-slate-400">—</span>
        return <FilingStatusBadge status={review.status} />
      },
    })
  }
  // Issue filings (the ROE) show the declared reason beside the declared
  // columns — the declaration itself is made in the employee's drawer.
  if (section.issue) {
    columns.push({
      key: '__reason',
      header: t('issue.reason'),
      cell: (row: FilingRow) => {
        const code = issues.reasons[issues.issueKey(section, row)]
        if (!code) return <span className="text-slate-400">{t('issue.notIncluded')}</span>
        const label = section.issue!.reasonCodes.find((reason) => reason.code === code)?.label
        return <Badge variant="outline">{code}{label ? ` · ${label}` : ''}</Badge>
      },
    })
  }

  // Contextual help — the pack's declared description and transmission note —
  // lives in the house `?` field-help popover, never as loose page prose.
  const help = (section.description || section.download?.note) ? (
    <>
      {section.description && <p>{section.description}</p>}
      {section.download?.note && <p className={section.description ? 'mt-2' : undefined}>{section.download.note}</p>}
    </>
  ) : undefined

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <FieldLabel
          help={help}
          fieldName={section.label}
          className="text-base font-semibold text-slate-900 dark:text-slate-100"
        >
          {section.label}
        </FieldLabel>
        {section.download && section.data.rows.length > 0 && (
          <Button
            variant="outline"
            disabled={downloadBusy || (section.issue != null && issueSelection.length === 0)}
            onClick={() => void issues.downloadFile(section)}
          >
            <FileDown size={14} aria-hidden />
            {section.download.label}
          </Button>
        )}
      </div>

      {downloadError && (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{downloadError}</AlertDescription>
        </Alert>
      )}

      {lifecycle && lifecycle.status === 'error' && (
        <Alert variant="warning" className="mb-3">
          <AlertDescription>{lifecycle.message}</AlertDescription>
        </Alert>
      )}
      {lifecycle && lifecycle.status === 'ready' && onRecordOriginal && (
        <FilingLifecycleBar
          section={section}
          year={year}
          lifecycle={lifecycle.lifecycle}
          busy={lifecycleBusy}
          error={lifecycleError}
          onRecordOriginal={onRecordOriginal}
        />
      )}

      {section.populationRefusal ? (
        <Alert variant="warning">
          <AlertDescription>{section.populationRefusal}</AlertDescription>
        </Alert>
      ) : (
        <>
          {section.downloadRefusal && section.data.rows.length > 0 && (
            <Alert variant="info" className="mb-3">
              <AlertDescription>{section.downloadRefusal}</AlertDescription>
            </Alert>
          )}

          <PagedTable
            rows={section.data.rows}
            columns={columns}
            pageSize={25}
            searchable
            empty={<EmptyState title={section.emptyText ?? t('emptyDefault')} />}
            rowKey={(row) => String(row[section.data.rowKey] ?? '')}
            onRowClick={section.hasSlip ? onOpenRow : undefined}
          />

          {section.data.totals && section.data.rows.length > 0 && (
            <div className="mt-3 grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-950/40">
              {section.data.totals.map((total) => (
                <div key={total.label}>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{total.label}</div>
                  <div className="font-semibold tabular-nums">
                    {total.money ? money(total.value) : total.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

type SlipState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; slip: PayrollFilingSlipData; orgName: string }

/**
 * One population row's statutory slip in the house flyout: header facts, the
 * form-faithful facsimile (every box with its number, label and amount), the
 * filing's issue declaration where it applies (the ROE's Block 16 reason),
 * and the download action in the footer.
 */
export function SlipDrawer({
  section,
  row,
  year,
  issues,
  lifecycle = null,
  review = null,
  onIssued,
  onClose,
}: {
  section: YearEndFilingSection
  row: FilingRow
  year: number
  issues: FilingIssues
  /** Present only where the surface carries the amendment lifecycle. */
  lifecycle?: FilingLifecycle | null
  review?: FilingRowReview | null
  onIssued?: () => void
  onClose: () => void
}) {
  const t = useTranslations('payroll.filings')
  const tCommon = useTranslations('common')
  const rowId = String(row[section.data.rowKey] ?? '')
  const reason = issues.reasons[issues.issueKey(section, row)] ?? ''
  const comment = issues.comments[issues.issueKey(section, row)] ?? ''
  const slipHref = (format: 'json' | 'pdf') =>
    `/api/payroll/year-end/slip?country=${encodeURIComponent(section.country)}`
    + `&filing=${encodeURIComponent(section.key)}&year=${year}&row=${encodeURIComponent(rowId)}`
    + (format === 'pdf' ? '&format=pdf' : '')

  const [state, setState] = useState<SlipState>({ status: 'loading' })
  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    void fetch(slipHref('json'))
      .then(async (res) => {
        const body = (await res.json()) as { slip?: PayrollFilingSlipData; orgName?: string; error?: string }
        if (!alive) return
        if (!res.ok || !body.slip) {
          setState({ status: 'error', message: body.error ?? res.statusText })
          return
        }
        setState({ status: 'ready', slip: body.slip, orgName: body.orgName ?? '' })
      })
      .catch((e: Error) => {
        if (alive) setState({ status: 'error', message: e.message })
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.country, section.key, year, rowId])

  // The facsimile body is the shared pure renderer — identical markup to the
  // PDF the footer button downloads.
  const facsimileHtml = useMemo(() => {
    if (state.status !== 'ready') return ''
    const { result, layout } = payrollSlipFacsimile(state.slip, year)
    return renderTaxFormFacsimileBody(result, { orgName: state.orgName }, layout)
  }, [state, year])

  const title = String(row[section.data.columns[0]?.key ?? section.data.rowKey] ?? '')
  const commentRequired = section.issue?.reasonCodes.find((r) => r.code === reason)?.commentRequired === true

  return (
    <Drawer
      open
      onClose={onClose}
      size="xl"
      title={title}
      description={t('slip.description', { label: section.label, year })}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button variant="outline" asChild={state.status === 'ready'} disabled={state.status !== 'ready'}>
            {state.status === 'ready' ? (
              <a href={slipHref('pdf')} target="_blank" rel="noreferrer">
                <FileDown size={14} aria-hidden />
                {t('slip.downloadPdf')}
              </a>
            ) : (
              <span>{t('slip.downloadPdf')}</span>
            )}
          </Button>
          <Button variant="ghost" onClick={onClose}>{tCommon('actions.close')}</Button>
        </div>
      }
    >
      <div className="space-y-5">
        {state.status === 'loading' && (
          <div className="space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {state.status === 'error' && (
          <Alert variant="warning">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        {state.status === 'ready' && (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              {state.slip.headerFields.map((field) => (
                <div key={field.label}>
                  <dt className="text-[11px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
                    {field.label}
                  </dt>
                  <dd className="font-medium text-slate-800 tabular-nums dark:text-slate-100">
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>

            {/* The lifecycle: what this slip reported when it was filed, what
                the ledger says now, and the two corrections the pack allows.
                Above the facsimile, because a slip that has already gone to the
                agency is read very differently from one that has not. */}
            {lifecycle && review && (
              <FilingCorrectionSection
                section={section}
                year={year}
                review={review}
                lifecycle={lifecycle}
                onIssued={() => onIssued?.()}
              />
            )}

            {section.issue && (
              <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <FieldLabel
                      htmlFor="slip-issue-reason"
                      containerClassName="mb-1"
                      help={t('issue.reasonHelp')}
                    >
                      {t('issue.reason')}
                    </FieldLabel>
                    <Select
                      id="slip-issue-reason"
                      value={reason}
                      onChange={(e) => issues.setReason(section, row, e.target.value)}
                    >
                      <option value="">{t('issue.notIncluded')}</option>
                      {section.issue.reasonCodes.map((code) => (
                        <option key={code.code} value={code.code}>
                          {code.code} · {code.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <FieldLabel htmlFor="slip-issue-comment" containerClassName="mb-1">
                      {t('issue.comment')}
                    </FieldLabel>
                    <Input
                      id="slip-issue-comment"
                      value={comment}
                      onChange={(e) => issues.setComment(section, row, e.target.value)}
                      maxLength={section.issue.commentMaxLength}
                    />
                  </div>
                </div>
                {reason !== '' && (
                  <p className="text-xs text-teal-700 dark:text-teal-300">
                    {t('issue.included', { code: reason })}
                  </p>
                )}
                {commentRequired && comment.trim() === '' && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {t('issue.commentRequired')}
                  </p>
                )}
              </div>
            )}

            <div
              className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700"
              // Our own pure facsimile renderer with escaping — the same body
              // the Chromium PDF prints.
              dangerouslySetInnerHTML={{ __html: facsimileHtml }}
            />
          </>
        )}
      </div>
    </Drawer>
  )
}

/**
 * The termination run's separation-filing panel (Finish step): when the pack
 * declares a separation filing for the run's employees, each one gets an
 * issue card opening the SAME drawer + facsimile + reason flow the
 * Separations surface uses, and the section's electronic file is one click
 * away. Sections arrive already filtered to the run's own employees.
 */
export function SeparationIssuePanel({
  sections,
  year,
}: {
  sections: YearEndFilingSection[]
  year: number
}) {
  const t = useTranslations('payroll.separations')
  const tFilings = useTranslations('payroll.filings')
  const issues = useFilingIssues(year)
  const [open, setOpen] = useState<{ section: YearEndFilingSection; row: FilingRow } | null>(null)

  if (sections.length === 0) return null

  return (
    <div className="space-y-4">
      {sections.map((section) => {
        const key = sectionKey(section)
        const downloadError = issues.downloadError[key] ?? ''
        const issueSelection = issues.issueSelection(section)
        const help = (
          <>
            <p>{t('run.help')}</p>
            {section.description && <p className="mt-2">{section.description}</p>}
            {section.download?.note && <p className="mt-2">{section.download.note}</p>}
          </>
        )
        return (
          <div
            key={key}
            className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <FieldLabel
                help={help}
                fieldName={section.label}
                className="text-sm font-semibold text-slate-900 dark:text-slate-100"
              >
                {t('run.title', { label: section.label })}
              </FieldLabel>
              <div className="flex items-center gap-2">
                {section.download && section.data.rows.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={issues.downloadBusy === key || (section.issue != null && issueSelection.length === 0)}
                    onClick={() => void issues.downloadFile(section)}
                  >
                    <FileDown size={14} aria-hidden />
                    {section.download.label}
                  </Button>
                )}
                <Button asChild size="sm" variant="ghost">
                  <Link href={'/payroll/separations' as never}>
                    {t('run.viewAll')}
                    <ArrowRight size={13} aria-hidden />
                  </Link>
                </Button>
              </div>
            </div>

            {downloadError && (
              <Alert variant="destructive" className="mb-3">
                <AlertDescription>{downloadError}</AlertDescription>
              </Alert>
            )}

            {section.populationRefusal ? (
              <Alert variant="warning">
                <AlertDescription>{section.populationRefusal}</AlertDescription>
              </Alert>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {section.data.rows.map((row) => {
                  const rowId = String(row[section.data.rowKey] ?? '')
                  const name = String(row[section.data.columns[0]?.key ?? section.data.rowKey] ?? '')
                  const code = issues.reasons[issues.issueKey(section, row)]
                  const codeLabel = code
                    ? section.issue?.reasonCodes.find((reason) => reason.code === code)?.label
                    : undefined
                  return (
                    <Card key={rowId} className="p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {name}
                          </div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            {code ? (
                              <Badge variant="outline">{code}{codeLabel ? ` · ${codeLabel}` : ''}</Badge>
                            ) : (
                              tFilings('issue.notIncluded')
                            )}
                          </div>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => setOpen({ section, row })}>
                          {t('run.issue')}
                        </Button>
                      </div>
                    </Card>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {open && (
        <SlipDrawer
          section={open.section}
          row={open.row}
          year={year}
          issues={issues}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}
