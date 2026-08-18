'use client'

import { useTranslations } from 'next-intl'
import type { YearEndFilingSection } from '@openbooks/engine/src/payroll-yearend.ts'
import { FilingWorkspace } from '../_ui/filing-workspace'

/**
 * Year-end cockpit body: the shared filing workspace (registry-declared
 * cards, population table, slip drawer) with the surface's own split — the
 * pack-declared cadence groups. Annual returns and quarterly returns render
 * under their own headed sections so a Form 941's quarterly rhythm is
 * visible; separation documents (the ROE, a P45) are NOT year-end filings
 * and live on /payroll/separations instead.
 */
export function YearEndView({
  year,
  sections,
}: {
  year: number
  sections: YearEndFilingSection[]
}) {
  const t = useTranslations('payroll.yearEnd')
  return (
    <FilingWorkspace
      year={year}
      path="/payroll/year-end"
      emptyTitle={t('noFilings')}
      // The original → amended → cancelled lifecycle belongs to year-end
      // returns only. Separation documents live on /payroll/separations and
      // their corrections are the agency's own separation workflow.
      amendments
      groups={[
        {
          key: 'annual',
          label: t('cadence.annual'),
          help: t('cadence.annualHelp'),
          sections: sections.filter((section) => section.cadence === 'annual'),
        },
        {
          key: 'quarterly',
          label: t('cadence.quarterly'),
          help: t('cadence.quarterlyHelp'),
          sections: sections.filter((section) => section.cadence === 'quarterly'),
        },
      ]}
    />
  )
}
