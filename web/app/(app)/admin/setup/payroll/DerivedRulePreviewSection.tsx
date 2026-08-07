import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { Alert, Badge } from '@openbooks/ui'
import { db } from '@openbooks/engine/src/db.ts'
import {
  previewDerivedRule,
  type DerivedRulePreview,
} from '@openbooks/engine/src/payroll-derived-earnings.ts'
import { DateRangeFilter } from '../../../../../components/date-range-filter'
import { ListFilterSelect } from '../../../../../components/list-filter-select'
import { pickString } from '../../../../../lib/list-params'
import { DerivedRulePreviewTable } from './DerivedRulePreviewTable'

/**
 * Pre-enable preview for a derived earnings rule: pick a rule and a period and
 * see the exact employees, days, jobs and amounts it would pay — plus the
 * people its exclusion list keeps out. Nobody should switch on a rule that
 * moves money without looking at this first.
 *
 * It is the same calculation the pay run performs, read at fact resolution
 * (engine/src/payroll-derived-earnings.ts), never a second implementation.
 */

const BASE_PATH = '/admin/setup/payroll'

export async function DerivedRulePreviewSection({
  orgId,
  searchParams: sp,
}: {
  orgId: string
  searchParams: Record<string, string | string[] | undefined>
}) {
  const t = await getTranslations('payroll.settingsPage')
  const label = (key: string, fallback: string) => (t.has(key as never) ? t(key as never) : fallback)

  const [rulesRes, lastRunRes] = (await Promise.all([
    db.execute(sql`
      select id, code, name, is_active from pay_derived_rules
       where org_id = ${orgId} order by sequence, code`),
    db.execute(sql`
      select period_start, period_end from pay_runs
       where org_id = ${orgId} order by period_end desc limit 1`),
  ])) as unknown as [
    { rows: { id: string; code: string; name: string; is_active: boolean }[] },
    { rows: { period_start: string; period_end: string }[] },
  ]
  const rules = rulesRes.rows

  // Default to the period the last run covered — the operator is almost always
  // asking "what would this have paid last time?".
  const lastRun = lastRunRes.rows[0]
  const today = new Date().toISOString().slice(0, 10)
  const defaultFrom = lastRun ? String(lastRun.period_start).slice(0, 10) : `${today.slice(0, 7)}-01`
  const defaultTo = lastRun ? String(lastRun.period_end).slice(0, 10) : today

  const ruleId = pickString(sp.rule)
  const from = pickString(sp.from) ?? defaultFrom
  const to = pickString(sp.to) ?? defaultTo

  let preview: DerivedRulePreview | null = null
  let failure: string | null = null
  if (ruleId && rules.some((rule) => rule.id === ruleId)) {
    try {
      preview = await previewDerivedRule(orgId, ruleId, from, to)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {label('derivedPreview.title', 'Preview a derived earnings rule')}
        </h2>
        <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          {label(
            'derivedPreview.description',
            'See which employees and days a rule would hit, and what it would pay, before you enable it.',
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ListFilterSelect
          basePath={BASE_PATH}
          currentParams={sp}
          paramKey="rule"
          label={label('derivedPreview.rule', 'Rule')}
          allLabel={label('derivedPreview.selectRule', 'Select a rule…')}
          options={rules.map((rule) => ({ value: rule.id, label: `${rule.code} · ${rule.name}` }))}
        />
        <DateRangeFilter
          fromLabel={label('derivedPreview.from', 'Period start')}
          toLabel={label('derivedPreview.to', 'Period end')}
          defaultFrom={defaultFrom}
          defaultTo={defaultTo}
          clearable={false}
        />
      </div>

      {rules.length === 0 ? (
        <Alert>{label('derivedPreview.noRules', 'No derived earnings rules are configured yet.')}</Alert>
      ) : null}
      {failure ? <Alert variant="destructive">{failure}</Alert> : null}
      {!preview && rules.length > 0 && !failure ? (
        <Alert>{label('derivedPreview.pickRule', 'Choose a rule to preview the period.')}</Alert>
      ) : null}

      {preview ? <PreviewBody preview={preview} label={label} /> : null}
    </div>
  )
}

function PreviewBody({
  preview,
  label,
}: {
  preview: DerivedRulePreview
  label: (key: string, fallback: string) => string
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
        <Badge variant={preview.rule.isActive ? 'success' : 'outline'}>
          {preview.rule.isActive
            ? label('derivedPreview.enabled', 'Enabled')
            : label('derivedPreview.disabled', 'Not enabled yet')}
        </Badge>
        <span>{preview.rule.componentName}</span>
        <span aria-hidden>·</span>
        <span>
          {preview.periodStart} – {preview.periodEnd}
        </span>
        <span aria-hidden>·</span>
        <span>
          {label('derivedPreview.employeesPaid', 'Employees paid')}: {preview.employeeCount}
        </span>
      </div>

      {preview.grossIsEstimated ? (
        <Alert variant="warning">
          {label(
            'derivedPreview.grossEstimated',
            'This rule pays a percentage of gross. The preview estimates gross from approved time and the effective wage; the pay run’s own calculation is authoritative.',
          )}
        </Alert>
      ) : null}
      {preview.errors.map((error) => (
        <Alert key={error} variant="warning">
          {error}
        </Alert>
      ))}

      <DerivedRulePreviewTable
        rows={preview.rows}
        total={preview.total}
        labels={{
          employee: label('derivedPreview.employee', 'Employee'),
          jobTitle: label('derivedPreview.jobTitle', 'Job title'),
          day: label('derivedPreview.day', 'Day'),
          project: label('derivedPreview.project', 'Job'),
          quantity: label('derivedPreview.quantity', 'Units'),
          amount: label('derivedPreview.amount', 'Amount'),
          total: label('derivedPreview.total', 'Total'),
          empty: label('derivedPreview.empty', 'This rule pays nothing over the selected period.'),
        }}
      />

      {preview.excluded.length > 0 ? (
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {label('derivedPreview.excludedTitle', 'Excluded by job title')}
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {label(
              'derivedPreview.excludedDescription',
              'These employees are kept out by the rule’s exclusion list — the deletion nobody has to remember any more.',
            )}
          </p>
          <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
            {preview.excluded.map((person) => (
              <li key={person.employeePartyId}>
                {person.employeeName}
                {person.jobTitle ? ` — ${person.jobTitle}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
