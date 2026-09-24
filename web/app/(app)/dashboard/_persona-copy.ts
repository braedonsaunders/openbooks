import { formatCivilDate } from '@/lib/format'

/**
 * Pure server-side copy for the persona surface (F4T2-7). The celebrations
 * and team nudges used to build English strings by concatenation
 * (`2 years`, `1 step(s)`); every branch now renders through the
 * `dashboard.persona` catalog with ICU plurals and locale dates, so the
 * translator type below is the only string source. Kept beside the loader
 * (like `_persona-layout`) and free of `server-only` so the branch-to-key
 * mapping is unit-testable without a database.
 */
export type PersonaTranslator = (key: string, params?: Record<string, string | number>) => string

/**
 * One celebration row's detail line: a future start joins on a locale date,
 * a past start with full years uses the ICU plural, otherwise the locale
 * "since" date. Comparisons stay on the civil ISO strings, exactly as the
 * loader fed them.
 */
export function celebrationDetail(
  serviceStart: string,
  today: string,
  locale: string,
  tp: PersonaTranslator,
): string {
  const years = Number(today.slice(0, 4)) - Number(serviceStart.slice(0, 4))
  const startLabel = formatCivilDate(serviceStart, locale)
  if (serviceStart > today) return tp('joinsOn', { date: startLabel })
  if (years > 0) return tp('serviceYears', { years })
  return tp('joinedSince', { date: startLabel })
}

/** Manager nudges: counts ride inside ICU plurals, never string concat. */
export function teamNudgeTexts(
  overdue: number,
  joiners: number,
  tp: PersonaTranslator,
): { text: string; href: string }[] {
  const nudges: { text: string; href: string }[] = []
  if (overdue > 0) nudges.push({ text: tp('overdueSteps', { overdue }), href: '/hrm/processes' })
  if (joiners > 0) nudges.push({ text: tp('newJoiners', { joiners }), href: '/hrm' })
  return nudges
}
