import type { useTranslations } from 'next-intl'

export type WizardT = ReturnType<typeof useTranslations<'admin.setup.wizard'>>

/**
 * Preselect only what is derived: a sole installable pack. Otherwise nothing —
 * the wizard must not silently become any one country, and the operator
 * chooses (or leaves payroll pack-less to install later from Payroll setup).
 */
export function initialPayrollPack(packs: readonly string[]): string | null {
  return packs.length === 1 ? (packs[0] ?? null) : null
}

/**
 * Display strings for a pack: the locale wins where a key exists for the
 * pack's lowercase code (`payroll.packs.canada.title`), otherwise the code
 * reads as written — legible on day one, localizable later, no edit at the
 * call sites.
 */
export function packTitle(t: WizardT, code: string): string {
  const key = `payroll.packs.${code.toLowerCase()}.title`
  return t.has(key as never) ? t(key as never) : code
}

export function packDescription(t: WizardT, code: string): string {
  const key = `payroll.packs.${code.toLowerCase()}.description`
  return t.has(key as never) ? t(key as never) : ''
}
