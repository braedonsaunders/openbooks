import { getTranslations } from 'next-intl/server'
import { Alert, Badge } from '@openbooks/ui'
import {
  observedHolidays,
  statutoryHolidayPayRule,
  type ObservedHoliday,
} from '@openbooks/engine/src/payroll-holidays.ts'
import { declaredJurisdictions } from '@openbooks/engine/src/payroll/packs.ts'
import { ListFilterSelect } from '../../../../../components/list-filter-select'
import { pickString } from '../../../../../lib/list-params'

/**
 * The resolved statutory holiday calendar: the country pack's declared days and
 * the employer's own elections, merged and dated for a chosen year.
 *
 * Read-only on purpose. The elections are edited on the Holidays tab, and this
 * is where an operator confirms what an election actually DID — "we turned on
 * Boxing Day" is a claim, "December 26 2026, elected, paid" is the fact. It
 * calls the same `observedHolidays` the pay run and the remittance due dates
 * call, never a second derivation, so what is shown here is what will be paid.
 *
 * It also states the jurisdiction's holiday-pay rule in plain terms, including
 * the two answers that are NOT a formula: a jurisdiction that mandates no
 * holiday pay at all, and one whose rule has not been transcribed — which
 * refuses rather than pay zero.
 */

const BASE_PATH = '/admin/setup/payroll'

export async function HolidayCalendarSection({
  orgId,
  searchParams: sp,
}: {
  orgId: string
  searchParams: Record<string, string | string[] | undefined>
}) {
  const t = await getTranslations('payroll.settingsPage')
  const label = (key: string, fallback: string) => (t.has(key as never) ? t(key as never) : fallback)

  const jurisdictions = declaredJurisdictions()
  const jurisdiction = pickString(sp.jurisdiction)
    ?? jurisdictions.find((entry) => entry.key === 'CA-ON')?.key
    ?? jurisdictions[0]!.key
  const thisYear = new Date().getFullYear()
  const year = Number(pickString(sp.year) ?? thisYear)

  let holidays: ObservedHoliday[] = []
  let failure: string | null = null
  let payRule: ReturnType<typeof statutoryHolidayPayRule> | undefined
  try {
    holidays = await observedHolidays(orgId, jurisdiction, `${year}-01-01`, `${year}-12-31`)
    // Holiday-pay formulas are effective-dated (Prince Edward Island's changed
    // mid-2026), so the rule shown is the one in force at the END of the year
    // being viewed — the one that governs the next holiday, not a rule that has
    // already been repealed.
    payRule = statutoryHolidayPayRule(jurisdiction, `${year}-12-31`)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }

  const declaration = jurisdictions.find((entry) => entry.key === jurisdiction)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {label('holidayCalendar.title', 'Statutory holiday calendar')}
        </h2>
        <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          {label(
            'holidayCalendar.description',
            'The days this jurisdiction observes, with your own elections applied. Statutory days come from the country pack and cannot be switched off; optional and company days are configured on the Holidays tab.',
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ListFilterSelect
          basePath={BASE_PATH}
          currentParams={sp}
          paramKey="jurisdiction"
          label={label('holidayCalendar.jurisdiction', 'Jurisdiction')}
          allLabel={label('holidayCalendar.jurisdiction', 'Jurisdiction')}
          options={jurisdictions.map((entry) => ({ value: entry.key, label: entry.name }))}
        />
        <ListFilterSelect
          basePath={BASE_PATH}
          currentParams={sp}
          paramKey="year"
          label={label('holidayCalendar.year', 'Year')}
          allLabel={label('holidayCalendar.year', 'Year')}
          options={[-1, 0, 1, 2].map((offset) => ({
            value: String(thisYear + offset),
            label: String(thisYear + offset),
          }))}
        />
      </div>

      {declaration ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {label('holidayCalendar.citation', 'Source')}: {declaration.citation}
        </p>
      ) : null}

      {/* A jurisdiction nobody has transcribed refuses, by name. It is shown as
          an error rather than an empty calendar, because an empty calendar
          reads as "this employer works every day". */}
      {failure ? <Alert variant="destructive">{failure}</Alert> : null}

      {!failure && payRule === null ? (
        <Alert>
          {label(
            'holidayCalendar.noMandate',
            'This jurisdiction mandates no statutory holiday pay, so the calendar drives closures and working-day arithmetic only. Days off may still be paid under your own policy.',
          )}
        </Alert>
      ) : null}
      {!failure && payRule ? (
        <Alert variant="info">
          <div className="font-medium">
            {label('holidayCalendar.payRule', 'How a day’s holiday pay is computed')}
          </div>
          <div className="mt-1">{describeBasis(payRule, label)}</div>
          <div className="mt-1 text-xs">{payRule.citation}</div>
        </Alert>
      ) : null}

      {!failure ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">{label('holidayCalendar.date', 'Observed')}</th>
                <th className="px-3 py-2">{label('holidayCalendar.holiday', 'Holiday')}</th>
                <th className="px-3 py-2">{label('holidayCalendar.statutoryDate', 'Falls on')}</th>
                <th className="px-3 py-2">{label('holidayCalendar.source', 'Source')}</th>
                <th className="px-3 py-2">{label('holidayCalendar.paid', 'Paid')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {holidays.map((holiday) => (
                <tr key={`${holiday.key}-${holiday.date}`}>
                  <td className="px-3 py-2 tabular-nums">{holiday.date}</td>
                  <td className="px-3 py-2">{holiday.name}</td>
                  {/* Shown only when the observance rule MOVED the day — that
                      shift is the thing an operator most often disbelieves. */}
                  <td className="px-3 py-2 tabular-nums text-slate-500 dark:text-slate-400">
                    {holiday.statutoryDate === holiday.date ? '' : holiday.statutoryDate}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={holiday.source === 'pack' ? 'outline' : 'success'}>
                      {holiday.source === 'pack'
                        ? holiday.elected
                          ? label('holidayCalendar.elected', 'Optional — elected')
                          : label('holidayCalendar.statutory', 'Statutory')
                        : label('holidayCalendar.company', 'Company')}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {holiday.paid
                      ? label('holidayCalendar.yes', 'Yes')
                      : label('holidayCalendar.unpaid', 'Unpaid closure')}
                  </td>
                </tr>
              ))}
              {holidays.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-500 dark:text-slate-400">
                    {label('holidayCalendar.empty', 'No holidays are observed in this year.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

/** The formula, worded the way the statute words it. */
function describeBasis(
  rule: NonNullable<ReturnType<typeof statutoryHolidayPayRule>>,
  label: (key: string, fallback: string) => string,
): string {
  // A normal-day rule has TWO arms and an operator needs to see both: the day
  // it normally pays, and the fallback the same statute names for an employee
  // with no normal day. Describing only one would make the screen disagree with
  // half the pay runs it explains.
  if (rule.basis.kind === 'normal_day') {
    const standard = rule.basis.minWeeklyHours !== undefined
      ? label('holidayCalendar.normalDayStandardHours', 'for employees working at least '
        + `${rule.basis.minWeeklyHours} hours a week, `)
      : ''
    return `${standard}${label('holidayCalendar.normalDay', 'the wages of one normal working '
      + 'day, from the employee\u2019s recorded work schedule')}. `
      + `${label('holidayCalendar.normalDayOtherwise', 'Otherwise')}: `
      + describeBasis({ ...rule, basis: rule.basis.whenIrregular }, label)
  }
  const { basis } = rule
  // Where the window ENDS is a statutory difference of up to six days of
  // earnings, so the screen must not say "before the holiday" for a rule that
  // counts to the week before it.
  const before = rule.lookbackEnds.kind === 'week_before'
    ? label('holidayCalendar.beforeTheWeek', 'before the week of the holiday')
    : label('holidayCalendar.beforeTheDay', 'before the holiday')
  const included = [
    label('holidayCalendar.regularWages', 'regular wages'),
    rule.include.overtime ? label('holidayCalendar.overtime', 'overtime') : null,
    rule.include.vacationPay ? label('holidayCalendar.vacationPay', 'vacation pay') : null,
    rule.include.holidayPay ? label('holidayCalendar.priorHolidayPay', 'earlier holiday pay') : null,
  ].filter(Boolean).join(', ')

  if (basis.kind === 'fixed_divisor') {
    const main = `${included} over the ${basis.lookbackWeeks} weeks ${before}, ÷ ${basis.divisor}`
    return basis.commission
      ? `${main}. Commission earners with ${basis.commission.minWeeksEmployed}+ weeks of service: `
        + `${basis.commission.lookbackWeeks} weeks ÷ ${basis.commission.divisor}.`
      : `${main}.`
  }
  if (basis.kind === 'percent_of_earnings') {
    return `${basis.percent}% of ${included} over the ${basis.lookbackWeeks} weeks ${before}.`
  }
  const window = basis.lookbackDays !== undefined
    ? `${basis.lookbackDays} calendar days`
    : `${basis.lookbackWeeks ?? 4} weeks`
  // The denominator is the statute's own sentence, not "days worked" for
  // everyone: British Columbia divides by the days the employee worked OR
  // EARNED WAGES, which counts paid vacation and other paid holidays in.
  const counted = basis.counting === 'worked'
    ? label('holidayCalendar.daysWorked', 'days worked in it')
    : basis.counting === 'worked_or_earned_wages'
      ? label('holidayCalendar.daysWorkedOrEarned', 'days worked or on which wages were earned')
      : label('holidayCalendar.daysEntitledToPay',
        'days the employee was paid, or entitled to be paid, for')
  return `${included} over the ${window} ${before}, ÷ the number of ${counted}.`
}
