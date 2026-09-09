/**
 * Tone → class mapping.
 *
 * These strings are transcribed from the native pages rather than invented,
 * because the conformance harness compares rendered markup byte for byte: a
 * "close enough" ramp would show up as a diff on every converted page. When a
 * native page is converted, its inline conditional class becomes a named tone
 * here and the loader decides which tone applies — the spec never compares
 * values to pick a colour.
 */

import type { Tone } from '@openbooks/viewspec'

export const TONE_CLASS: Record<Tone, string> = {
  default: '',
  negative: 'text-red-600 dark:text-red-400',
  warning: 'text-amber-600 dark:text-amber-400',
  positive: 'text-emerald-600 dark:text-emerald-400',
  muted: 'text-slate-500 dark:text-slate-400',
  strong: 'font-semibold text-slate-700 dark:text-slate-200',
}

/** The drill-link hover treatment shared by every report drill target. */
export const DRILL_LINK_CLASS = 'hover:text-teal-700 hover:underline dark:hover:text-teal-300'

/** The placeholder treatment for an absent value in a text cell. */
export const FALLBACK_CLASS = 'text-slate-400 italic'

export function toneClass(tone: Tone | undefined): string {
  return tone ? TONE_CLASS[tone] : ''
}
