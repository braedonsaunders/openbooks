import 'server-only'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/platform/database'
import { listEnrollmentPlanOptions, type EnrollmentSummary } from '@openbooks/engine/hrm/benefits'
import type { Authz } from '../authz'
import type { EnrollmentDrawerRecord } from '../../app/(app)/hrm/benefits/EnrollmentDrawer'
import { notFound } from 'next/navigation'

/** The caller supplies a scoped enrollment from the native Benefits reader. */
export async function loadBenefitEnrollmentRecord(authz: Authz, selected: EnrollmentSummary) {
  const t = await getTranslations('hrm')
    const [options, context, terms] = await Promise.all([
      listEnrollmentPlanOptions(db, authz.user.orgId, authz.user.id),
      db.execute<{ plan_id: string; match_eligible: boolean | null; flow_run_id: string | null }>(sql`select plan_id,match_eligible,flow_run_id from hrm_benefit_enrollments where org_id=${authz.user.orgId} and id=${selected.id}`),
      db.execute<EnrollmentDrawerRecord['terms'][number] & { name: string; basis: string; rate: string; rateFormula: string; requiresMatchEligibility: boolean; effectiveFrom: string; effectiveTo: string | null }>(sql`
        select r.id as "ruleId",r.name,r.basis,r.rate::text as rate,r.rate_formula as "rateFormula",r.requires_match_eligibility as "requiresMatchEligibility",
          r.effective_from::text as "effectiveFrom",r.effective_to::text as "effectiveTo",
          term.election_mode as "electionMode",term.elected_rate::text as "electedRate",term.declared_periods_per_year as "declaredPeriodsPerYear"
        from hrm_benefit_enrollment_terms term join hrm_benefit_contribution_rules r on r.org_id=term.org_id and r.id=term.rule_id
        where term.org_id=${authz.user.orgId} and term.enrollment_id=${selected.id} order by r.position,r.id`),
    ])
    const current = context.rows[0]
    if (!current) notFound()
    const plan = options.find(option => option.value === current.plan_id)
    const canChange = plan !== undefined
    const rules = [...(plan?.contributionRules ?? [])]
    for (const term of terms.rows) if (!rules.some(rule => rule.value === term.ruleId)) rules.push({ value: term.ruleId, label: term.name, basis: term.basis, rate: term.rate, rateFormula: term.rateFormula, requiresMatchEligibility: term.requiresMatchEligibility, effectiveFrom: term.effectiveFrom, effectiveTo: term.effectiveTo })
    const record: EnrollmentDrawerRecord = {
      ...selected, employeeName: selected.employeeName ?? selected.employmentId,
      statusLabel: t(`benefits.statusNames.${selected.status}`), matchEligible: current.match_eligible,
      classes: plan?.classes ?? (selected.classKey ? [{ value: selected.classKey, label: selected.coverageLabel ?? selected.classKey }] : []),
      rules, terms: terms.rows.map(({ ruleId, electionMode, electedRate, declaredPeriodsPerYear }) => ({ ruleId, electionMode, electedRate, declaredPeriodsPerYear })),
      approvalHref: current.flow_run_id ? '/inbox' : null,
    }
    return { record, canChange }
}
